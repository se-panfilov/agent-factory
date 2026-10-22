import path from "node:path";
import { promises as fs } from "node:fs";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";
import { type BackupDeps, resolveServiceDbPath, verifyBackup } from "./backup";

export interface RestoreDeps extends BackupDeps {
  fsAdapter: FilesystemAdapter;
  processAdapter: ProcessAdapter;
}

export interface RestoreResult {
  backupId: string;
  stagingPath: string;
  restoredPaths: string[];
}

function restoreRoot(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "restore");
}

function containsPathSegment(value: string, segment: string): boolean {
  return value.split(path.sep).includes(segment);
}

async function ensurePathNotSymlink(targetPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s11_restore_symlink_target",
        publicMessage: "Restore target contains a symlink and cannot be overwritten safely.",
        nextAction: "Replace symlink target with a regular directory and rerun restore.",
        stage: "S11",
        evidenceRef: targetPath
      });
    }
  } catch {
    return;
  }
}

async function copyTree(sourceDir: string, destinationDir: string): Promise<void> {
  try {
    const stat = await fs.stat(sourceDir);
    if (!stat.isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  await fs.mkdir(destinationDir, { recursive: true, mode: 0o700 });
  const queue = [sourceDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      continue;
    }
    for (const name of await fs.readdir(current)) {
      const sourcePath = path.join(current, name);
      const rel = path.relative(sourceDir, sourcePath);
      const destPath = path.join(destinationDir, rel);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink()) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "s11_restore_symlink_payload",
          publicMessage: "Restore payload contains symlink entries and was refused.",
          nextAction: "Recreate backup from trusted regular files only.",
          stage: "S11",
          evidenceRef: sourcePath
        });
      }
      if (stat.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true, mode: 0o700 });
        queue.push(sourcePath);
      } else if (stat.isFile()) {
        await fs.mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
        await fs.copyFile(sourcePath, destPath);
      }
    }
  }
}

async function writePausedMarker(config: SetupConfig): Promise<void> {
  const pausedPath = path.join(config.paths.application_state_dir, "PAUSED");
  await fs.mkdir(path.dirname(pausedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(pausedPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
}

function mergeUnknownUsage(currentPayload: unknown, restoredPayload: unknown): Record<string, unknown> {
  const current = typeof currentPayload === "object" && currentPayload !== null && !Array.isArray(currentPayload)
    ? currentPayload as Record<string, unknown>
    : {};
  const restored = typeof restoredPayload === "object" && restoredPayload !== null && !Array.isArray(restoredPayload)
    ? restoredPayload as Record<string, unknown>
    : {};
  const currentUsage = typeof current.usage === "object" && current.usage !== null && !Array.isArray(current.usage)
    ? current.usage as Record<string, unknown>
    : {};
  const restoredUsage = typeof restored.usage === "object" && restored.usage !== null && !Array.isArray(restored.usage)
    ? restored.usage as Record<string, unknown>
    : {};
  const currentCount = typeof currentUsage.daily_consumed === "number" ? currentUsage.daily_consumed : 0;
  const restoredCount = typeof restoredUsage.daily_consumed === "number" ? restoredUsage.daily_consumed : 0;
  return {
    ...restored,
    unknown_usage: true,
    usage: {
      ...restoredUsage,
      daily_consumed: Math.max(currentCount, restoredCount)
    }
  };
}

async function preserveUnknownUsage(config: SetupConfig, stagingStateDir: string): Promise<void> {
  const currentPath = path.join(config.paths.application_state_dir, "live-smoke.json");
  const stagedPath = path.join(stagingStateDir, "live-smoke.json");
  let currentPayload: unknown = {};
  let stagedPayload: unknown = {};
  try {
    currentPayload = JSON.parse(await fs.readFile(currentPath, "utf8"));
  } catch {
    currentPayload = {};
  }
  try {
    stagedPayload = JSON.parse(await fs.readFile(stagedPath, "utf8"));
  } catch {
    stagedPayload = {};
  }
  const merged = mergeUnknownUsage(currentPayload, stagedPayload);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(stagedPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function restoreBackup(
  deps: RestoreDeps,
  config: SetupConfig,
  backupId: string
): Promise<RestoreResult> {
  const verified = await verifyBackup(deps, config, backupId);
  const stagingBase = restoreRoot(config);
  const stagingPath = path.join(stagingBase, `${verified.backupId}-staging`);
  await fs.rm(stagingPath, { recursive: true, force: true });
  await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });

  const payloadRoot = path.join(verified.backupPath, "payload");
  const stagedState = path.join(stagingPath, "state");
  const stagedManifest = path.join(stagingPath, "deployment-manifest.json");
  const stagedPolicy = path.join(stagingPath, "policy-level1.json");
  const stagedDb = path.join(stagingPath, "service-state");

  await copyTree(path.join(payloadRoot, "state"), stagedState);
  if (await fs.stat(path.join(payloadRoot, "deployment-manifest.json")).then((item) => item.isFile()).catch(() => false)) {
    await fs.mkdir(path.dirname(stagedManifest), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(payloadRoot, "deployment-manifest.json"), stagedManifest);
  }
  if (await fs.stat(path.join(payloadRoot, "policy-level1.json")).then((item) => item.isFile()).catch(() => false)) {
    await fs.mkdir(path.dirname(stagedPolicy), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(payloadRoot, "policy-level1.json"), stagedPolicy);
  }
  await copyTree(path.join(payloadRoot, "service-state"), stagedDb);
  await preserveUnknownUsage(config, stagedState);

  const restoredPaths: string[] = [];
  await ensurePathNotSymlink(config.paths.application_state_dir);
  await ensurePathNotSymlink(config.paths.application_dir);

  const authGuard = containsPathSegment(config.paths.application_auth_dir, "auth");
  if (!authGuard) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s11_auth_path_unexpected",
      publicMessage: "Auth path is not recognized as protected auth directory.",
      nextAction: "Fix config auth path before restore.",
      stage: "S11",
      evidenceRef: config.paths.application_auth_dir
    });
  }

  await copyTree(stagedState, config.paths.application_state_dir);
  restoredPaths.push(config.paths.application_state_dir);

  if (await fs.stat(stagedManifest).then((item) => item.isFile()).catch(() => false)) {
    await fs.copyFile(stagedManifest, path.join(config.paths.application_dir, "deployment-manifest.json"));
    restoredPaths.push(path.join(config.paths.application_dir, "deployment-manifest.json"));
  }

  if (await fs.stat(stagedPolicy).then((item) => item.isFile()).catch(() => false)) {
    await fs.copyFile(stagedPolicy, path.join(config.paths.application_dir, "policy-level1.json"));
    restoredPaths.push(path.join(config.paths.application_dir, "policy-level1.json"));
  }

  const dbSource = path.join(stagedDb, "factory.sqlite3");
  if (await fs.stat(dbSource).then((item) => item.isFile()).catch(() => false)) {
    const dbTarget = resolveServiceDbPath();
    await fs.mkdir(path.dirname(dbTarget), { recursive: true, mode: 0o700 });
    await fs.copyFile(dbSource, dbTarget);
    restoredPaths.push(dbTarget);
  }

  await writePausedMarker(config);

  return {
    backupId: verified.backupId,
    stagingPath,
    restoredPaths
  };
}
