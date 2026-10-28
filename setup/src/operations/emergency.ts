import path from "node:path";
import { createHash } from "node:crypto";
import { NodeFilesystemAdapter, type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { prepareOfflineCommands, type ApplicationManifestData } from "../adapters/git";
import { SetupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";
import { validateContractSchema } from "../core/validators";
import { hashConfig, stableStringify } from "../core/config";
import { checkedFile, witnessFile, assertFileWitnesses, checkedJson, type FileWitness } from "../core/plan-context";
import { parseStrictJson } from "../core/strict-json";
import { inspectStateEvidence, receiptHash, readStateCommitManifest } from "../core/state";
import { controlDirectory, controlError, controlJson, ensureControlDirectory, ordinaryOwner, publishControl } from "../core/control-files";

export interface EmergencyDeps { processAdapter: ProcessAdapter; fsAdapter?: FilesystemAdapter }
export interface EmergencyOutcome {
  phase: "pre_admission" | "pause_publication" | "application_stop" | "application_status" | "docker_discovery" | "container_inspect" | "container_stop" | "complete";
  boundary: string | null;
  paused: { path: string; prior: "unknown" | "absent" | "present"; exists: boolean | null;
    publication: "not_attempted" | "not_published" | "published_unconfirmed" | "durable"; prior_preserved: boolean | null };
  attempted: string[];
  confirmed_stopped: string[];
  unknown: string[];
  stopped_containers: string[];
  skipped_foreign_containers: string[];
  advisory_inventory: "absent" | "readable" | "unusable";
  docker_discovery: "not_started" | "unknown" | "verified_empty" | "verified_targets";
  cause_code?: string;
}
export interface EmergencyResult {
  pausedMarkerPath: string;
  stoppedContainers: string[];
  skippedForeignContainers: string[];
  outcome: EmergencyOutcome;
}
export class EmergencyFailure extends SetupError {
  constructor(readonly outcome: EmergencyOutcome, cause: unknown) {
    const known = cause instanceof SetupError ? cause : null;
    const code = known?.code ?? (outcome.phase === "pre_admission" ? "emergency_admission_unknown"
      : outcome.phase === "pause_publication" ? "emergency_pause_unconfirmed" : "emergency_stop_unconfirmed");
    const errno = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "adapter_exception";
    outcome.cause_code = known?.code ?? (["ENOENT", "EIO", "ENOSPC", "EACCES", "EPERM"].includes(errno) ? errno : "adapter_exception");
    super({ exitCode: outcome.phase === "pre_admission" ? known?.exitCode ?? ExitCode.DriftOrRecoveryRequired : ExitCode.DriftOrRecoveryRequired,
      code, stage: "S11", retryable: false,
      publicMessage: known?.message ?? "Emergency boundary could not be confirmed; inspect the recorded outcome.",
      nextAction: outcome.phase === "pre_admission" && known ? known.nextAction
        : "Keep PAUSED and preserve evidence. Manually inspect and reconcile remaining/unknown emergency resources before any further mutation; do not automatically repeat stop.",
      evidenceRef: outcome.phase === "pre_admission" ? known?.evidenceRef ?? "deployment-manifest.json" : outcome.paused.path });
  }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function trustedJson(fs: FilesystemAdapter, file: string, witnesses: FileWitness[]): Promise<unknown> {
  await checkedFile(fs, file);
  const witness = await witnessFile(fs, file);
  const raw = await fs.readTextBounded(file, 1024 * 1024);
  if (raw.truncated || raw.text.includes("\0") || raw.text.includes("\ufffd")) controlError("emergency_input_invalid", file, "Emergency input is oversized or invalid.");
  witnesses.push(witness);
  await assertFileWitnesses(fs, [witness]);
  return parseStrictJson(raw.text);
}

async function admitEmergency(deps: EmergencyDeps, config: SetupConfig) {
  const proc = deps.processAdapter, fs = deps.fsAdapter ?? new NodeFilesystemAdapter();
  ordinaryOwner(proc, config);
  const root = config.paths.application_dir, manifestPath = path.join(root, "deployment-manifest.json");
  if (!(await fs.exists(manifestPath))) controlError("capability_missing", manifestPath, "Trusted stop capability is missing.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  if (config.profile !== "supervised") controlError("emergency_service_unsupported", manifestPath, "A trusted service stop adapter is not implemented.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  await controlDirectory(fs, root);
  const witnesses: FileWitness[] = [];
  const value = await trustedJson(fs, manifestPath, witnesses);
  if (!validateContractSchema("application-manifest", value).ok) controlError("emergency_manifest_invalid", manifestPath, "Raw/invalid manifest is not a trusted stop capability.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  const manifest = value as ApplicationManifestData;
  if (manifest.source_commit !== config.release.source_commit || !manifest.capabilities.includes("runner-readonly")) controlError("emergency_release_identity", manifestPath, "Deployment release identity/capability does not match.");
  const stateEvidence = await inspectStateEvidence(fs, config);
  if (stateEvidence.journal.oversized || stateEvidence.journal.parseError || stateEvidence.journal.unknownOrder || stateEvidence.journal.legacyFormat) {
    controlError("emergency_deployment_unproven", manifestPath, "Deployment journal is malformed or ambiguous.");
  }
  const commit = await readStateCommitManifest(fs, config);
  const proof = commit?.completed_operations?.some(entry => entry.config_hash === hashConfig(config)
    && stateEvidence.journal.receiptBindings?.some(binding => binding.sequence === entry.checkpoint.sequence
      && binding.attemptId === entry.checkpoint.attempt_id && binding.operationId === entry.checkpoint.operation_id
      && binding.stage === "S05" && binding.stateHash === entry.checkpoint.state_hash && binding.receiptHash === receiptHash(entry.receipt))
    && entry.receipt.stageId === "S05" && ["application-checkout", "application-release"].includes(entry.receipt.resourceId)
    && entry.receipt.versions.archive_sha256 === config.release.sha256
    && entry.receipt.versions.source_commit === config.release.source_commit
    && entry.receipt.versions.release_manifest_hash === hash(stableStringify(manifest)));
  if (!proof) controlError("emergency_deployment_unproven", manifestPath, "No journal-bound reviewed deployment receipt proves the current stop capability.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  // Bound current archive and all deployed content to that exact receipt. No probe receipt substitutes for bytes.
  witnesses.push(await witnessFile(fs, config.release.archive_path));
  if (!fs.hashFile || await fs.hashFile(config.release.archive_path, 1024 * 1024 * 1024, 120_000) !== config.release.sha256) controlError("emergency_archive_drift", config.release.archive_path, "Reviewed release artifact changed.");
  if (Object.keys(manifest.content_hashes).length > 4096) controlError("emergency_content_bound", root, "Content inventory exceeds bound.");
  for (const [relative, digest] of Object.entries(manifest.content_hashes)) {
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..")) controlError("emergency_content_path", root, "Content inventory path escapes the release.", ExitCode.SecurityBoundaryViolation);
    const file = path.join(root, relative);
    witnesses.push(await witnessFile(fs, file));
    if (await fs.hashFile(file, 128 * 1024 * 1024, 30_000) !== digest) controlError("emergency_content_drift", file, "Deployed content differs from reviewed bytes.", ExitCode.SecurityBoundaryViolation);
  }
  const stop = prepareOfflineCommands(root, manifest, config).runner_stop;
  // Emergency deliberately accepts only the installed Node adapter, never direct shell/interpreter executables.
  if (stop.kind !== "node" || stop.args.slice(1, -1).some(arg => arg.length > 4096 || path.isAbsolute(arg) || arg.split(/[\\/]/).includes(".."))
    || stop.args.length > 128) controlError("emergency_command_unsafe", manifestPath, "Stop argv is outside the confined Node adapter.", ExitCode.SecurityBoundaryViolation);
  if (!proc.nodeRuntime) controlError("emergency_node_pin_unproven", stop.executable, "Running installed runtime identity is unavailable.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  const runtime = await proc.nodeRuntime();
  await checkedJson(fs, config.version_lock_path, "installer-release");
  const lock = await trustedJson(fs, config.version_lock_path, witnesses) as { node: { version: string; sha256: string } };
  const bootstrapFile = path.join(config.paths.setup_state_dir, "bootstrap-receipt.json");
  const bootstrap = await controlJson(fs, bootstrapFile) as Record<string, unknown>;
  witnesses.push(await witnessFile(fs, bootstrapFile), await witnessFile(fs, stop.executable));
  if (await fs.hashFile(stop.executable, 256 * 1024 * 1024, 30_000) !== runtime.binarySha256
    || runtime.executable !== stop.executable || runtime.version !== lock.node.version
    || bootstrap.node_prefix !== config.paths.setup_node_dir || bootstrap.node_version !== lock.node.version
    || bootstrap.node_sha256 !== lock.node.sha256 || bootstrap.contract_version !== "1.0.0" || bootstrap.stage_id !== "S00") {
    controlError("emergency_node_pin_unproven", stop.executable, "Stop runtime is not the current installed Node pin.", ExitCode.BlockedByMissingCapabilityOrEvidence);
  }
  let status = null;
  if (manifest.capabilities.includes("app-status") && manifest.commands.app_status) {
    status = prepareOfflineCommands(root, { ...manifest, commands: { ...manifest.commands, runner_stop: manifest.commands.app_status } }, config).runner_stop;
    if (status.kind !== "node" || status.args.length > 128 || status.args.slice(1, -1).some(arg => arg.length > 4096 || path.isAbsolute(arg) || arg.split(/[\\/]/).includes(".."))) controlError("emergency_status_unsafe", manifestPath, "Status capability must use the confined Node adapter.");
  }
  return { fs, proc, root, stop, status, witnesses };
}

/** Advisory bytes never select a resource or disable fixed-identity live discovery. */
async function observeInventory(fs: FilesystemAdapter, config: SetupConfig): Promise<EmergencyOutcome["advisory_inventory"]> {
  const file = path.join(config.paths.setup_state_dir, "s11-emergency-inventory.json");
  try {
    try { await fs.lstat(file); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable"; }
    const inv = await controlJson(fs, file) as Record<string, unknown>;
    if (!inv || Object.keys(inv).sort().join(",") !== "installation_id,owned_container_labels,schema_version,service_unit"
      || inv.schema_version !== 1 || inv.installation_id !== config.installation_id || inv.service_unit !== null
      || !Array.isArray(inv.owned_container_labels) || inv.owned_container_labels.length > 1
      || inv.owned_container_labels.some(label => label !== `agent-factory.installation_id=${config.installation_id}`)) return "unusable";
    return "readable";
  } catch { return "unusable"; } // Independent live discovery is still required, never inferred empty.
}

export async function emergencyCancel(deps: EmergencyDeps, config: SetupConfig): Promise<EmergencyResult> {
  const fs = deps.fsAdapter ?? new NodeFilesystemAdapter();
  const paused = path.join(config.paths.application_state_dir, "PAUSED");
  const outcome: EmergencyOutcome = {
    phase: "pre_admission", boundary: null,
    paused: { path: paused, prior: "unknown", exists: null, publication: "not_attempted", prior_preserved: null },
    attempted: [], confirmed_stopped: [], unknown: [], stopped_containers: [], skipped_foreign_containers: [],
    advisory_inventory: "absent", docker_discovery: "not_started"
  };
  let priorIdentity: string | null = null;
  const pauseBody = `${new Date().toISOString()}\n`;
  try {
    const { proc, root, stop, status, witnesses } = await admitEmergency({ ...deps, fsAdapter: fs }, config);
    outcome.advisory_inventory = await observeInventory(fs, config);
    await ensureControlDirectory(fs, config.paths.application_state_dir);
    try {
      await fs.lstat(paused);
      priorIdentity = (await witnessFile(fs, paused)).identity;
      outcome.paused.prior = "present";
      outcome.paused.exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      outcome.paused.prior = "absent";
      outcome.paused.exists = false;
    }
    await assertFileWitnesses(fs, witnesses);
    outcome.phase = "pause_publication";
    outcome.boundary = "PAUSED";
    outcome.paused.publication = "not_published";
    await publishControl(fs, paused, pauseBody, phase => {
      if (phase === "published") outcome.paused.publication = "published_unconfirmed";
      if (phase === "parent_synced") outcome.paused.publication = "durable";
    });
    outcome.paused.exists = true;
    outcome.paused.prior_preserved = false;

    const run = async (binary: string, args: string[], resource: string, mutation: boolean, cwd?: string): Promise<string> => {
      outcome.boundary = resource;
      await assertFileWitnesses(fs, witnesses);
      if (mutation && !outcome.attempted.includes(resource)) outcome.attempted.push(resource);
      const r = await proc.runCommand({ binary, args, ...(cwd ? { cwd } : {}), timeoutMs: 20_000, maxOutputBytes: 128 * 1024 });
      if (r.exitCode !== 0 || r.timedOut || r.outputLimitExceeded) {
        controlError("emergency_stop_unconfirmed", paused, "Emergency command failed or exceeded its execution bounds; cleanup is unconfirmed.");
      }
      return r.stdout;
    };
    const application = `application:${config.installation_id}`;
    outcome.phase = "application_stop";
    await run(stop.executable, [...stop.args.slice(0, -1)], application, true, root);
    outcome.phase = "application_status";
    if (status === null) controlError("emergency_postcondition_missing", paused,
      "Stop attempted; no reviewed status postcondition capability exists. PAUSED retained.");
    const post = await run(status.executable, [...status.args.slice(0, -1)], application, false, root);
    let stopped = false;
    try {
      const result = parseStrictJson(post) as Record<string, unknown>;
      stopped = result.status === "stopped" && result.installation_id === config.installation_id;
    } catch { /* Unknown postcondition cannot confirm an attempted stop. */ }
    if (!stopped) controlError("emergency_postcondition_unknown", paused, "Application stop postcondition is not confirmed. PAUSED retained.");
    outcome.confirmed_stopped.push(application);

    // All supported S05 supervised deployments depend on S04 Docker. No supported Docker-free
    // deployment proof exists. Neither app status nor an absent/empty inventory waives discovery.
    outcome.phase = "docker_discovery";
    outcome.docker_discovery = "unknown";
    const text = await run("/usr/bin/docker", ["ps", "-a", "--filter",
      `label=agent-factory.installation_id=${config.installation_id}`, "--format", "{{.ID}}"], "docker-inventory", false);
    const ids = text.trim() ? text.trim().split("\n") : [];
    if (ids.length > 1024 || new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f]{12,64}$/.test(id))) {
      controlError("emergency_inventory_unknown", paused, "Docker returned an invalid bounded ID inventory.");
    }
    outcome.docker_discovery = ids.length === 0 ? "verified_empty" : "verified_targets";
    for (const id of ids) {
      const resource = `container:${id}`;
      const inspect = async () => {
        outcome.phase = "container_inspect";
        const raw = await run("/usr/bin/docker", ["inspect", "--format", "{{json .}}", id], resource, false);
        try {
          const v = parseStrictJson(raw) as { Id?: string; Config?: { Labels?: Record<string, unknown> }; State?: { Running?: unknown } };
          const label = v.Config?.Labels?.["agent-factory.installation_id"];
          if (v.Id?.startsWith(id) && /^[0-9a-f]{64}$/.test(v.Id) && typeof label === "string"
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(label)
            && typeof v.State?.Running === "boolean") return { label, running: v.State.Running };
        } catch { /* Unknown inspection never becomes foreign. */ }
        controlError("emergency_inspection_unknown", paused, "Docker ownership/status inspection is unknown.");
      };
      const before = await inspect();
      if (before.label !== config.installation_id) { outcome.skipped_foreign_containers.push(id); continue; }
      outcome.phase = "container_stop";
      await run("/usr/bin/docker", ["stop", id], resource, true);
      const after = await inspect();
      if (after.label !== config.installation_id || after.running) {
        controlError("emergency_container_stop_unknown", paused, "Owned container stop was not confirmed.");
      }
      outcome.stopped_containers.push(id);
      outcome.confirmed_stopped.push(resource);
    }
    outcome.phase = "complete";
    outcome.boundary = null;
    return { pausedMarkerPath: paused, stoppedContainers: outcome.stopped_containers,
      skippedForeignContainers: outcome.skipped_foreign_containers, outcome };
  } catch (error) {
    if (outcome.phase !== "pre_admission") {
      // A rename adapter can reject after performing the syscall. Observe actual bytes/identity;
      // do not mistake mere existence (or an old PAUSED) for a newly durable publication.
      outcome.paused.exists = null;
      try {
        await fs.lstat(paused);
        const witness = await witnessFile(fs, paused);
        outcome.paused.exists = true;
        outcome.paused.prior_preserved = witness.identity === priorIdentity;
        if (outcome.paused.publication !== "durable" && witness.identity !== priorIdentity) {
          const raw = await fs.readTextBounded(paused, 4096);
          if (!raw.truncated && raw.text === pauseBody) outcome.paused.publication = "published_unconfirmed";
        }
      } catch (observationError) {
        if ((observationError as NodeJS.ErrnoException).code === "ENOENT") outcome.paused.exists = false;
        // Metadata/read failure leaves existence unknown, never a claim of cleanup.
      }
      if (outcome.boundary) outcome.unknown.push(outcome.boundary);
    }
    throw new EmergencyFailure(outcome, error);
  }
}
