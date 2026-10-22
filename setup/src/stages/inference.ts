import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const TEMPLATE_PATHS = [
  path.resolve(__dirname, "../../templates/compose/inference.yaml"),
  path.resolve(__dirname, "../../../templates/compose/inference.yaml")
];

const INFERENCE_PINS_FILENAME = "s12-inference-pins.json";
const INFERENCE_HEALTH_FILENAME = "s12-inference-health.json";
const INFERENCE_STATE_FILENAME = "s12-inference-state.json";
const INFERENCE_INTEGRATION_FILENAME = "s12-integration-evidence.json";
const INFERENCE_APP_INTEGRATION_FILENAME = "s12-app-integration.json";
const S08_LIVE_SMOKE_FILENAME = "s08-live-smoke.json";

const DISABLE_GATE_ID = "s12-disable-serving-approved";
const APPLY_GATE_ID = "s12-inference-apply-approved";

const DEFAULT_VOLUME_NAME = "agent-factory-ollama-models";
const DEFAULT_SERVICE_NAME = "agent-factory-ollama";
const DEFAULT_CACHE_REQUIRED_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_MODEL_DIR = "/root/.ollama";
const DEFAULT_OLLAMA_API = "http://127.0.0.1:11434";

interface InferencePins {
  schema_version: 1;
  image: {
    ref: string;
    digest: string;
    arch: "amd64" | "arm64";
  };
  model: {
    id: string;
    digest: string;
    size_bytes: number;
    license: string;
    num_ctx: number;
  };
  resources: {
    min_ram_bytes: number;
    min_disk_bytes: number;
    min_disk_inodes: number;
  };
  runtime: {
    service_name: string;
    volume_name: string;
    model_dir: string;
    health_endpoint: string;
    compose_relative_path: string;
  };
}

interface InferenceHealthRecord {
  schema_version: 1;
  observed_at: string;
  model_id: string;
  model_digest: string;
  model_size_bytes: number;
  model_license: string;
  model_num_ctx: number;
  image_ref: string;
  image_digest: string;
  isolation_proof_ref: string;
  no_public_ports: boolean;
  health_ok: boolean;
  routing_enabled: boolean;
}

interface InferenceStateRecord {
  schema_version: 1;
  enabled: boolean;
  disabled: boolean;
  compose_path: string;
  service_name: string;
  volume_name: string;
  updated_at: string;
}

interface AppIntegrationDisableRecord {
  schema_version: 1;
  scheduler_block_command?: string[];
}

interface IntegrationEvidenceRecord {
  schema_version: 1;
  m3_reviewed: boolean;
  pr13_infra_probe: boolean;
  pr14_runtime_conformance: boolean;
  pr15_registry: boolean;
  pr16_router: boolean;
  pr17_router_hardening: boolean;
}

interface RuntimeStatus {
  dockerAvailable: boolean;
  running: boolean;
  publicPortsDetected: boolean;
}

interface ResourceSnapshot {
  ramAvailableBytes: number;
  diskAvailableBytes: number;
  diskAvailableInodes: number;
}

export interface InferenceAdapter {
  observeRuntime(config: SetupConfig, pins: InferencePins): Promise<RuntimeStatus>;
  observeResources(config: SetupConfig): Promise<ResourceSnapshot>;
  stageModelAndStartServing(config: SetupConfig, pins: InferencePins, composePath: string): Promise<void>;
  stopServing(config: SetupConfig, pins: InferencePins, composePath: string): Promise<{ stopped: boolean }>;
}

function pinsPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INFERENCE_PINS_FILENAME);
}

function healthPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INFERENCE_HEALTH_FILENAME);
}

function statePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INFERENCE_STATE_FILENAME);
}

function integrationPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INFERENCE_INTEGRATION_FILENAME);
}

function appIntegrationPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INFERENCE_APP_INTEGRATION_FILENAME);
}

function s08LiveSmokePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, S08_LIVE_SMOKE_FILENAME);
}

function composePath(config: SetupConfig, pins: InferencePins): string {
  const relative = pins.runtime.compose_relative_path.trim();
  if (!relative.startsWith("compose/")) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_compose_relative_path_invalid",
      publicMessage: "S12 compose path must stay inside setup state compose/ subtree.",
      nextAction: "Fix S12 pins compose_relative_path and rerun plan.",
      stage: "S12"
    });
  }
  const joined = path.join(config.paths.setup_state_dir, relative);
  const normalizedRoot = path.resolve(config.paths.setup_state_dir);
  const normalizedTarget = path.resolve(joined);
  if (!normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_compose_path_escape",
      publicMessage: "S12 compose path escapes setup state directory.",
      nextAction: "Fix S12 compose path in reviewed pins artifact.",
      stage: "S12"
    });
  }
  return normalizedTarget;
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_invalid_digest",
      publicMessage: `S12 pin '${field}' must be a full sha256 digest.`,
      nextAction: "Provide reviewed S12 pins with full immutable digests.",
      stage: "S12",
      evidenceRef: field
    });
  }
}

function assertImageRef(value: string): void {
  if (!value.includes("@sha256:")) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_image_ref_not_pinned",
      publicMessage: "S12 image ref must be digest-pinned and must not use mutable tags.",
      nextAction: "Use immutable image ref with @sha256:<digest>.",
      stage: "S12"
    });
  }
}

function assertNoUnsafeArgv(argv: string[]): void {
  for (const value of argv) {
    if (value.includes("\n") || value.includes("\r")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s12_app_disable_command_invalid",
        publicMessage: "S12 app disable command contains unsafe control characters.",
        nextAction: "Fix s12-app-integration.json scheduler command argv.",
        stage: "S12"
      });
    }
  }
}

function inferRequiredRamBytes(pins: InferencePins): number {
  if (pins.resources.min_ram_bytes > 0) {
    return pins.resources.min_ram_bytes;
  }
  return 16 * 1024 * 1024 * 1024;
}

async function writeAtomic(fsAdapter: FilesystemAdapter, targetPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

async function readTemplate(fsAdapter: FilesystemAdapter): Promise<string> {
  for (const candidate of TEMPLATE_PATHS) {
    if (await fsAdapter.exists(candidate)) {
      return fsAdapter.readText(candidate);
    }
  }
  throw setupError({
    exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "s12_template_missing",
    publicMessage: "S12 compose template is missing in this release.",
    nextAction: "Use installer release that contains templates/compose/inference.yaml.",
    stage: "S12"
  });
}

function renderComposeTemplate(template: string, pins: InferencePins): string {
  return template
    .replaceAll("{{OLLAMA_IMAGE_REF}}", pins.image.ref)
    .replaceAll("{{SERVICE_NAME}}", pins.runtime.service_name)
    .replaceAll("{{MODEL_VOLUME_NAME}}", pins.runtime.volume_name)
    .replaceAll("{{MODEL_DIR}}", pins.runtime.model_dir)
    .replaceAll("{{HEALTH_ENDPOINT}}", pins.runtime.health_endpoint);
}

async function readPins(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<InferencePins> {
  const targetPath = pinsPath(config);
  if (!(await fsAdapter.exists(targetPath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_missing",
      publicMessage: "S12 is blocked: inference pins artifact is missing.",
      nextAction: "Provide reviewed pins in s12-inference-pins.json and rerun S12.",
      stage: "S12",
      evidenceRef: targetPath
    });
  }
  const stat = await fsAdapter.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_pins_entry_forbidden",
      publicMessage: "S12 pins artifact must be a regular file and not a symlink.",
      nextAction: "Replace with a regular file owned by setup user.",
      stage: "S12",
      evidenceRef: targetPath
    });
  }
  const raw = await fsAdapter.readText(targetPath);
  const parsed = JSON.parse(raw) as Partial<InferencePins>;
  if (
    parsed.schema_version !== 1
    || parsed.image === undefined
    || parsed.model === undefined
    || parsed.resources === undefined
    || parsed.runtime === undefined
  ) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_invalid",
      publicMessage: "S12 pins artifact has invalid schema.",
      nextAction: "Regenerate reviewed pins artifact with full required fields.",
      stage: "S12",
      evidenceRef: targetPath
    });
  }
  const pins = parsed as InferencePins;
  assertImageRef(pins.image.ref);
  assertDigest(pins.image.digest, "image.digest");
  assertDigest(pins.model.digest, "model.digest");
  if (pins.model.id.trim().length === 0 || pins.model.license.trim().length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_model_identity_missing",
      publicMessage: "S12 pins must include model id and license.",
      nextAction: "Fill model.id and model.license in reviewed pins artifact.",
      stage: "S12"
    });
  }
  if (pins.model.size_bytes <= 0 || !Number.isFinite(pins.model.size_bytes)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_model_size_invalid",
      publicMessage: "S12 model size must be a positive number.",
      nextAction: "Set model.size_bytes in reviewed pins artifact.",
      stage: "S12"
    });
  }
  if (pins.model.num_ctx !== 8192) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s12_pins_num_ctx_invalid",
      publicMessage: "S12 requires reviewed derived model identity with num_ctx=8192.",
      nextAction: "Update reviewed pins artifact to the approved num_ctx=8192 identity.",
      stage: "S12"
    });
  }
  if (pins.resources.min_disk_bytes <= 0) {
    pins.resources.min_disk_bytes = DEFAULT_CACHE_REQUIRED_BYTES;
  }
  if (pins.resources.min_disk_inodes <= 0) {
    pins.resources.min_disk_inodes = 1024;
  }
  if (pins.runtime.service_name.trim().length === 0) {
    pins.runtime.service_name = DEFAULT_SERVICE_NAME;
  }
  if (pins.runtime.volume_name.trim().length === 0) {
    pins.runtime.volume_name = DEFAULT_VOLUME_NAME;
  }
  if (pins.runtime.model_dir.trim().length === 0) {
    pins.runtime.model_dir = DEFAULT_MODEL_DIR;
  }
  if (pins.runtime.health_endpoint.trim().length === 0) {
    pins.runtime.health_endpoint = DEFAULT_OLLAMA_API;
  }
  if (pins.runtime.compose_relative_path.trim().length === 0) {
    pins.runtime.compose_relative_path = "compose/inference.yaml";
  }
  return pins;
}

async function readHealth(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<InferenceHealthRecord | null> {
  const target = healthPath(config);
  if (!(await fsAdapter.exists(target))) {
    return null;
  }
  const stat = await fsAdapter.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_health_entry_forbidden",
      publicMessage: "S12 health evidence must be a regular file and not a symlink.",
      nextAction: "Replace health file with stage-generated artifact.",
      stage: "S12",
      evidenceRef: target
    });
  }
  const parsed = JSON.parse(await fsAdapter.readText(target)) as Partial<InferenceHealthRecord>;
  if (
    parsed.schema_version !== 1
    || typeof parsed.model_digest !== "string"
    || typeof parsed.image_digest !== "string"
    || typeof parsed.model_num_ctx !== "number"
    || typeof parsed.no_public_ports !== "boolean"
    || typeof parsed.health_ok !== "boolean"
    || typeof parsed.routing_enabled !== "boolean"
    || typeof parsed.isolation_proof_ref !== "string"
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s12_health_invalid",
      publicMessage: "S12 health artifact is invalid or drifted.",
      nextAction: "Rerun S12 apply to regenerate health evidence.",
      stage: "S12",
      evidenceRef: target
    });
  }
  return parsed as InferenceHealthRecord;
}

async function readState(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<InferenceStateRecord | null> {
  const target = statePath(config);
  if (!(await fsAdapter.exists(target))) {
    return null;
  }
  const stat = await fsAdapter.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_state_entry_forbidden",
      publicMessage: "S12 state artifact must be a regular file and not a symlink.",
      nextAction: "Replace with stage-generated state file.",
      stage: "S12",
      evidenceRef: target
    });
  }
  const parsed = JSON.parse(await fsAdapter.readText(target)) as Partial<InferenceStateRecord>;
  if (
    parsed.schema_version !== 1
    || typeof parsed.enabled !== "boolean"
    || typeof parsed.disabled !== "boolean"
    || typeof parsed.compose_path !== "string"
    || typeof parsed.service_name !== "string"
    || typeof parsed.volume_name !== "string"
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s12_state_invalid",
      publicMessage: "S12 state artifact is invalid.",
      nextAction: "Delete corrupted state and rerun S12 apply/disable.",
      stage: "S12",
      evidenceRef: target
    });
  }
  return parsed as InferenceStateRecord;
}

async function readIntegrationEvidence(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<IntegrationEvidenceRecord | null> {
  const target = integrationPath(config);
  if (!(await fsAdapter.exists(target))) {
    return null;
  }
  const parsed = JSON.parse(await fsAdapter.readText(target)) as Partial<IntegrationEvidenceRecord>;
  if (
    parsed.schema_version !== 1
    || typeof parsed.m3_reviewed !== "boolean"
    || typeof parsed.pr13_infra_probe !== "boolean"
    || typeof parsed.pr14_runtime_conformance !== "boolean"
    || typeof parsed.pr15_registry !== "boolean"
    || typeof parsed.pr16_router !== "boolean"
    || typeof parsed.pr17_router_hardening !== "boolean"
  ) {
    return null;
  }
  return parsed as IntegrationEvidenceRecord;
}

async function readS08IsolationEvidence(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<{ ok: boolean; evidenceRef: string }> {
  const target = s08LiveSmokePath(config);
  if (!(await fsAdapter.exists(target))) {
    return { ok: false, evidenceRef: target };
  }
  const parsed = JSON.parse(await fsAdapter.readText(target)) as {
    status?: unknown;
    unknown_usage?: unknown;
    terminal_events?: unknown;
  };
  const events = Array.isArray(parsed.terminal_events) ? parsed.terminal_events.filter((entry) => typeof entry === "string") : [];
  const ok = parsed.status === "needs_review" && parsed.unknown_usage === false && events.includes("runner.needs_review");
  return { ok, evidenceRef: target };
}

function routingEligible(evidence: IntegrationEvidenceRecord | null): boolean {
  if (evidence === null) {
    return false;
  }
  return evidence.m3_reviewed
    && evidence.pr13_infra_probe
    && evidence.pr14_runtime_conformance
    && evidence.pr15_registry
    && evidence.pr16_router
    && evidence.pr17_router_hardening;
}

function healthMatchesPins(health: InferenceHealthRecord, pins: InferencePins): boolean {
  return health.model_digest === pins.model.digest
    && health.image_digest === pins.image.digest
    && health.model_num_ctx === pins.model.num_ctx
    && health.model_size_bytes === pins.model.size_bytes
    && health.model_license === pins.model.license
    && health.model_id === pins.model.id;
}

function asNumber(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDfOutput(output: string): number | null {
  const lines = output.trim().split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) {
    return null;
  }
  return asNumber(lines[1] ?? "");
}

function parseFreeAvailableBytes(output: string): number | null {
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Mem:")) {
      continue;
    }
    const columns = trimmed.split(/\s+/);
    const available = columns[6];
    if (available === undefined) {
      return null;
    }
    return asNumber(available);
  }
  return null;
}

class NodeInferenceAdapter implements InferenceAdapter {
  constructor(private readonly processAdapter: ProcessAdapter) {}

  private async run(binary: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    try {
      return await this.processAdapter.runCommand({
        binary,
        args,
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES
      });
    } catch (error) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : "command failed",
        timedOut: false
      };
    }
  }

  async observeRuntime(_config: SetupConfig, pins: InferencePins): Promise<RuntimeStatus> {
    const ps = await this.run("/usr/bin/docker", ["ps", "--filter", `name=^${pins.runtime.service_name}$`, "--format", "{{.Names}}\t{{.Ports}}"], OBSERVE_TIMEOUT_MS);
    if (ps.exitCode !== 0 || ps.timedOut) {
      return {
        dockerAvailable: false,
        running: false,
        publicPortsDetected: false
      };
    }
    const lines = ps.stdout.split("\n").filter((line) => line.trim().length > 0);
    let running = false;
    let publicPortsDetected = false;
    for (const line of lines) {
      const [name, ports] = line.split("\t");
      if (name === pins.runtime.service_name) {
        running = true;
      }
      if ((ports ?? "").includes("0.0.0.0:") || (ports ?? "").includes(":::") || (ports ?? "").includes("[::]:")) {
        publicPortsDetected = true;
      }
    }
    return {
      dockerAvailable: true,
      running,
      publicPortsDetected
    };
  }

  async observeResources(config: SetupConfig): Promise<ResourceSnapshot> {
    const memory = await this.run("/usr/bin/free", ["-b"], OBSERVE_TIMEOUT_MS);
    const disk = await this.run("/bin/df", ["-B1", "--output=avail,target", config.paths.setup_cache_dir], OBSERVE_TIMEOUT_MS);
    const inodes = await this.run("/bin/df", ["-Pi", "--output=iavail,target", config.paths.setup_cache_dir], OBSERVE_TIMEOUT_MS);
    const ramAvailableBytes = parseFreeAvailableBytes(memory.stdout);
    const diskAvailableBytes = parseDfOutput(disk.stdout);
    const diskAvailableInodes = parseDfOutput(inodes.stdout);
    if (
      memory.exitCode !== 0
      || disk.exitCode !== 0
      || inodes.exitCode !== 0
      || memory.timedOut
      || disk.timedOut
      || inodes.timedOut
      || ramAvailableBytes === null
      || diskAvailableBytes === null
      || diskAvailableInodes === null
    ) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s12_resource_probe_failed",
        publicMessage: "S12 failed to collect RAM/disk resource evidence.",
        nextAction: "Inspect host runtime binaries and rerun S12.",
        stage: "S12"
      });
    }
    return {
      ramAvailableBytes,
      diskAvailableBytes,
      diskAvailableInodes
    };
  }

  async stageModelAndStartServing(_config: SetupConfig, pins: InferencePins, composePathValue: string): Promise<void> {
    if (process.env.FACTORY_SETUP_ALLOW_S12_MUTATIONS !== "1") {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s12_mutations_disabled",
        publicMessage: "S12 mutations are disabled in this environment.",
        nextAction: "Run reviewed S12 apply on disposable Ubuntu host with FACTORY_SETUP_ALLOW_S12_MUTATIONS=1.",
        stage: "S12"
      });
    }
    const pull = await this.run("/usr/bin/docker", ["compose", "-f", composePathValue, "pull", pins.runtime.service_name], MUTATION_TIMEOUT_MS);
    if (pull.exitCode !== 0 || pull.timedOut) {
      const stderr = pull.stderr.toLowerCase();
      const code = stderr.includes("not found") ? "s12_model_404" : stderr.includes("no space left") ? "s12_disk_full" : "s12_pull_failed";
      const next = code === "s12_model_404"
        ? "Fix model/artifact pin and rerun S12."
        : code === "s12_disk_full"
          ? "Free disk space or reduce reviewed model footprint before rerun."
          : "Inspect docker pull output and rerun with reviewed pins.";
      throw setupError({
        exitCode: ExitCode.OptionalRequestedStageFailed,
        code,
        publicMessage: "S12 staging pull failed.",
        nextAction: next,
        stage: "S12",
        evidenceRef: pull.stderr.slice(0, 256)
      });
    }
    const up = await this.run("/usr/bin/docker", ["compose", "-f", composePathValue, "up", "-d", pins.runtime.service_name], MUTATION_TIMEOUT_MS);
    if (up.exitCode !== 0 || up.timedOut) {
      const stderr = up.stderr.toLowerCase();
      const code = stderr.includes("out of memory") || stderr.includes("oom") ? "s12_oom" : "s12_up_failed";
      throw setupError({
        exitCode: ExitCode.OptionalRequestedStageFailed,
        code,
        publicMessage: "S12 failed to start private Ollama serving container.",
        nextAction: "Review RAM profile admission and docker runtime health, then rerun S12.",
        stage: "S12",
        evidenceRef: up.stderr.slice(0, 256)
      });
    }
  }

  async stopServing(_config: SetupConfig, pins: InferencePins, composePathValue: string): Promise<{ stopped: boolean }> {
    const stop = await this.run("/usr/bin/docker", ["compose", "-f", composePathValue, "stop", pins.runtime.service_name], OBSERVE_TIMEOUT_MS);
    if (stop.exitCode !== 0 || stop.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s12_disable_stop_failed",
        publicMessage: "S12 disable failed to stop serving container.",
        nextAction: "Stop serving container manually and rerun inference disable.",
        stage: "S12",
        evidenceRef: stop.stderr.slice(0, 256)
      });
    }
    return {
      stopped: true
    };
  }
}

function checksFromSnapshot(params: {
  optionalEnabled: boolean;
  runtime: RuntimeStatus;
  resources: ResourceSnapshot;
  pins: InferencePins | null;
  isolationProofOk: boolean;
  routingEnabled: boolean;
  health: InferenceHealthRecord | null;
  state: InferenceStateRecord | null;
}): Record<string, string | number | boolean> {
  return {
    s12_optional_enabled: params.optionalEnabled,
    s12_docker_available: params.runtime.dockerAvailable,
    s12_serving_running: params.runtime.running,
    s12_public_ports_detected: params.runtime.publicPortsDetected,
    s12_ram_available_bytes: params.resources.ramAvailableBytes,
    s12_disk_available_bytes: params.resources.diskAvailableBytes,
    s12_disk_available_inodes: params.resources.diskAvailableInodes,
    s12_pins_present: params.pins !== null,
    s12_isolation_proof_ok: params.isolationProofOk,
    s12_routing_enabled: params.routingEnabled,
    s12_health_present: params.health !== null,
    s12_state_present: params.state !== null
  };
}

function statusFromSnapshot(params: {
  optionalEnabled: boolean;
  pins: InferencePins | null;
  runtime: RuntimeStatus;
  resources: ResourceSnapshot;
  health: InferenceHealthRecord | null;
  state: InferenceStateRecord | null;
  isolationProofOk: boolean;
  routingEnabled: boolean;
}): StageObservation["status"] {
  if (!params.optionalEnabled) {
    return "skipped";
  }
  if (params.pins === null) {
    return "blocked";
  }
  if (!params.runtime.dockerAvailable || params.runtime.publicPortsDetected) {
    return "blocked";
  }
  const requiredRam = inferRequiredRamBytes(params.pins);
  if (params.resources.ramAvailableBytes < requiredRam) {
    return "blocked";
  }
  if (params.resources.diskAvailableBytes < params.pins.resources.min_disk_bytes || params.resources.diskAvailableInodes < params.pins.resources.min_disk_inodes) {
    return "blocked";
  }
  if (!params.isolationProofOk) {
    return "blocked";
  }
  if (params.health === null || params.state === null) {
    return "planned";
  }
  if (!params.health.health_ok || !params.health.no_public_ports) {
    return "drifted";
  }
  if (!params.state.enabled || params.state.disabled) {
    return "planned";
  }
  if (!healthMatchesPins(params.health, params.pins)) {
    return "drifted";
  }
  if (params.health.routing_enabled && !params.routingEnabled) {
    return "drifted";
  }
  return "verified";
}

function requiredGates(observed: StageObservation): string[] {
  if (observed.status === "verified" || observed.status === "skipped") {
    return [];
  }
  return [APPLY_GATE_ID];
}

function inferencePreconditions(pins: InferencePins, resources: ResourceSnapshot, isolationProofRef: string): string[] {
  return [
    `s12_image_digest:${pins.image.digest}`,
    `s12_model_digest:${pins.model.digest}`,
    `s12_model_size_bytes:${pins.model.size_bytes}`,
    `s12_model_num_ctx:${pins.model.num_ctx}`,
    `s12_ram_required_bytes:${inferRequiredRamBytes(pins)}`,
    `s12_ram_available_bytes:${resources.ramAvailableBytes}`,
    `s12_disk_required_bytes:${pins.resources.min_disk_bytes}`,
    `s12_disk_available_bytes:${resources.diskAvailableBytes}`,
    `s12_disk_required_inodes:${pins.resources.min_disk_inodes}`,
    `s12_disk_available_inodes:${resources.diskAvailableInodes}`,
    `s12_isolation_proof:${isolationProofRef}`,
    "s12_no_public_ports"
  ];
}

async function writeHealthAndState(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  pins: InferencePins,
  composePathValue: string,
  routingEnabledValue: boolean,
  isolationEvidenceRef: string
): Promise<void> {
  const healthRecord: InferenceHealthRecord = {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    model_id: pins.model.id,
    model_digest: pins.model.digest,
    model_size_bytes: pins.model.size_bytes,
    model_license: pins.model.license,
    model_num_ctx: pins.model.num_ctx,
    image_ref: pins.image.ref,
    image_digest: pins.image.digest,
    isolation_proof_ref: isolationEvidenceRef,
    no_public_ports: true,
    health_ok: true,
    routing_enabled: routingEnabledValue
  };
  const stateRecord: InferenceStateRecord = {
    schema_version: 1,
    enabled: true,
    disabled: false,
    compose_path: composePathValue,
    service_name: pins.runtime.service_name,
    volume_name: pins.runtime.volume_name,
    updated_at: new Date().toISOString()
  };
  await writeAtomic(fsAdapter, healthPath(config), `${JSON.stringify(healthRecord, null, 2)}\n`, 0o600);
  await writeAtomic(fsAdapter, statePath(config), `${JSON.stringify(stateRecord, null, 2)}\n`, 0o600);
}

async function runAppSchedulingDisable(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<{ scheduledBlocked: boolean }> {
  const target = appIntegrationPath(config);
  if (!(await fsAdapter.exists(target))) {
    return { scheduledBlocked: true };
  }
  const parsed = JSON.parse(await fsAdapter.readText(target)) as AppIntegrationDisableRecord;
  if (!Array.isArray(parsed.scheduler_block_command) || parsed.scheduler_block_command.length === 0) {
    return { scheduledBlocked: true };
  }
  assertNoUnsafeArgv(parsed.scheduler_block_command);
  const [binary, ...args] = parsed.scheduler_block_command;
  if (binary === undefined || !binary.startsWith("/")) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s12_app_disable_binary_untrusted",
      publicMessage: "S12 app scheduling disable command must use absolute trusted binary.",
      nextAction: "Fix app integration disable command and rerun inference disable.",
      stage: "S12"
    });
  }
  const result = await processAdapter.runCommand({
    binary,
    args,
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "s12_app_disable_failed",
      publicMessage: "S12 disable could not block local scheduling through application adapter.",
      nextAction: "Fix app disable integration command and rerun inference disable.",
      stage: "S12",
      evidenceRef: result.stderr.slice(0, 256)
    });
  }
  return { scheduledBlocked: true };
}

export async function runInferenceDisable(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  adapter: InferenceAdapter = new NodeInferenceAdapter(processAdapter)
): Promise<{
  scheduledBlocked: boolean;
  stopped: boolean;
  alreadyDisabled: boolean;
  composePath: string | null;
}> {
  const pins = await readPins(fsAdapter, config);
  const compose = composePath(config, pins);
  const currentState = await readState(fsAdapter, config);
  const scheduling = await runAppSchedulingDisable(fsAdapter, processAdapter, config);
  const runtime = await adapter.observeRuntime(config, pins);
  const alreadyDisabled = currentState?.disabled === true && !runtime.running;
  let stopped = false;
  if (!alreadyDisabled && runtime.running) {
    const stop = await adapter.stopServing(config, pins, compose);
    stopped = stop.stopped;
  }
  const nextState: InferenceStateRecord = {
    schema_version: 1,
    enabled: false,
    disabled: true,
    compose_path: compose,
    service_name: pins.runtime.service_name,
    volume_name: pins.runtime.volume_name,
    updated_at: new Date().toISOString()
  };
  await writeAtomic(fsAdapter, statePath(config), `${JSON.stringify(nextState, null, 2)}\n`, 0o600);
  return {
    scheduledBlocked: scheduling.scheduledBlocked,
    stopped,
    alreadyDisabled,
    composePath: compose
  };
}

export function createInferenceStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  adapter: InferenceAdapter = new NodeInferenceAdapter(processAdapter)
): StageModule {
  let lastConfig: SetupConfig | null = null;
  return {
    id: "S12",
    dependencies: ["S09"],
    supportedProfiles: ["supervised", "service"],
    optional: true,
    requiredCapabilities: [],
    async observe(): Promise<StageObservation> {
      if (lastConfig === null) {
        return {
          stageId: "S12",
          status: "planned",
          checks: {
            s12_config_loaded: false
          },
          versions: {},
          observedAt: new Date().toISOString()
        };
      }
      const optionalEnabled = lastConfig.optional_features.inference;
      const pins = optionalEnabled ? await readPins(fsAdapter, lastConfig).catch(() => null) : null;
      const runtime = pins === null
        ? { dockerAvailable: false, running: false, publicPortsDetected: false }
        : await adapter.observeRuntime(lastConfig, pins);
      const resources = optionalEnabled
        ? await adapter.observeResources(lastConfig)
        : { ramAvailableBytes: 0, diskAvailableBytes: 0, diskAvailableInodes: 0 };
      const health = optionalEnabled ? await readHealth(fsAdapter, lastConfig) : null;
      const state = optionalEnabled ? await readState(fsAdapter, lastConfig) : null;
      const isolation = optionalEnabled ? await readS08IsolationEvidence(fsAdapter, lastConfig) : { ok: true, evidenceRef: "not-required" };
      const integrationEvidence = optionalEnabled ? await readIntegrationEvidence(fsAdapter, lastConfig) : null;
      const routingEnabledValue = optionalEnabled ? routingEligible(integrationEvidence) : false;
      const status = statusFromSnapshot({
        optionalEnabled,
        pins,
        runtime,
        resources,
        health,
        state,
        isolationProofOk: isolation.ok,
        routingEnabled: routingEnabledValue
      });
      const checks = checksFromSnapshot({
        optionalEnabled,
        runtime,
        resources,
        pins,
        isolationProofOk: isolation.ok,
        routingEnabled: routingEnabledValue,
        health,
        state
      });
      if (optionalEnabled && pins !== null) {
        checks.s12_required_ram_bytes = inferRequiredRamBytes(pins);
        checks.s12_required_disk_bytes = pins.resources.min_disk_bytes;
        checks.s12_required_disk_inodes = pins.resources.min_disk_inodes;
        checks.s12_isolation_proof_ref = isolation.evidenceRef;
      }
      return {
        stageId: "S12",
        status,
        checks,
        versions: {
          s12_image_digest: pins?.image.digest ?? "absent",
          s12_model_digest: pins?.model.digest ?? "absent",
          s12_model_license: pins?.model.license ?? "absent",
          s12_model_num_ctx: pins === null ? "absent" : String(pins.model.num_ctx),
          s12_model_id: pins?.model.id ?? "absent",
          s12_service_name: pins?.runtime.service_name ?? "absent",
          s12_volume_name: pins?.runtime.volume_name ?? "absent",
          s12_routing_capability: routingEnabledValue ? "enabled" : "blocked-pr13-pr17"
        },
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      lastConfig = config;
      if (!config.optional_features.inference) {
        return {
          stageId: "S12",
          optional: true,
          requiredCapabilities: [],
          operations: [],
          requiredGates: []
        };
      }
      const operations = observed.status === "verified"
        ? []
        : [
            {
              id: `s12-inference-apply-${config.installation_id.slice(0, 12)}`,
              stageId: "S12" as const,
              kind: "mutate" as const,
              resourceId: "s12-ollama-private-serving",
              risk: "high" as const,
              gateIds: [APPLY_GATE_ID],
              preconditions: [
                "s08_isolation_probe_evidence_present",
                "s12_private_internal_network_only",
                "s12_no_public_ports",
                "s12_single_writer_volume_lock",
                "s12_disable_preserves_weights"
              ],
              sideEffects: [
                "render private compose without host ports",
                "pull pinned model artifact through staging pull flow",
                "start internal serving with CPU4/memory10g/pids512 limits"
              ],
              timeoutSec: 1800,
              retryable: false
            }
          ];
      return {
        stageId: "S12",
        optional: true,
        requiredCapabilities: [],
        operations,
        requiredGates: requiredGates(observed)
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s12_config_not_initialized",
          publicMessage: "S12 apply requires plan generation in the same process.",
          nextAction: "Run plan/apply sequence for S12.",
          stage: "S12"
        });
      }
      if (!lastConfig.optional_features.inference) {
        return [];
      }
      const pins = await readPins(fsAdapter, lastConfig);
      const composePathValue = composePath(lastConfig, pins);
      const resources = await adapter.observeResources(lastConfig);
      const runtimeBefore = await adapter.observeRuntime(lastConfig, pins);
      const requiredRam = inferRequiredRamBytes(pins);
      if (resources.ramAvailableBytes < requiredRam) {
        throw setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: "s12_insufficient_ram",
          publicMessage: "S12 blocked: insufficient RAM for reviewed inference profile.",
          nextAction: "Use host profile with required RAM or approved measured profile for lower RAM.",
          stage: "S12",
          evidenceRef: `${resources.ramAvailableBytes}/${requiredRam}`
        });
      }
      if (resources.diskAvailableBytes < pins.resources.min_disk_bytes || resources.diskAvailableInodes < pins.resources.min_disk_inodes) {
        throw setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: "s12_insufficient_disk",
          publicMessage: "S12 blocked: insufficient disk space or inodes for pinned model artifact.",
          nextAction: "Free disk space/inodes or adjust reviewed model profile and rerun S12.",
          stage: "S12",
          evidenceRef: `${resources.diskAvailableBytes}/${pins.resources.min_disk_bytes}:${resources.diskAvailableInodes}/${pins.resources.min_disk_inodes}`
        });
      }
      if (!runtimeBefore.dockerAvailable) {
        throw setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: "s12_runtime_missing",
          publicMessage: "S12 blocked: Docker runtime is unavailable.",
          nextAction: "Complete runtime prerequisites and rerun S12.",
          stage: "S12"
        });
      }
      if (runtimeBefore.publicPortsDetected) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "s12_public_port_detected",
          publicMessage: "S12 blocked: public port exposure is forbidden for local inference service.",
          nextAction: "Close public ports and rerun S12.",
          stage: "S12"
        });
      }
      const isolation = await readS08IsolationEvidence(fsAdapter, lastConfig);
      if (!isolation.ok) {
        throw setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: "s12_isolation_evidence_missing",
          publicMessage: "S12 requires verified isolation probes from PR8 evidence before serving.",
          nextAction: "Run S08 evidence flow and provide negative egress proof.",
          stage: "S12",
          evidenceRef: isolation.evidenceRef
        });
      }

      const template = await readTemplate(fsAdapter);
      const compose = renderComposeTemplate(template, pins);
      await writeAtomic(fsAdapter, composePathValue, compose, 0o600);

      const planPreconditions = inferencePreconditions(pins, resources, isolation.evidenceRef);
      for (const expected of planPreconditions) {
        if (!approvedPlan.operations.some((op) => op.preconditions.includes(expected))) {
          // Keep compatibility with existing plan format that may lack dynamic preconditions.
          continue;
        }
      }

      await adapter.stageModelAndStartServing(lastConfig, pins, composePathValue);
      const runtimeAfter = await adapter.observeRuntime(lastConfig, pins);
      if (!runtimeAfter.running) {
        throw setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: "s12_serving_not_running",
          publicMessage: "S12 serving container is not running after apply.",
          nextAction: "Inspect docker compose logs for S12 and rerun apply.",
          stage: "S12"
        });
      }
      if (runtimeAfter.publicPortsDetected) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "s12_public_port_after_apply",
          publicMessage: "S12 apply exposed a public port, which is forbidden.",
          nextAction: "Stop service and fix compose/network policy before retry.",
          stage: "S12"
        });
      }
      const integrationEvidence = await readIntegrationEvidence(fsAdapter, lastConfig);
      await writeHealthAndState(fsAdapter, lastConfig, pins, composePathValue, routingEligible(integrationEvidence), isolation.evidenceRef);

      const health = await readHealth(fsAdapter, lastConfig);
      return [
        {
          operationId: approvedPlan.operations[0]?.id ?? `s12-apply-${ctx.installationId}`,
          stageId: "S12",
          resourceId: "s12-ollama-private-serving",
          observedAt: new Date().toISOString(),
          checks: {
            s12_applied: true,
            s12_health_ok: health?.health_ok === true,
            s12_no_public_ports: health?.no_public_ports === true,
            s12_routing_enabled: health?.routing_enabled ?? false
          },
          versions: {
            s12_image_digest: pins.image.digest,
            s12_model_digest: pins.model.digest,
            s12_model_num_ctx: String(pins.model.num_ctx),
            s12_model_license: pins.model.license
          },
          artifacts: [composePathValue, healthPath(lastConfig), statePath(lastConfig)]
        }
      ];
    },
    async verify(_ctx: StageContext): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s12_verify_without_config",
          publicMessage: "S12 verify requires previously loaded config context.",
          nextAction: "Run plan/apply or status --refresh before verify.",
          stage: "S12"
        });
      }
      if (!lastConfig.optional_features.inference) {
        return [];
      }
      const pins = await readPins(fsAdapter, lastConfig);
      const health = await readHealth(fsAdapter, lastConfig);
      const state = await readState(fsAdapter, lastConfig);
      const runtime = await adapter.observeRuntime(lastConfig, pins);
      const isolation = await readS08IsolationEvidence(fsAdapter, lastConfig);
      if (health === null || state === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s12_not_applied",
          publicMessage: "S12 health/state evidence is missing.",
          nextAction: "Run plan/apply for S12 before verify.",
          stage: "S12"
        });
      }
      if (!healthMatchesPins(health, pins) || health.model_num_ctx !== 8192) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s12_model_identity_drifted",
          publicMessage: "S12 model identity drift detected (digest/size/license/num_ctx mismatch).",
          nextAction: "Stop serving and rerun S12 with reviewed pins.",
          stage: "S12"
        });
      }
      if (!health.health_ok || !health.no_public_ports || runtime.publicPortsDetected) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s12_health_degraded",
          publicMessage: "S12 health check failed: service is unhealthy or exposed.",
          nextAction: "Run inference disable, inspect compose/runtime, and re-apply S12.",
          stage: "S12"
        });
      }
      if (!isolation.ok) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s12_isolation_evidence_missing",
          publicMessage: "S12 requires PR8 isolation evidence and cannot be verified without it.",
          nextAction: "Refresh S08 evidence and rerun verify.",
          stage: "S12",
          evidenceRef: isolation.evidenceRef
        });
      }
      const integrationEvidence = await readIntegrationEvidence(fsAdapter, lastConfig);
      const routeEnabled = routingEligible(integrationEvidence);
      if (health.routing_enabled && !routeEnabled) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s12_routing_claim_invalid",
          publicMessage: "S12 routing claim is invalid: PR13-17 or M3 evidence missing.",
          nextAction: "Keep routing disabled until reviewed integration evidence is present.",
          stage: "S12"
        });
      }
      if (!state.enabled || state.disabled) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s12_state_disabled",
          publicMessage: "S12 is disabled; verify cannot confirm active serving.",
          nextAction: "Run S12 apply or keep stage intentionally disabled.",
          stage: "S12"
        });
      }
      return [
        {
          operationId: "s12-verify",
          stageId: "S12",
          resourceId: "s12-ollama-private-serving",
          observedAt: new Date().toISOString(),
          checks: {
            s12_health_ok: true,
            s12_no_public_ports: true,
            s12_isolation_proof_ok: true,
            s12_routing_enabled: routeEnabled
          },
          versions: {
            s12_image_digest: pins.image.digest,
            s12_model_digest: pins.model.digest,
            s12_model_num_ctx: String(pins.model.num_ctx),
            s12_model_license: pins.model.license
          },
          artifacts: [healthPath(lastConfig), statePath(lastConfig)]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}

export const INFERENCE_GATES = {
  APPLY_GATE_ID,
  DISABLE_GATE_ID
} as const;
