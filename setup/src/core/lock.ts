import { randomUUID } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { ExitCode, type SetupConfig } from "./types";
import { setupError } from "./errors";

interface LockOwner {
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
    const currentBootId = await processAdapter.bootId();
    if (existingOwner !== null && (await isStaleOwner(processAdapter, currentBootId, existingOwner))) {
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
      await fsAdapter.remove(paths.lockDir, { recursive: true, force: true });
    }
  };
}

export async function requestCancel(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<string> {
  const cancelPath = path.join(config.paths.setup_state_dir, "cancel-request.json");
  const payload = {
    requested_at: new Date().toISOString(),
    installation_id: config.installation_id
  };
  await fsAdapter.writeText(cancelPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  await fsAdapter.fsyncFile(cancelPath);
  await fsAdapter.fsyncDir(path.dirname(cancelPath));
  return cancelPath;
}

export async function consumeCancelRequest(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<boolean> {
  const cancelPath = path.join(config.paths.setup_state_dir, "cancel-request.json");
  if (!(await fsAdapter.exists(cancelPath))) {
    return false;
  }
  await fsAdapter.remove(cancelPath, { force: true });
  return true;
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
