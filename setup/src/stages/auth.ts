import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type CommandResult, type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import {
  ExitCode,
  type SetupConfig,
  type SetupState,
  type StageContext,
  type StageModule,
  type StageObservation,
  type StagePlan,
  type StageReceipt
} from "../core/types";
import { validateContractSchema } from "../core/validators";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_FILE_BYTES = 128 * 1024;

const AUTH_STATUS_FILENAME = "s08-auth-status.json";
const LIVE_SMOKE_FILENAME = "s08-live-smoke.json";
const LIVE_SMOKE_INTENT_FILENAME = "s08-live-smoke.intent.json";
const S06_IMAGE_STATE_FILENAME = "s06-agent-image.json";

const LIVE_RISK_GATE_ID = "s08-live-risk-approved";
const LIVE_QUOTA_GATE_ID = "s08-live-quota-approved";

export interface ApplicationManifestData {
  schema_version: 1;
  application_version: string;
  source_commit: string;
  content_hashes: Record<string, string>;
  node_range: string;
  capabilities: string[];
  commands: Record<string, string[]>;
  config_schema_version: number;
  state_schema_version: number;
  migrations: { from: number; to: number };
  security_evidence_refs: string[];
}

interface AuthStatusRecord {
  schema_version: 1;
  authenticated: boolean;
  observed_at: string;
}

interface LiveSmokeIntentRecord {
  schema_version: 1;
  provider: "live" | "fake";
  fixture: "toy";
  attempt: number;
  started_at: string;
}

interface LiveSmokeResultRecord {
  schema_version: 1;
  provider: "live" | "fake";
  fixture: "toy";
  status: "needs_review" | "unknown";
  source_sha: string;
  consumed_count: number;
  unknown_usage: boolean;
  observed_at: string;
  run_id: string;
  terminal_events: string[];
}

interface RunnerResultPayload {
  schema_version: 1;
  provider: "live" | "fake";
  fixture: "toy";
  task: "scout";
  source_sha: string;
  status: "runner_ready_offline" | "needs_review" | "turn_failed" | "timeout" | "cleanup_failed";
  terminal_events: string[];
  run_id: string;
  usage: {
    daily_consumed: number;
  };
}

interface RunnerCommand {
  binary: string;
  args: string[];
}

interface SmokeOptions {
  provider: "live" | "fake";
  fixture: "toy";
}

function authStatusPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, AUTH_STATUS_FILENAME);
}

function liveSmokePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, LIVE_SMOKE_FILENAME);
}

function liveSmokeIntentPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, LIVE_SMOKE_INTENT_FILENAME);
}

function imageStatePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, S06_IMAGE_STATE_FILENAME);
}

async function readJsonFile(
  fsAdapter: FilesystemAdapter,
  targetPath: string
): Promise<{ parsed: unknown; bytes: number }> {
  const stat = await fsAdapter.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s08_result_entry_forbidden",
      publicMessage: "Result entry must be a regular file and not a symlink.",
      nextAction: "Remove special/symlink result entries and rerun the command.",
      stage: "S08",
      evidenceRef: targetPath
    });
  }
  const raw = await fsAdapter.readText(targetPath);
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_RESULT_FILE_BYTES) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s08_result_too_large",
      publicMessage: "Result file exceeds the allowed size limit.",
      nextAction: "Inspect runner output path and ensure compact JSON payload.",
      stage: "S08",
      evidenceRef: `${targetPath}:${bytes}`
    });
  }
  return {
    parsed: JSON.parse(raw),
    bytes
  };
}

async function writeAtomic(
  fsAdapter: FilesystemAdapter,
  targetPath: string,
  content: string,
  mode: number
): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

function hasDisallowedCommand(binaryRaw: string): boolean {
  const base = path.posix.basename(binaryRaw.replaceAll("\\", "/"));
  return base === "npm" || base === "npx" || base === "pnpm" || base === "yarn";
}

function resolveManifestBinary(binaryRaw: string, config: SetupConfig): string {
  if (hasDisallowedCommand(binaryRaw)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s08_npm_command_forbidden",
      publicMessage: "Running npm/yarn/pnpm scripts from installer auth/smoke flow is forbidden.",
      nextAction: "Provide absolute binary or node-based command in deployment-manifest.json.",
      stage: "S08"
    });
  }
  if (binaryRaw === "node") {
    return path.join(config.paths.setup_node_dir, "bin", "node");
  }
  if (binaryRaw.startsWith("/")) {
    return binaryRaw;
  }
  if (binaryRaw.includes("/")) {
    return path.join(config.paths.application_dir, binaryRaw);
  }
  throw setupError({
    exitCode: ExitCode.SecurityBoundaryViolation,
    code: "s08_untrusted_runner_binary",
    publicMessage: `Runner command binary '${binaryRaw}' is not trusted.`,
    nextAction: "Use absolute binaries or node-based argv in deployment-manifest.json.",
    stage: "S08"
  });
}

function resolveManifestArgs(args: string[], config: SetupConfig): string[] {
  return args.map((value, index) => {
    if (
      index === 0
      && (value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".cjs") || value.endsWith(".ts"))
    ) {
      return path.join(config.paths.application_dir, value);
    }
    return value;
  });
}

async function readManifest(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<ApplicationManifestData> {
  const manifestPath = path.join(config.paths.application_dir, "deployment-manifest.json");
  if (!(await fsAdapter.exists(manifestPath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_manifest_missing",
      publicMessage: "deployment-manifest.json is missing; S08 is blocked.",
      nextAction: "Deploy reviewed M0 release first and rerun auth/smoke.",
      stage: "S08",
      evidenceRef: manifestPath
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsAdapter.readText(manifestPath));
  } catch {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_manifest_invalid_json",
      publicMessage: "deployment-manifest.json is invalid JSON.",
      nextAction: "Redeploy reviewed release with a valid deployment manifest.",
      stage: "S08",
      evidenceRef: manifestPath
    });
  }
  const validation = validateContractSchema("application-manifest", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_manifest_invalid_schema",
      publicMessage: `deployment-manifest.json validation failed: ${validation.errors.join("; ")}`,
      nextAction: "Provide reviewed manifest compatible with CONTRACT 1.0.0.",
      stage: "S08",
      evidenceRef: manifestPath
    });
  }
  return parsed as ApplicationManifestData;
}

async function resolveRunnerVerifyCommand(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<RunnerCommand> {
  const manifest = await readManifest(fsAdapter, config);
  if (!manifest.capabilities.includes("runner-readonly")) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_readonly_missing",
      publicMessage: "Release manifest does not provide runner-readonly capability.",
      nextAction: "Provide reviewed release with runner-readonly capability.",
      stage: "S08"
    });
  }
  const argv = manifest.commands.runner_verify;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_verify_missing",
      publicMessage: "Manifest runner_verify command is missing.",
      nextAction: "Provide deployment-manifest with a valid runner_verify command.",
      stage: "S08"
    });
  }
  const [binaryRaw, ...argsRaw] = argv;
  if (binaryRaw === undefined) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_verify_empty",
      publicMessage: "Manifest runner_verify command is empty.",
      nextAction: "Fix deployment-manifest runner_verify argv.",
      stage: "S08"
    });
  }
  return {
    binary: resolveManifestBinary(binaryRaw, config),
    args: resolveManifestArgs(argsRaw, config)
  };
}

async function readPinnedImageRef(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<string> {
  const statePath = imageStatePath(config);
  if (!(await fsAdapter.exists(statePath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_image_state_missing",
      publicMessage: "Pinned S06 image state is missing; S08 is blocked.",
      nextAction: "Complete S06 successfully before auth/smoke.",
      stage: "S08",
      evidenceRef: statePath
    });
  }
  const parsed = JSON.parse(await fsAdapter.readText(statePath)) as {
    image_id?: unknown;
    image_digest?: unknown;
  };
  const imageId = typeof parsed.image_id === "string" ? parsed.image_id.trim() : "";
  const imageDigest = typeof parsed.image_digest === "string" ? parsed.image_digest.trim() : "";
  if (/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    return imageId;
  }
  if (/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    return imageDigest;
  }
  throw setupError({
    exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "s08_image_state_invalid",
    publicMessage: "Pinned image state does not contain a valid image identifier.",
    nextAction: "Rerun S06 to rebuild/record the pinned agent image.",
    stage: "S08",
    evidenceRef: statePath
  });
}

async function toySourceSha(processAdapter: ProcessAdapter, config: SetupConfig): Promise<string> {
  const result = await processAdapter.runCommand({
    binary: "/usr/bin/git",
    args: ["-C", path.join(config.paths.application_work_dir, "factory-toy-fixture"), "rev-parse", "HEAD"],
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || !/^[0-9a-f]{40}$/.test(value)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_toy_fixture_missing",
      publicMessage: "Toy fixture git identity is unavailable; S08 is blocked.",
      nextAction: "Run S06 to materialize deterministic factory-toy-fixture and retry.",
      stage: "S08"
    });
  }
  return value;
}

function containsSecretLeak(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return /SYNTHETIC_SECRET_MARKER|synthetic-secret-marker|Bearer\s+/i.test(output);
}

async function authPresence(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<boolean> {
  if (!(await fsAdapter.exists(config.paths.application_auth_dir))) {
    return false;
  }
  const stat = await fsAdapter.lstat(config.paths.application_auth_dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return false;
  }
  const entries = await fsAdapter.readdir(config.paths.application_auth_dir);
  return entries.length > 0;
}

function approvedGate(state: SetupState, gateId: string): boolean {
  const now = Date.now();
  return state.pending_gates.some(
    (gate) => gate.id === gateId && gate.status === "approved" && new Date(gate.expires_at).getTime() > now
  );
}

async function readLiveSmokeRecord(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<LiveSmokeResultRecord | null> {
  const targetPath = liveSmokePath(config);
  if (!(await fsAdapter.exists(targetPath))) {
    return null;
  }
  const loaded = await readJsonFile(fsAdapter, targetPath);
  const parsed = loaded.parsed as Record<string, unknown>;
  const requiredEvents = Array.isArray(parsed.terminal_events)
    ? parsed.terminal_events.every((item) => typeof item === "string")
    : false;
  if (
    parsed.schema_version !== 1
    || (parsed.provider !== "live" && parsed.provider !== "fake")
    || parsed.fixture !== "toy"
    || (parsed.status !== "needs_review" && parsed.status !== "unknown")
    || typeof parsed.source_sha !== "string"
    || !/^[0-9a-f]{40}$/.test(parsed.source_sha)
    || typeof parsed.consumed_count !== "number"
    || parsed.consumed_count < 0
    || typeof parsed.unknown_usage !== "boolean"
    || typeof parsed.observed_at !== "string"
    || typeof parsed.run_id !== "string"
    || !requiredEvents
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s08_live_smoke_record_invalid",
      publicMessage: "Stored live smoke record is invalid or drifted.",
      nextAction: "Remove corrupted record and rerun explicit smoke command.",
      stage: "S08",
      evidenceRef: targetPath
    });
  }
  return {
    schema_version: 1,
    provider: parsed.provider,
    fixture: "toy",
    status: parsed.status,
    source_sha: parsed.source_sha,
    consumed_count: parsed.consumed_count,
    unknown_usage: parsed.unknown_usage,
    observed_at: parsed.observed_at,
    run_id: parsed.run_id,
    terminal_events: parsed.terminal_events as string[]
  };
}

function validateRunnerPayload(payload: unknown): RunnerResultPayload {
  const data = payload as Record<string, unknown>;
  const events = Array.isArray(data.terminal_events)
    ? data.terminal_events.filter((item): item is string => typeof item === "string")
    : [];
  const usage = data.usage as Record<string, unknown>;
  if (
    data.schema_version !== 1
    || (data.provider !== "live" && data.provider !== "fake")
    || data.fixture !== "toy"
    || data.task !== "scout"
    || typeof data.source_sha !== "string"
    || !/^[0-9a-f]{40}$/.test(data.source_sha)
    || typeof data.status !== "string"
    || !["runner_ready_offline", "needs_review", "turn_failed", "timeout", "cleanup_failed"].includes(data.status)
    || events.length === 0
    || typeof data.run_id !== "string"
    || data.run_id.length === 0
    || typeof usage?.daily_consumed !== "number"
  ) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_result_schema_invalid",
      publicMessage: "Runner result JSON has invalid schema.",
      nextAction: "Fix runner output schema in reviewed application release.",
      stage: "S08"
    });
  }
  return {
    schema_version: 1,
    provider: data.provider as "live" | "fake",
    fixture: "toy",
    task: "scout",
    source_sha: data.source_sha,
    status: data.status as RunnerResultPayload["status"],
    terminal_events: events,
    run_id: data.run_id,
    usage: {
      daily_consumed: usage.daily_consumed as number
    }
  };
}

function normalizeOfflineEvents(events: string[]): string[] {
  return events.filter((value) =>
    value === "runner.started" || value === "runner.completed" || value === "runner.needs_review"
  );
}

async function executeRunnerVerify(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  options: SmokeOptions,
  outputPath: string
): Promise<RunnerResultPayload> {
  const command = await resolveRunnerVerifyCommand(fsAdapter, config);
  const result = await processAdapter.runCommand({
    binary: command.binary,
    args: [
      ...command.args,
      "--provider",
      options.provider,
      "--fixture",
      options.fixture,
      "--output",
      outputPath
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  if (containsSecretLeak(result)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s08_secret_leak_detected",
      publicMessage: "Runner output leaked a synthetic secret marker.",
      nextAction: "Fix runner redaction/stream filtering and rerun verification.",
      stage: "S08"
    });
  }
  if (result.timedOut) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_verify_timeout",
      publicMessage: "Runner verification command timed out.",
      nextAction: "Inspect runner health and rerun explicit smoke command.",
      stage: "S08"
    });
  }
  if (result.exitCode !== 0) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "s08_runner_verify_failed",
      publicMessage: "Runner verification command returned non-zero status.",
      nextAction: "Inspect reviewed runner logs and rerun explicit smoke command.",
      stage: "S08"
    });
  }
  if (!(await fsAdapter.exists(outputPath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s08_runner_result_missing",
      publicMessage: "Runner verification did not produce result JSON.",
      nextAction: "Fix reviewed runner_verify command to write expected output.",
      stage: "S08",
      evidenceRef: outputPath
    });
  }
  const loaded = await readJsonFile(fsAdapter, outputPath);
  const payload = validateRunnerPayload(loaded.parsed);
  return payload;
}

async function writeUnknownLiveResult(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  consumedCount: number,
  sourceSha: string,
  runId: string
): Promise<void> {
  const record: LiveSmokeResultRecord = {
    schema_version: 1,
    provider: "live",
    fixture: "toy",
    status: "unknown",
    source_sha: sourceSha,
    consumed_count: consumedCount,
    unknown_usage: true,
    observed_at: new Date().toISOString(),
    run_id: runId,
    terminal_events: ["runner.started"]
  };
  await writeAtomic(fsAdapter, liveSmokePath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export async function runAuthLogin(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<void> {
  const imageRef = await readPinnedImageRef(fsAdapter, config);
  await fsAdapter.mkdir(config.paths.application_auth_dir, { recursive: true, mode: 0o700 });
  const login = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: [
      "run",
      "--rm",
      "--interactive",
      "--tty",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,src=${config.paths.application_auth_dir},dst=/auth`,
      imageRef,
      "login",
      "--auth-dir",
      "/auth"
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
    maxOutputBytes: 4096
  });
  if (login.timedOut) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s08_auth_login_timeout",
      publicMessage: "Interactive auth login timed out.",
      nextAction: "Retry `factory-setup auth login` in an interactive TTY session.",
      stage: "S08"
    });
  }
  if (login.exitCode !== 0) {
    const ttyMissing = /tty|not a terminal|input device/i.test(login.stderr);
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: ttyMissing ? "s08_tty_required" : "s08_auth_login_failed",
      publicMessage: ttyMissing
        ? "Interactive TTY is required for OAuth login."
        : "OAuth login failed or was cancelled by the owner.",
      nextAction: "Run `factory-setup auth login --config PATH` from an interactive owner terminal.",
      stage: "S08"
    });
  }
  const record: AuthStatusRecord = {
    schema_version: 1,
    authenticated: await authPresence(fsAdapter, config),
    observed_at: new Date().toISOString()
  };
  await writeAtomic(fsAdapter, authStatusPath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export async function readAuthStatus(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<{
  authenticated: boolean;
  quotaHealthy: "unknown";
}> {
  const authenticated = await authPresence(fsAdapter, config);
  const record: AuthStatusRecord = {
    schema_version: 1,
    authenticated,
    observed_at: new Date().toISOString()
  };
  await writeAtomic(fsAdapter, authStatusPath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return {
    authenticated,
    quotaHealthy: "unknown"
  };
}

export async function runSmokeCommand(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  state: SetupState | null,
  options: SmokeOptions
): Promise<{
  provider: "live" | "fake";
  fixture: "toy";
  status: string;
  sourceSha: string;
  consumedCount: number;
}> {
  if (options.fixture !== "toy") {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s08_fixture_unsupported",
      publicMessage: "Only --fixture toy is supported in P08.",
      nextAction: "Run smoke with --fixture toy.",
      stage: "S08"
    });
  }
  const sourceBefore = await toySourceSha(processAdapter, config);
  const previousRecord = await readLiveSmokeRecord(fsAdapter, config);
  const consumedCount = options.provider === "live" ? (previousRecord?.consumed_count ?? 0) + 1 : (previousRecord?.consumed_count ?? 0);
  const runId = `${config.installation_id.slice(0, 8)}-${Date.now()}`;
  if (options.provider === "live") {
    const intent: LiveSmokeIntentRecord = {
      schema_version: 1,
      provider: options.provider,
      fixture: options.fixture,
      attempt: consumedCount,
      started_at: new Date().toISOString()
    };
    await writeAtomic(fsAdapter, liveSmokeIntentPath(config), `${JSON.stringify(intent, null, 2)}\n`, 0o600);
  }

  if (options.provider === "live") {
    if (state === null) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s08_state_required_for_live_smoke",
        publicMessage: "Live smoke requires loaded setup state for gate verification.",
        nextAction: "Run live smoke through the installer CLI with --config PATH.",
        stage: "S08"
      });
    }
    if (!approvedGate(state, LIVE_RISK_GATE_ID) || !approvedGate(state, LIVE_QUOTA_GATE_ID)) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s08_live_gate_required",
        publicMessage: "Live smoke requires explicit risk/quota gate approvals.",
        nextAction: `Approve '${LIVE_RISK_GATE_ID}' and '${LIVE_QUOTA_GATE_ID}' for the active plan hash.`,
        stage: "S08"
      });
    }
    const s07State = state.stages.find((entry) => entry.id === "S07");
    if (s07State?.status !== "verified") {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s08_requires_s07_verified",
        publicMessage: "Live smoke requires S07 offline verification first.",
        nextAction: "Run plan/apply for S07 and confirm status verified.",
        stage: "S08"
      });
    }
  }

  const resultPath = path.join(config.paths.setup_state_dir, `s08-smoke-result-${options.provider}.json`);
  try {
    const payload = await executeRunnerVerify(fsAdapter, processAdapter, config, options, resultPath);
    const sourceAfter = await toySourceSha(processAdapter, config);
    if (sourceBefore !== sourceAfter || payload.source_sha !== sourceAfter) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s08_source_sha_changed",
        publicMessage: "Toy fixture source SHA changed during smoke run.",
        nextAction: "Reset fixture to reviewed state and rerun S06/S07 before smoke.",
        stage: "S08"
      });
    }
    if (payload.status === "turn_failed" || payload.status === "timeout" || payload.status === "cleanup_failed") {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s08_live_status_rejected",
        publicMessage: `Live smoke rejected result status '${payload.status}'.`,
        nextAction: "Inspect runner cleanup/schema handling and rerun with owner approval.",
        stage: "S08"
      });
    }
    if (options.provider === "live" && payload.status !== "needs_review") {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s08_live_expected_needs_review",
        publicMessage: "Live smoke must produce needs_review status in P08.",
        nextAction: "Fix live smoke output contract in reviewed runner release.",
        stage: "S08"
      });
    }
    if (options.provider === "fake" && payload.status !== "runner_ready_offline") {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s07_fake_expected_offline_ready",
        publicMessage: "Fake smoke must report runner_ready_offline status.",
        nextAction: "Fix fake provider fixture result contract in reviewed runner.",
        stage: "S07"
      });
    }
    const trustedEvents = normalizeOfflineEvents(payload.terminal_events);
    if (trustedEvents.length === 0) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s08_terminal_events_untrusted",
        publicMessage: "Runner result does not contain trusted terminal events.",
        nextAction: "Emit trusted terminal events from reviewed runner.",
        stage: "S08"
      });
    }
    const record: LiveSmokeResultRecord = {
      schema_version: 1,
      provider: options.provider,
      fixture: options.fixture,
      status: "needs_review",
      source_sha: sourceAfter,
      consumed_count: Math.max(consumedCount, payload.usage.daily_consumed),
      unknown_usage: false,
      observed_at: new Date().toISOString(),
      run_id: payload.run_id,
      terminal_events: trustedEvents
    };
    if (options.provider === "live") {
      await writeAtomic(fsAdapter, liveSmokePath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
      await fsAdapter.remove(liveSmokeIntentPath(config), { force: true });
    }
    return {
      provider: options.provider,
      fixture: options.fixture,
      status: options.provider === "live" ? "needs_review" : "runner_ready_offline",
      sourceSha: sourceAfter,
      consumedCount: options.provider === "live" ? record.consumed_count : consumedCount
    };
  } catch (error) {
    if (options.provider === "live") {
      await writeUnknownLiveResult(fsAdapter, config, consumedCount, sourceBefore, runId);
    }
    throw error;
  }
}

function statusFromObservation(observation: {
  authenticated: boolean;
  liveSmoke: LiveSmokeResultRecord | null;
  sourceSha: string;
}): StageObservation["status"] {
  if (!observation.authenticated) {
    return "awaiting_manual";
  }
  if (observation.liveSmoke === null) {
    return "awaiting_manual";
  }
  if (observation.liveSmoke.status !== "needs_review") {
    return "blocked";
  }
  if (observation.liveSmoke.unknown_usage) {
    return "blocked";
  }
  if (observation.liveSmoke.source_sha !== observation.sourceSha) {
    return "drifted";
  }
  return "verified";
}

export function createAuthStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): StageModule {
  return {
    id: "S08",
    dependencies: ["S07"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-live-smoke"],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const authenticated = await authPresence(fsAdapter, ctx.config);
      const liveSmoke = await readLiveSmokeRecord(fsAdapter, ctx.config);
      const sourceSha = await toySourceSha(processAdapter, ctx.config);
      return {
        stageId: "S08",
        status: statusFromObservation({ authenticated, liveSmoke, sourceSha }),
        checks: {
          auth_present: authenticated,
          live_smoke_present: liveSmoke !== null,
          live_smoke_unknown_usage: liveSmoke?.unknown_usage ?? true,
          live_smoke_status: liveSmoke?.status ?? "absent"
        },
        versions: {
          live_smoke_source_sha: liveSmoke?.source_sha ?? "absent",
          toy_fixture_source_sha: sourceSha
        },
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      const operations: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s08-auth-smoke-${config.installation_id.slice(0, 12)}`,
              stageId: "S08",
              kind: "manual_gate",
              resourceId: "auth-and-live-smoke",
              risk: "critical",
              gateIds: [LIVE_RISK_GATE_ID, LIVE_QUOTA_GATE_ID],
              preconditions: [
                "explicit_auth_login_required",
                "explicit_live_smoke_required",
                "resume_must_not_replay_live_smoke"
              ],
              sideEffects: [
                "owner performs interactive OAuth via `factory-setup auth login`",
                "owner runs one explicit live smoke via `factory-setup smoke --provider live --fixture toy`"
              ],
              timeoutSec: 300,
              retryable: false
            }
          ];
      return {
        stageId: "S08",
        optional: false,
        requiredCapabilities: ["runner-live-smoke"],
        operations,
        requiredGates: operations.length === 0 ? [] : [LIVE_RISK_GATE_ID, LIVE_QUOTA_GATE_ID]
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const config = ctx.config;
      const authenticated = await authPresence(fsAdapter, config);
      if (!authenticated) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s08_auth_login_required",
          publicMessage: "S08 requires explicit owner OAuth login command.",
          nextAction: "Run `factory-setup auth login --config PATH` in interactive terminal.",
          stage: "S08"
        });
      }
      const liveSmoke = await readLiveSmokeRecord(fsAdapter, config);
      if (liveSmoke === null || liveSmoke.status !== "needs_review") {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s08_live_smoke_required",
          publicMessage: "S08 requires explicit owner-approved live smoke command.",
          nextAction: "Run `factory-setup smoke --config PATH --provider live --fixture toy`.",
          stage: "S08"
        });
      }
      if (liveSmoke.unknown_usage) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s08_usage_unknown_blocked",
          publicMessage: "Live usage is unknown/lost after interruption; S08 remains blocked.",
          nextAction: "Perform owner review, refresh quota evidence, then run a new approved smoke attempt.",
          stage: "S08"
        });
      }
      return [
        {
          operationId: approvedPlan.operations[0]?.id ?? `s08-apply-${ctx.installationId}`,
          stageId: "S08",
          resourceId: "auth-and-live-smoke",
          observedAt: new Date().toISOString(),
          checks: {
            auth_present: true,
            live_smoke_status: liveSmoke.status,
            live_smoke_unknown_usage: liveSmoke.unknown_usage
          },
          versions: {
            live_smoke_source_sha: liveSmoke.source_sha,
            run_id: liveSmoke.run_id
          },
          artifacts: [authStatusPath(config), liveSmokePath(config)]
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const authenticated = await authPresence(fsAdapter, ctx.config);
      const liveSmoke = await readLiveSmokeRecord(fsAdapter, ctx.config);
      const sourceSha = await toySourceSha(processAdapter, ctx.config);
      if (!authenticated || liveSmoke === null || liveSmoke.status !== "needs_review" || liveSmoke.unknown_usage) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s08_not_verified",
          publicMessage: "S08 is not verified: explicit auth/live smoke evidence is incomplete.",
          nextAction: "Run auth login + live smoke commands and re-run verify.",
          stage: "S08"
        });
      }
      if (liveSmoke.source_sha !== sourceSha) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s08_source_drifted",
          publicMessage: "Toy fixture source changed after live smoke evidence.",
          nextAction: "Re-run S07 and then one new approved live smoke.",
          stage: "S08"
        });
      }
      return [
        {
          operationId: "s08-verify",
          stageId: "S08",
          resourceId: "auth-and-live-smoke",
          observedAt: new Date().toISOString(),
          checks: {
            auth_present: true,
            live_smoke_status: liveSmoke.status,
            live_smoke_unknown_usage: liveSmoke.unknown_usage
          },
          versions: {
            live_smoke_source_sha: liveSmoke.source_sha,
            toy_fixture_source_sha: sourceSha
          },
          artifacts: [authStatusPath(ctx.config), liveSmokePath(ctx.config)]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
