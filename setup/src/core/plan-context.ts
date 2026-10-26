import { parseStrictJson } from "./strict-json";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { validateContractSchema } from "./validators";
import { canonicalHash } from "./plan-format";
import { stableStringify } from "./config";
import { setupError } from "./errors";
import { ExitCode, type InstallerPlan, type SetupConfig, type SetupState, type StageId } from "./types";
import { createHash } from "node:crypto";

export const REVIEW_KEY = "setup_plan_review_v1";
export type StaticPlanContext = Pick<InstallerPlan, "host_fingerprint" | "owner_session" | "version_lock_hash" | "release_context">;
function refuse(code: string, message: string, exitCode = ExitCode.DriftOrRecoveryRequired): never {
  throw setupError({ exitCode, code, publicMessage: message, nextAction: "Revalidate this host/owner session and artifacts, then explicitly generate, review and approve a fresh plan. Preserve existing progress evidence." });
}
export async function checkedFile(fs: FilesystemAdapter, file: string): Promise<void> {
  if (!path.isAbsolute(file) || file.includes("\0") || file.split(path.sep).some(part => part === "." || part === "..")) refuse("context_path_unsafe", "Context input path is not canonical.", ExitCode.SecurityBoundaryViolation);
  let current = file, first = true;
  for (let depth = 0; depth < 64; depth++) {
    const stat = await fs.lstat(current);
    const stickyRoot = !first && Number(stat.uid) === 0 && (Number(stat.mode) & 0o1000) !== 0;
    const uid = Number(stat.uid);
    const owned = uid === 0 || uid === (typeof process.getuid === "function" ? process.getuid() : -1);
    if (!owned || stat.isSymbolicLink() || (first ? !stat.isFile() : !stat.isDirectory()) || ((Number(stat.mode) & 0o022) !== 0 && !stickyRoot)) {
      refuse("context_file_unsafe", "Context input has unsafe type, symlink or writable metadata.", ExitCode.SecurityBoundaryViolation);
    }
    const parent = path.dirname(current); if (parent === current) return;
    first = false; current = parent;
  }
  refuse("context_path_depth", "Context path exceeds the bounded ancestor inventory.", ExitCode.SecurityBoundaryViolation);
}
export async function checkedJson(fs: FilesystemAdapter, file: string, schema: "installer-release"): Promise<string> {
  try {
    await checkedFile(fs, file);
    const before = await fs.lstat(file);
    const raw = await fs.readTextBounded(file, 1024 * 1024);
    const after = await fs.lstat(file);
    if (raw.truncated || raw.text.includes("\ufffd") || raw.text.includes("\0") || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) refuse("version_lock_changed_during_read", "Version lock changed or exceeded bounded UTF-8 input.");
    const parsed: unknown = parseStrictJson(raw.text);
    if (!validateContractSchema(schema, parsed).ok) refuse("version_lock_invalid", "Reviewed version lock fails its strict schema.");
    return createHash("sha256").update(raw.text).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "exitCode" in error) throw error;
    refuse("version_lock_unavailable", "The actual reviewed version lock is missing or unreadable/invalid.");
  }
}
async function captureContext(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig, closure: readonly StageId[], witnesses?: FileWitness[]): Promise<StaticPlanContext> {
  if (!Number.isInteger(proc.uid()) || proc.uid() <= 0 || proc.uid() > 4294967294 || proc.username() !== config.host.expected_user) refuse("context_owner_required", "Plan creation/approval/execution requires the ordinary configured owner.", ExitCode.UnsupportedHostOrMissingPrivileges);
  if (!proc.hostIdentity || !proc.loginSessionId) refuse("context_identity_adapter_unavailable", "OS host and owner-session identity are not available.", ExitCode.UnsupportedHostOrMissingPrivileges);
  const actual = await proc.hostIdentity();
  const machine = await proc.machineIdHash(), boot = await proc.bootId(), login = await proc.loginSessionId();
  if (actual.os !== config.host.os || actual.arch !== config.host.arch) refuse("context_host_mismatch", "Actual OS/architecture differs from reviewed configuration.");
  if (!/^[0-9a-f]{64}$/.test(machine) || machine === createHash("sha256").update("unknown-machine-id").digest("hex") || /^0+$/.test(machine)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(boot) || !login || login.startsWith("unknown") || login.length > 256) refuse("context_identity_invalid", "A checked machine, boot and login-session identity is required.");
  const lockWitness = await witnessFile(fs, config.version_lock_path);
  const version_lock_hash = await checkedJson(fs, config.version_lock_path, "installer-release");
  witnesses?.push(lockWitness);
  const applicable = closure.some(id => ["S05", "S06", "S07", "S09", "S10", "S11", "S13"].includes(id));
  let artifact_hash: string | null = null;
  if (applicable) {
    try {
      const archiveWitness = await witnessFile(fs, config.release.archive_path);
      witnesses?.push(archiveWitness);
      if (!fs.hashFile) refuse("context_artifact_reader_unavailable", "Bounded release artifact hashing is unavailable.");
      artifact_hash = await fs.hashFile(config.release.archive_path, 1024 * 1024 * 1024, 120_000);
      if (artifact_hash !== config.release.sha256) refuse("context_release_integrity", "Current release bytes do not match the declared reviewed artifact.", ExitCode.SecurityBoundaryViolation);
    } catch (error) {
      if (error && typeof error === "object" && "exitCode" in error) throw error;
      refuse("context_release_unavailable", "Applicable release artifact cannot be safely hashed.");
    }
  }
  return { host_fingerprint: { machine_id_hash: machine, os: actual.os, arch: actual.arch },
    owner_session: { uid: proc.uid(), owner: proc.username(), boot_id: boot, login_session_hash: canonicalHash({ uid: proc.uid(), login, boot }) },
    version_lock_hash, release_context: { applicable, declared_hash: canonicalHash(config.release), artifact_hash } };
}
export function reviewContextHash(plan: InstallerPlan): string {
  return canonicalHash({ host: plan.host_fingerprint, session: plan.owner_session, lock: plan.version_lock_hash,
    release: plan.release_context, desired: plan.desired_hash, observations: plan.observations_hash, target: plan.target, scope: plan.stage_scope });
}
export function publishReview(state: SetupState, plan: InstallerPlan, phase: "prepared" | "committed" = "committed"): SetupState {
  const raw = JSON.stringify({ version: 1, phase, plan_hash: plan.plan_hash, context_hash: reviewContextHash(plan) });
  return { ...state, stages: state.stages.map(stage => stage.id === "S00" ? { ...stage, versions: { ...stage.versions, [REVIEW_KEY]: raw } } : stage) };
}
export function assertReview(state: SetupState, plan: InstallerPlan, current: StaticPlanContext): SetupState {
  if (stableStringify(state.host_fingerprint.machine_id_hash) !== stableStringify(current.host_fingerprint.machine_id_hash)
    || state.host_fingerprint.os !== current.host_fingerprint.os || state.host_fingerprint.arch !== current.host_fingerprint.arch) refuse("context_foreign_host", "State belongs to another physical host or OS/architecture.");
  if (stableStringify(plan.host_fingerprint) !== stableStringify(current.host_fingerprint)) refuse("context_foreign_host", "Plan belongs to another physical host.");
  if (stableStringify(plan.owner_session) !== stableStringify(current.owner_session)) refuse("context_session_changed", "The reviewed boot/login owner session has ended.", ExitCode.ManualActionRequired);
  if (plan.version_lock_hash !== current.version_lock_hash) refuse("context_version_lock_drift", "Reviewed version-lock bytes changed at the same path.");
  if (stableStringify(plan.release_context) !== stableStringify(current.release_context)) refuse("context_release_drift", "Reviewed release identity or artifact changed.");
  const raw = state.stages.find(stage => stage.id === "S00")?.versions[REVIEW_KEY];
  try {
    if (!raw || Buffer.byteLength(raw) > 4096) throw Error("review absent/oversized");
    const record: unknown = parseStrictJson(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) throw Error("review shape");
    const r = record as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "context_hash,phase,plan_hash,version" || r.version !== 1
      || r.plan_hash !== plan.plan_hash || r.context_hash !== reviewContextHash(plan) || !["prepared", "committed"].includes(String(r.phase))) throw Error("review binding");
    if (r.phase !== "committed") throw Error("prepared review is not authorization");
    return state;
  } catch { refuse("context_review_unproven", "Current submitted plan/context has no matching committed producer review."); }
}

/** Per-admission, nonpersistent evidence. No cache and no executable authorization by itself. */
export interface FileWitness { path: string; identity: string }
export interface ContextCapture { context: StaticPlanContext; files: FileWitness[] }
function fileIdentity(stat: Awaited<ReturnType<FilesystemAdapter["lstat"]>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid, stat.gid, stat.nlink,
    stat.isFile(), stat.isSymbolicLink()].join(":");
}
export async function witnessFile(fs: FilesystemAdapter, file: string): Promise<FileWitness> {
  try {
    await checkedFile(fs, file);
    return { path: file, identity: fileIdentity(await fs.lstat(file)) };
  } catch (error) {
    if (error && typeof error === "object" && "exitCode" in error) throw error;
    refuse("admission_input_unavailable", "An input disappeared or became unreadable during final admission.");
  }
}
/** Final bounded metadata fence, after all content/identity reads; never hashes an archive twice. */
export async function assertFileWitnesses(fs: FilesystemAdapter, files: readonly FileWitness[]): Promise<void> {
  const current = await Promise.all(files.map(file => witnessFile(fs, file.path)));
  if (current.some((file, index) => file.identity !== files[index]!.identity)) {
    refuse("admission_file_changed", "An input file identity/metadata changed during final admission.");
  }
}
export async function capturePlanContext(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig, closure: readonly StageId[]): Promise<StaticPlanContext> {
  return captureContext(fs, proc, config, closure);
}
export async function captureContextEvidence(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig, closure: readonly StageId[]): Promise<ContextCapture> {
  const files: FileWitness[] = [];
  const context = await captureContext(fs, proc, config, closure, files);
  return { context, files };
}
/** Revalidate bounded inputs read before expensive hashing/probes. No archive reread. */
export async function revalidateContextEvidence(fs: FilesystemAdapter, proc: ProcessAdapter, config: SetupConfig, capture: ContextCapture): Promise<void> {
  const owner = { uid: proc.uid(), owner: proc.username(), boot_id: await proc.bootId(), login: await proc.loginSessionId() };
  if (owner.uid <= 0 || owner.owner !== config.host.expected_user) refuse("context_owner_required", "Ordinary configured owner is required.", ExitCode.UnsupportedHostOrMissingPrivileges);
  const actual = { host_fingerprint: { machine_id_hash: await proc.machineIdHash(), ...await proc.hostIdentity() },
    owner_session: { uid: owner.uid, owner: owner.owner, boot_id: owner.boot_id, login_session_hash: canonicalHash({uid:owner.uid,login:owner.login,boot:owner.boot_id}) } };
  if (stableStringify(actual.host_fingerprint) !== stableStringify(capture.context.host_fingerprint)) refuse("context_foreign_host", "Physical host identity changed during admission.");
  if (stableStringify(actual.owner_session) !== stableStringify(capture.context.owner_session)) refuse("context_session_changed", "Owner login/boot changed during admission.", ExitCode.ManualActionRequired);
  if (await checkedJson(fs, config.version_lock_path, "installer-release") !== capture.context.version_lock_hash) {
    refuse("context_version_lock_drift", "Version lock changed during final context hashing/probes.");
  }
}
