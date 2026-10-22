import { randomUUID } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { ExitCode, type SetupConfig } from "./types";
import { setupError } from "./errors";

export interface LockOwner {
  boot_id: string;
  pid: number;
  process_start_ticks: number | null;
  nonce: string;
  installation_id: string;
  created_at: string;
}

export interface LockHandle {
  owner: LockOwner;
  release(): Promise<void>;
}

export interface LockPaths {
  lockDir: string;
  ownerFile: string;
}

export function buildLockPaths(config: SetupConfig): LockPaths {
  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  return {
    lockDir,
    ownerFile: path.join(lockDir, "owner.json")
  };
}

async function readExistingOwner(fsAdapter: FilesystemAdapter, ownerFile: string): Promise<LockOwner | null> {
  try {
    const raw = await fsAdapter.readText(ownerFile);
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function ownerIdentityMatches(left: LockOwner, right: LockOwner): boolean {
  return left.nonce === right.nonce
    && left.pid === right.pid
    && left.boot_id === right.boot_id
    && left.installation_id === right.installation_id;
}

async function isStaleOwner(
  processAdapter: ProcessAdapter,
  currentBootId: string,
  owner: LockOwner
): Promise<boolean> {
  if (owner.boot_id !== currentBootId) {
    return true;
  }
  if (!processAdapter.isPidAlive(owner.pid)) {
    return true;
  }
  const observedStartTicks = await processAdapter.processStartTicks(owner.pid);
  return observedStartTicks !== owner.process_start_ticks;
}

export async function acquireLock(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<LockHandle> {
  const paths = buildLockPaths(config);
  try {
    await fsAdapter.mkdir(paths.lockDir, { recursive: false, mode: 0o700 });
  } catch {
    const existingOwner = await readExistingOwner(fsAdapter, paths.ownerFile);
    if (existingOwner === null) {
      throw setupError({
        exitCode: ExitCode.LockOwnedByAnotherInstaller,
        code: "lock_owner_missing",
        publicMessage: "Lock directory exists without valid owner metadata.",
        nextAction: "Run 'factory-setup recover --config PATH --lock-only' before retrying.",
        evidenceRef: paths.lockDir
      });
    }
    const currentBootId = await processAdapter.bootId();
    if (await isStaleOwner(processAdapter, currentBootId, existingOwner)) {
      throw setupError({
        exitCode: ExitCode.LockOwnedByAnotherInstaller,
        code: "stale_lock_detected",
        publicMessage: "Lock owner appears stale; recover is required before apply/resume.",
        nextAction: "Run 'factory-setup recover --config PATH --lock-only'.",
        evidenceRef: paths.ownerFile
      });
    }

    throw setupError({
      exitCode: ExitCode.LockOwnedByAnotherInstaller,
      code: "duplicate_invocation",
      publicMessage: "Another installer process currently owns the installation lock.",
      nextAction: "Wait for the other process to finish or run cancel/recover if needed.",
      evidenceRef: paths.ownerFile
    });
  }

  const owner: LockOwner = {
    boot_id: await processAdapter.bootId(),
    pid: processAdapter.pid(),
    process_start_ticks: await processAdapter.processStartTicks(processAdapter.pid()),
    nonce: randomUUID(),
    installation_id: config.installation_id,
    created_at: new Date().toISOString()
  };
  await fsAdapter.writeText(paths.ownerFile, `${JSON.stringify(owner, null, 2)}\n`, 0o600);
  await fsAdapter.fsyncFile(paths.ownerFile);
  await fsAdapter.fsyncDir(paths.lockDir);

  return {
    owner,
    release: async () => {
      const currentOwner = await readExistingOwner(fsAdapter, paths.ownerFile);
      if (currentOwner === null || !ownerIdentityMatches(currentOwner, owner)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "lock_owner_changed",
          publicMessage: "Lock ownership changed unexpectedly; refusing to release foreign lock.",
          nextAction: "Run lock-only recovery and inspect lock quarantine.",
          evidenceRef: paths.ownerFile
        });
      }
      await fsAdapter.remove(paths.lockDir, { recursive: true, force: true });
    }
  };
}

export async function requestCancel(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<string> {
  const cancelPath = path.join(config.paths.setup_state_dir, "cancel-request.json");
  const owner = await readExistingOwner(fsAdapter, buildLockPaths(config).ownerFile);
  const payload = {
    requested_at: new Date().toISOString(),
    installation_id: config.installation_id,
    target_lock_nonce: owner?.nonce ?? null,
    target_lock_pid: owner?.pid ?? null,
    target_lock_boot_id: owner?.boot_id ?? null
  };
  await fsAdapter.writeText(cancelPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  await fsAdapter.fsyncFile(cancelPath);
  await fsAdapter.fsyncDir(path.dirname(cancelPath));
  return cancelPath;
}

export async function consumeCancelRequest(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  owner: LockOwner
): Promise<boolean> {
  const cancelPath = path.join(config.paths.setup_state_dir, "cancel-request.json");
  if (!(await fsAdapter.exists(cancelPath))) {
    return false;
  }
  try {
    const payload = JSON.parse(await fsAdapter.readText(cancelPath)) as {
      installation_id?: unknown;
      target_lock_nonce?: unknown;
      target_lock_pid?: unknown;
      target_lock_boot_id?: unknown;
    };
    const matchesInstallation = payload.installation_id === config.installation_id;
    const matchesNonce = payload.target_lock_nonce === owner.nonce;
    const matchesPid = payload.target_lock_pid === owner.pid;
    const matchesBoot = payload.target_lock_boot_id === owner.boot_id;
    if (matchesInstallation && matchesNonce && matchesPid && matchesBoot) {
      await fsAdapter.remove(cancelPath, { force: true });
      return true;
    }
  } catch {
    // stale/corrupt cancel requests are ignored by new runs.
  }
  return false;
}

export async function recoverLockOnly(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<{ quarantined: boolean; reason: string }> {
  const paths = buildLockPaths(config);
  if (!(await fsAdapter.exists(paths.lockDir))) {
    return { quarantined: false, reason: "no_lock_present" };
  }

  const owner = await readExistingOwner(fsAdapter, paths.ownerFile);
  const currentBootId = await processAdapter.bootId();
  if (owner !== null && !(await isStaleOwner(processAdapter, currentBootId, owner))) {
    throw setupError({
      exitCode: ExitCode.LockOwnedByAnotherInstaller,
      code: "lock_owner_active",
      publicMessage: "Lock owner is still active; lock-only recover refused.",
      nextAction: "Use cancel and wait for the process to finish.",
      evidenceRef: paths.ownerFile
    });
  }

  const quarantine = `${paths.lockDir}.quarantine-${Date.now()}`;
  await fsAdapter.rename(paths.lockDir, quarantine);
  return { quarantined: true, reason: quarantine };
}
