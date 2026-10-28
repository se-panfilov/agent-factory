import { randomUUID } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { ExitCode, type SetupConfig, type SetupState } from "./types";
import { validateContractSchema } from "./validators";
import { controlDirectory, controlError, controlJson, ensureControlDirectory, publishControl, ordinaryOwner } from "./control-files";
import { inspectStateEvidence, assertEvidenceAdmission, stateHash } from "./state";

export interface LockOwner {
  boot_id: string;
  pid: number;
  process_start_ticks: number | null;
  nonce: string;
  installation_id: string;
  created_at: string;
}
export interface LockHandle { owner: LockOwner; release(): Promise<void> }
export interface LockPaths { lockDir: string; ownerFile: string }
export function buildLockPaths(config: SetupConfig): LockPaths {
  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  return { lockDir, ownerFile: path.join(lockDir, "owner.json") };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validOwner(value: unknown, installation: string): value is LockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return Object.keys(o).sort().join(",") === "boot_id,created_at,installation_id,nonce,pid,process_start_ticks"
    && typeof o.boot_id === "string" && UUID.test(o.boot_id)
    && typeof o.nonce === "string" && UUID.test(o.nonce)
    && o.installation_id === installation && UUID.test(installation)
    && Number.isSafeInteger(o.pid) && Number(o.pid) > 0 && Number(o.pid) <= 2147483647
    && Number.isSafeInteger(o.process_start_ticks) && Number(o.process_start_ticks) >= 0
    && typeof o.created_at === "string" && o.created_at.length <= 32
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.created_at) && Number.isFinite(Date.parse(o.created_at)) && new Date(o.created_at).toISOString() === o.created_at;
}
async function readOwner(fs: FilesystemAdapter, config: SetupConfig): Promise<LockOwner> {
  const p = buildLockPaths(config);
  try {
    await controlDirectory(fs, p.lockDir);
    const owner = await controlJson(fs, p.ownerFile);
    if (!validOwner(owner, config.installation_id)) throw Error("schema");
    return owner;
  } catch {
    controlError("lock_owner_incomplete", p.ownerFile, "Unknown/unsafe lock owner; automatic takeover is forbidden.", ExitCode.LockOwnedByAnotherInstaller);
  }
}
function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.installation_id === b.installation_id && a.boot_id === b.boot_id && a.pid === b.pid
    && a.process_start_ticks === b.process_start_ticks && a.nonce === b.nonce && a.created_at === b.created_at;
}
export async function lockLiveness(proc: ProcessAdapter, owner: LockOwner): Promise<"alive" | "dead" | "unknown" | "reused" | "boot_changed"> {
  try {
    const boot = await proc.bootId();
    if (!UUID.test(boot)) return "unknown";
    if (boot !== owner.boot_id) return "boot_changed";
    const live = proc.pidLiveness ? proc.pidLiveness(owner.pid) : proc.isPidAlive(owner.pid) ? "alive" : "dead";
    if (live !== "alive") return live;
    const ticks = await proc.processStartTicks(owner.pid);
    if (!Number.isSafeInteger(ticks) || ticks === null || ticks < 0) return "unknown";
    return ticks === owner.process_start_ticks ? "alive" : "reused";
  } catch { return "unknown"; }
}

/** All cooperating mutable-path participants hold this non-reclaiming mutex.
 * Atomic mkdir selects one participant; rename/remove occur ONLY while it is held.
 * A crash leaves it blocked for manual inspection, never guessed stale. */
async function protocol<T>(fs: FilesystemAdapter, config: SetupConfig, action: () => Promise<T>): Promise<T> {
  const root = config.paths.setup_state_dir;
  await ensureControlDirectory(fs, root);
  if (!fs.localLockSemantics || !(await fs.localLockSemantics(root))) {
    controlError("lock_filesystem_unsupported", root, "Known local atomic mkdir/rename semantics are required.");
  }
  const guard = path.join(root, "lock-protocol");
  try { await fs.mkdir(guard, { mode: 0o700 }); }
  catch { controlError("lock_protocol_busy", guard, "Lock protocol is busy or interrupted; preserve its evidence.", ExitCode.LockOwnedByAnotherInstaller); }
  // Failures before the durable guard publication deliberately leave it for manual recovery.
  try {
    await fs.writeText(path.join(guard, "participant.json"), JSON.stringify({ nonce: randomUUID(), pid: process.pid }), 0o600);
    await fs.fsyncFile(path.join(guard, "participant.json"));
    await fs.fsyncDir(guard);
    await fs.fsyncDir(root);
  } catch { return controlError("lock_guard_publication_unconfirmed", guard, "Guard publication failed; manual inspection is required."); }
  try { return await action(); }
  catch (error) {
    if (error && typeof error === "object" && "exitCode" in error) throw error;
    return controlError("lock_transition_unconfirmed", root, "Lock/cancel transition failed; preserve final and temporary evidence.");
  } finally {
    try { await fs.remove(guard, { recursive: true }); await fs.fsyncDir(root); }
    catch { controlError("lock_protocol_cleanup_unconfirmed", guard, "Protocol cleanup is unconfirmed."); }
  }
}
export async function acquireLock(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig): Promise<LockHandle> {
  return protocol(fs, config, async () => {
    const p = buildLockPaths(config);
    if (await fs.exists(p.lockDir)) {
      const owner = await readOwner(fs, config), live = await lockLiveness(proc, owner);
      controlError(live === "alive" ? "duplicate_invocation" : "stale_lock_detected", p.ownerFile,
        `Installation lock is ${live}; explicit resource-aware recovery is required.`, ExitCode.LockOwnedByAnotherInstaller);
    }
    const owner: LockOwner = { boot_id: await proc.bootId(), pid: proc.pid(),
      process_start_ticks: await proc.processStartTicks(proc.pid()), nonce: randomUUID(),
      installation_id: config.installation_id, created_at: new Date().toISOString() };
    if (!validOwner(owner, config.installation_id)) controlError("lock_identity_unknown", p.lockDir, "Own process identity cannot authorize a usable lock.");
    await fs.mkdir(p.lockDir, { mode: 0o700 });
    // An incomplete owner publication remains diagnostic; never auto-delete on failure.
    await fs.writeText(p.ownerFile, `${JSON.stringify(owner, null, 2)}\n`, 0o600);
    await fs.fsyncFile(p.ownerFile);
    await fs.fsyncDir(p.lockDir);
    await fs.fsyncDir(config.paths.setup_state_dir);
    return { owner, release: () => protocol(fs, config, async () => {
      const current = await readOwner(fs, config);
      if (!sameOwner(current, owner)) controlError("lock_owner_changed", p.ownerFile, "Refusing to release a different lock generation.");
      await fs.remove(p.lockDir, { recursive: true });
      await fs.fsyncDir(config.paths.setup_state_dir);
    }) };
  });
}

/** Separate protocol mutex, never the installation lock: cancel remains available during apply. */
export async function requestCancel(fs: FilesystemAdapter, config: SetupConfig, proc: ProcessAdapter): Promise<string> {
  if (!proc) controlError("owner_identity_invalid", config.paths.setup_state_dir,
    "Cancellation requires an explicit process identity.", ExitCode.UnsupportedHostOrMissingPrivileges);
  ordinaryOwner(proc, config);
  return protocol(fs, config, async () => {
    const owner = await readOwner(fs, config);
    if (await lockLiveness(proc, owner) !== "alive") controlError("cancel_run_unproven", buildLockPaths(config).ownerFile, "No proven active matching run can accept cancellation.", ExitCode.LockOwnedByAnotherInstaller);
    const cancel = path.join(config.paths.setup_state_dir, "cancel-request.json");
    await publishControl(fs, cancel, `${JSON.stringify({ schema_version: 2, owner })}\n`);
    return cancel;
  });
}

/** Only the exact historical unbound format is readable without schema_version. */
function recognisedLegacyCancel(raw: Record<string, unknown>): boolean {
  if (Object.keys(raw).sort().join(",") !== "installation_id,requested_at,target_lock_boot_id,target_lock_nonce,target_lock_pid") return false;
  const time = raw.requested_at;
  if (typeof time !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)
    || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time
    || typeof raw.installation_id !== "string" || !UUID.test(raw.installation_id)) return false;
  const unbound = raw.target_lock_boot_id === null && raw.target_lock_nonce === null && raw.target_lock_pid === null;
  const identified = typeof raw.target_lock_boot_id === "string" && UUID.test(raw.target_lock_boot_id)
    && typeof raw.target_lock_nonce === "string" && UUID.test(raw.target_lock_nonce)
    && Number.isSafeInteger(raw.target_lock_pid) && Number(raw.target_lock_pid) > 0 && Number(raw.target_lock_pid) <= 2147483647;
  return unbound || identified;
}

/** Decode a permitted format before deciding whether its generation matches. No writes. */
function decodeCancel(value: unknown): LockOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("cancel object required");
  const raw = value as Record<string, unknown>;
  if (!Object.hasOwn(raw, "schema_version")) {
    if (!recognisedLegacyCancel(raw)) throw Error("unrecognised legacy cancellation");
    return null; // Known legacy metadata never grants authority to cancel a new run.
  }
  if (raw.schema_version !== 2 || Object.keys(raw).sort().join(",") !== "owner,schema_version") {
    throw Error("unsupported version or fields");
  }
  const installation = (raw.owner as Partial<LockOwner> | null)?.installation_id;
  if (typeof installation !== "string" || !validOwner(raw.owner, installation)) throw Error("invalid cancel owner");
  return raw.owner;
}

/** Observation is durable and non-destructive. Valid foreign/stale generations are no-ops. */
export async function consumeCancelRequest(fs: FilesystemAdapter, config: SetupConfig, owner: LockOwner): Promise<boolean> {
  const file = path.join(config.paths.setup_state_dir, "cancel-request.json");
  try {
    await fs.lstat(file); // ENOENT alone proves absence; access errors and broken symlinks are not absence.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    controlError("cancel_evidence_unknown", file, "Cancellation metadata could not be observed safely.");
  }
  try {
    const target = decodeCancel(await controlJson(fs, file));
    return target !== null && sameOwner(target, owner);
  } catch {
    controlError("cancel_evidence_unknown", file,
      "Cancellation evidence has an unknown/invalid format or unsafe metadata; preserve it and reconcile before continuation.");
  }
}

async function noLiveEvidence(fs: FilesystemAdapter, config: SetupConfig): Promise<void> {
  const e = await inspectStateEvidence(fs, config);
  await assertEvidenceAdmission(fs, config, e);
  if (e.quarantineEntries.length || e.journal.oversized || e.journal.parseError || e.journal.unknownOrder
    || e.journal.legacyFormat || e.journal.unresolvedOperationIds.length) controlError("lock_resources_unproven", config.paths.setup_state_dir, "Unresolved operation evidence blocks takeover.");
  const candidate = e.stateExists ? "state.json" : e.previousExists ? "state.json.previous" : null;
  if (candidate) {
    const file = path.join(config.paths.setup_state_dir, candidate);
    const state = await controlJson(fs, file, 1024 * 1024) as SetupState;
    if (!validateContractSchema("state", state).ok || state.installation_id !== config.installation_id || state.in_flight_operation !== null) controlError("lock_resources_unproven", file, "In-flight, malformed or foreign state blocks takeover.");
    const digest = stateHash(state), commit = e.commitManifest;
    if (!commit || (commit.last_state_hash !== digest && !commit.clean_proof?.snapshot_hashes.includes(digest))) controlError("lock_resources_unproven", file, "Candidate has no committed generation proof.");
    if (!e.stateExists && !commit.clean_proof?.snapshot_hashes.includes(digest)) controlError("lock_resources_unproven", file, "Missing primary requires clean candidate proof.");
    // A resolved historical journal is not live. Resource-bearing deployments still need a reconciler.
    if (state.stages.some(stage => ["S03", "S04", "S05", "S08", "S09", "S10", "S12", "S13"].includes(stage.id)
      && !["pending", "planned", "skipped"].includes(stage.status))) controlError("lock_resource_reconciliation_required", file, "Deployment resources need explicit reconciliation before takeover.");
  } else if (e.marker || e.commitManifest || e.journal.hasRecords) {
    controlError("lock_resources_unproven", config.paths.setup_state_dir, "State absence does not prove absence of live resources.");
  }
}

export async function recoverLockOnly(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig): Promise<{ quarantined: boolean; reason: string }> {
  ordinaryOwner(proc, config);
  return protocol(fs, config, async () => {
    const p = buildLockPaths(config);
    if (!(await fs.exists(p.lockDir))) {
      await noLiveEvidence(fs, config);
      return { quarantined: false, reason: "no_lock_present" };
    }
    const owner = await readOwner(fs, config), live = await lockLiveness(proc, owner);
    if (live !== "dead") controlError(live === "alive" ? "lock_owner_active" : "lock_owner_unknown", p.ownerFile,
      `Owner is ${live}; descendant/container reconciliation is required.`, ExitCode.LockOwnedByAnotherInstaller);
    await noLiveEvidence(fs, config);
    const quarantine = `${p.lockDir}.quarantine-${randomUUID()}`;
    // UUID identity plus guard prevents collision by any cooperating participant.
    if (await fs.exists(quarantine)) controlError("lock_quarantine_collision", quarantine, "Quarantine identity already exists.");
    await fs.rename(p.lockDir, quarantine);
    await fs.fsyncDir(config.paths.setup_state_dir);
    return { quarantined: true, reason: quarantine };
  });
}
