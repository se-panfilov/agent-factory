import path from "node:path";
import { randomUUID } from "node:crypto";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { type SetupConfig, ExitCode } from "./types";
import { setupError } from "./errors";
import { checkedFile, witnessFile, assertFileWitnesses } from "./plan-context";
import { parseStrictJson } from "./strict-json";

export function controlError(code: string, evidenceRef: string, message: string, exitCode = ExitCode.DriftOrRecoveryRequired): never {
  throw setupError({ exitCode, code, publicMessage: message,
    nextAction: "Preserve control evidence; reconcile ownership/resources manually before retrying.", evidenceRef });
}
export function ordinaryOwner(proc: ProcessAdapter, config: SetupConfig): void {
  if (!Number.isSafeInteger(proc.uid()) || proc.uid() <= 0 || proc.uid() > 4294967294 || proc.username() !== config.host.expected_user) {
    controlError("owner_identity_invalid", config.paths.setup_state_dir, "An ordinary configured owner is required.", ExitCode.UnsupportedHostOrMissingPrivileges);
  }
}

/** FS identity belongs to the filesystem adapter's OS process, distinct from injected application identity in tests. */
export async function controlDirectory(fs: FilesystemAdapter, dir: string): Promise<void> {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) controlError("control_path_unsafe", dir, "Noncanonical control path.");
  let current = dir;
  for (let depth = 0; depth < 64; depth++) {
    const st = await fs.lstat(current);
    const actualUid = process.getuid?.() ?? -1;
    const stickyAncestor = current !== dir && st.uid === 0 && (Number(st.mode) & 0o1000) !== 0;
    if (!st.isDirectory() || st.isSymbolicLink() || (current === dir ? st.uid !== actualUid : st.uid !== 0 && st.uid !== actualUid)
      || ((Number(st.mode) & 0o022) !== 0 && !stickyAncestor)) controlError("control_directory_unsafe", current, "Unsafe control directory ownership/type/mode.");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  controlError("control_path_unsafe", dir, "Control path is too deep.");
}
export async function ensureControlDirectory(fs: FilesystemAdapter, dir: string): Promise<void> {
  // Validate existing ancestors before recursive mkdir can follow a symlink.
  let existing = dir;
  while (!(await fs.exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) controlError("control_path_unavailable", dir, "No safe control ancestor.");
    existing = parent;
  }
  await controlDirectory(fs, existing);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await controlDirectory(fs, dir);
}
export async function controlJson(fs: FilesystemAdapter, file: string, limit = 4096): Promise<unknown> {
  await checkedFile(fs, file);
  const stat = await fs.lstat(file);
  if (stat.uid !== (process.getuid?.() ?? -1) || stat.nlink !== 1 || stat.size > limit || (Number(stat.mode) & 0o077) !== 0) {
    controlError("control_file_unsafe", file, "Control file metadata is unsafe.");
  }
  const witness = await witnessFile(fs, file);
  const raw = await fs.readTextBounded(file, limit);
  if (raw.truncated || raw.text.includes("\0") || raw.text.includes("\ufffd")) controlError("control_file_invalid", file, "Control input exceeds bounded UTF-8 schema.");
  await assertFileWitnesses(fs, [witness]);
  return parseStrictJson(raw.text);
}

/** Unique private temp directory reserves the publication name without overwriting another writer's temp. */
export async function publishControl(fs: FilesystemAdapter, file: string, body: string): Promise<void> {
  if (Buffer.byteLength(body) > 1024 * 1024) controlError("control_output_oversized", file, "Control publication exceeds bound.");
  const parent = path.dirname(file);
  await controlDirectory(fs, parent);
  const temp = path.join(parent, `.publish-${randomUUID()}`);
  await fs.mkdir(temp, { mode: 0o700 });
  const payload = path.join(temp, "payload");
  // On any failure keep the temp and/or final name as crash evidence. No destructive rollback.
  await fs.writeText(payload, body, 0o600);
  await fs.fsyncFile(payload);
  await fs.rename(payload, file);
  await fs.fsyncDir(parent);
  await fs.remove(temp, { recursive: true });
  await fs.fsyncDir(parent);
}
