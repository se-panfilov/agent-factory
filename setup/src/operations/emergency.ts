import path from "node:path";
import { createHash } from "node:crypto";
import { NodeFilesystemAdapter, type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { prepareOfflineCommands, type ApplicationManifestData } from "../adapters/git";
import { ExitCode, type SetupConfig } from "../core/types";
import { validateContractSchema } from "../core/validators";
import { hashConfig, stableStringify } from "../core/config";
import { checkedFile, witnessFile, assertFileWitnesses, checkedJson, type FileWitness } from "../core/plan-context";
import { parseStrictJson } from "../core/strict-json";
import { inspectStateEvidence, receiptHash, readStateCommitManifest } from "../core/state";
import { controlDirectory, controlError, controlJson, ensureControlDirectory, ordinaryOwner, publishControl } from "../core/control-files";

export interface EmergencyDeps { processAdapter: ProcessAdapter; fsAdapter?: FilesystemAdapter }
export interface EmergencyResult { pausedMarkerPath: string; stoppedContainers: string[]; skippedForeignContainers: string[] }
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

export async function emergencyCancel(deps: EmergencyDeps, config: SetupConfig): Promise<EmergencyResult> {
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
  // Inventory is advisory only: the live query always uses the exact installation label.
  const inventoryFile = path.join(config.paths.setup_state_dir, "s11-emergency-inventory.json");
  let docker = false;
  if (await fs.exists(inventoryFile)) {
    const inv = await controlJson(fs, inventoryFile) as Record<string, unknown>;
    if (!inv || Object.keys(inv).sort().join(",") !== "installation_id,owned_container_labels,schema_version,service_unit"
      || inv.schema_version !== 1 || inv.installation_id !== config.installation_id || inv.service_unit !== null
      || !Array.isArray(inv.owned_container_labels) || inv.owned_container_labels.length > 1
      || inv.owned_container_labels.some(label => label !== `agent-factory.installation_id=${config.installation_id}`)) controlError("emergency_inventory_unknown", inventoryFile, "Inventory is foreign, malformed or requires an unsupported service adapter.");
    docker = inv.owned_container_labels.length > 0;
    witnesses.push(await witnessFile(fs, inventoryFile));
  }
  await ensureControlDirectory(fs, config.paths.application_state_dir);
  const paused = path.join(config.paths.application_state_dir, "PAUSED");
  if (await fs.exists(paused)) await checkedFile(fs, paused);
  await assertFileWitnesses(fs, witnesses);
  await publishControl(fs, paused, `${new Date().toISOString()}\n`);
  const stoppedContainers: string[] = [], skippedForeignContainers: string[] = [];
  const run = async (binary: string, args: string[], cwd?: string): Promise<string> => {
    await assertFileWitnesses(fs, witnesses);
    const r = await proc.runCommand({ binary, args, ...(cwd ? { cwd } : {}), timeoutMs: 20_000, maxOutputBytes: 128 * 1024 });
    if (r.exitCode !== 0 || r.timedOut || r.outputLimitExceeded) controlError("emergency_stop_unconfirmed", paused,
      `Emergency boundary failed/unknown; PAUSED retained; confirmed containers=${stoppedContainers.join(",")}.`);
    return r.stdout;
  };
  await run(stop.executable, [...stop.args.slice(0, -1)], root);
  if (status === null) controlError("emergency_postcondition_missing", paused, "Stop attempted; no reviewed status postcondition capability exists. PAUSED retained.");
  const post = await run(status.executable, [...status.args.slice(0, -1)], root);
  // Closed adapter postcondition; exit0 alone does not mean stopped.
  let stopped = false;
  try { const result = parseStrictJson(post) as Record<string, unknown>; stopped = result.status === "stopped" && result.installation_id === config.installation_id; } catch { /* unknown */ }
  if (!stopped) controlError("emergency_postcondition_unknown", paused, "Application stop postcondition is not confirmed. PAUSED retained.");
  if (docker) {
    const text = await run("/usr/bin/docker", ["ps", "-a", "--filter", `label=agent-factory.installation_id=${config.installation_id}`, "--format", "{{.ID}}"]);
    const ids = text.trim() ? text.trim().split("\n") : [];
    if (ids.length > 1024 || new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f]{12,64}$/.test(id))) controlError("emergency_inventory_unknown", paused, "Docker returned an invalid bounded ID inventory.");
    for (const id of ids) {
      const inspect = async () => {
        const raw = await run("/usr/bin/docker", ["inspect", "--format", "{{json .}}", id]);
        try {
          const v = parseStrictJson(raw) as { Id?: string; Config?: { Labels?: Record<string, unknown> }; State?: { Running?: unknown } };
          const label = v.Config?.Labels?.["agent-factory.installation_id"];
          if (v.Id?.startsWith(id) && /^[0-9a-f]{64}$/.test(v.Id) && typeof label === "string"
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(label) && typeof v.State?.Running === "boolean") return { label, running: v.State.Running };
        } catch { /* unknown inspection never becomes foreign */ }
        controlError("emergency_inspection_unknown", paused, "Docker ownership/status inspection is unknown.");
      };
      const before = await inspect();
      if (before.label !== config.installation_id) { skippedForeignContainers.push(id); continue; }
      await run("/usr/bin/docker", ["stop", id]);
      const after = await inspect();
      if (after.label !== config.installation_id || after.running) controlError("emergency_container_stop_unknown", paused, "Owned container stop was not confirmed.");
      stoppedContainers.push(id);
    }
  }
  return { pausedMarkerPath: paused, stoppedContainers, skippedForeignContainers };
}
