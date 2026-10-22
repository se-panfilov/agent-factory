import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";
import { validateContractSchema } from "../core/validators";

const BACKUP_RETENTION_DAYS = 14;
const DEFAULT_SERVICE_DB_PATH = "/var/lib/agent-factory/state/factory.sqlite3";

export interface BackupEntry {
  source: string;
  archive_path: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  schema_version: 1;
  stage: "S11";
  backup_id: string;
  installation_id: string;
  created_at: string;
  profile: "supervised" | "service";
  includes_service_db: boolean;
  state_paused_present: boolean;
  unknown_usage_observed: boolean;
  excluded_paths: string[];
  entries: BackupEntry[];
}

export interface BackupCreateResult {
  backupId: string;
  backupPath: string;
  manifestPath: string;
  retainedLatestGood: string | null;
  pruned: string[];
}

export interface BackupVerifyResult {
  backupId: string;
  backupPath: string;
  manifestPath: string;
  unknownUsageObserved: boolean;
}

export interface BackupDeps {
  fsAdapter: FilesystemAdapter;
  processAdapter: ProcessAdapter;
  now(): Date;
}

interface ServiceCapabilityStatus {
  hasCapabilities: boolean;
  missingCapabilities: string[];
  missingCommands: string[];
}

function backupRoot(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "backups", "s11");
}

function tempBackupDir(root: string, backupId: string): string {
  return path.join(root, `.tmp-${backupId}-${randomUUID()}`);
}

function finalBackupDir(root: string, backupId: string): string {
  return path.join(root, backupId);
}

function manifestPathFor(backupDir: string): string {
  return path.join(backupDir, "manifest.json");
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function backupIdFromDate(now: () => Date): string {
  return `${now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function ensureContained(root: string, candidate: string, stage: "S11"): string {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`) && absoluteCandidate !== absoluteRoot) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s11_path_escape",
      publicMessage: "Detected path traversal while building backup payload.",
      nextAction: "Inspect source paths and remove symlink/traversal entries before rerunning backup.",
      stage
    });
  }
  return absoluteCandidate;
}

async function copyFileOwned(sourcePath: string, destinationPath: string): Promise<{ sha256: string; bytes: number }> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, destinationPath);
  const stat = await fs.stat(destinationPath);
  return {
    sha256: await hashFile(destinationPath),
    bytes: stat.size
  };
}

async function copyTreeAllowlist(
  sourceRoot: string,
  destinationRoot: string,
  sourceBase: string,
  entries: BackupEntry[],
  stage: "S11"
): Promise<void> {
  if (!(await exists(sourceRoot))) {
    return;
  }
  const queue: string[] = [sourceRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      continue;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s11_symlink_disallowed",
        publicMessage: "Backup refused: symbolic links are not allowed in protected backup paths.",
        nextAction: "Replace symlinks with regular files/directories in allowed backup roots.",
        stage
      });
    }
    if (stat.isDirectory()) {
      const list = await fs.readdir(current);
      for (const name of list) {
        queue.push(path.join(current, name));
      }
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const relFromBase = path.relative(sourceBase, current);
    const rel = relFromBase.startsWith("..") ? path.basename(current) : relFromBase;
    const destination = ensureContained(destinationRoot, path.join(destinationRoot, rel), stage);
    const copied = await copyFileOwned(current, destination);
    entries.push({
      source: current,
      archive_path: rel.replaceAll(path.sep, "/"),
      sha256: copied.sha256,
      bytes: copied.bytes
    });
  }
}

async function readManifest(manifestPath: string): Promise<BackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_manifest_corrupt",
      publicMessage: "Backup manifest is missing or corrupt.",
      nextAction: "Recreate backup and rerun verification before restore.",
      stage: "S11",
      evidenceRef: manifestPath
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_manifest_corrupt",
      publicMessage: "Backup manifest payload is invalid.",
      nextAction: "Recreate backup and rerun verification before restore.",
      stage: "S11",
      evidenceRef: manifestPath
    });
  }
  const candidate = parsed as Partial<BackupManifest>;
  if (candidate.schema_version !== 1 || candidate.stage !== "S11" || typeof candidate.backup_id !== "string") {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_manifest_schema",
      publicMessage: "Backup manifest schema version is unsupported.",
      nextAction: "Use a compatible installer release or recreate backup.",
      stage: "S11",
      evidenceRef: manifestPath
    });
  }
  if (!Array.isArray(candidate.entries)) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_manifest_entries_invalid",
      publicMessage: "Backup manifest entries are invalid.",
      nextAction: "Recreate backup and rerun verification.",
      stage: "S11",
      evidenceRef: manifestPath
    });
  }
  return parsed as BackupManifest;
}

function readJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasUnknownUsageMarker(record: Record<string, unknown>): boolean {
  const direct = record.unknown_usage;
  if (typeof direct === "boolean") {
    return direct;
  }
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return true;
  }
  const consumed = (usage as Record<string, unknown>).daily_consumed;
  return typeof consumed !== "number";
}

function hasServiceCapabilities(manifest: unknown): ServiceCapabilityStatus {
  const missingCapabilities: string[] = [];
  const missingCommands: string[] = [];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return {
      hasCapabilities: false,
      missingCapabilities: ["deployment-manifest"],
      missingCommands: ["deployment-manifest"]
    };
  }
  const candidate = manifest as Record<string, unknown>;
  const capabilities = Array.isArray(candidate.capabilities) ? candidate.capabilities.filter((item) => typeof item === "string") : [];
  const commands = typeof candidate.commands === "object" && candidate.commands !== null && !Array.isArray(candidate.commands)
    ? candidate.commands as Record<string, unknown>
    : {};
  const requiredCapabilities = ["app-pause", "app-stop", "app-status", "app-recover"];
  for (const capability of requiredCapabilities) {
    if (!capabilities.includes(capability)) {
      missingCapabilities.push(capability);
    }
  }
  const requiredCommands = ["app_pause", "app_status", "app_recover"];
  for (const command of requiredCommands) {
    const argv = commands[command];
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== "string")) {
      missingCommands.push(command);
    }
  }
  const stop = commands.app_stop;
  const stopAll = commands.app_stop_all;
  const runnerStop = commands.runner_stop;
  const hasStop = [stop, stopAll, runnerStop].some((entry) => Array.isArray(entry) && entry.length > 0);
  if (!hasStop) {
    missingCommands.push("app_stop|app_stop_all|runner_stop");
  }
  return {
    hasCapabilities: missingCapabilities.length === 0 && missingCommands.length === 0,
    missingCapabilities,
    missingCommands
  };
}

async function ensureServiceDbCapabilities(config: SetupConfig): Promise<void> {
  const serviceDbPath = resolveServiceDbPath();
  if (!(await exists(serviceDbPath))) {
    return;
  }
  const manifestFile = path.join(config.paths.application_dir, "deployment-manifest.json");
  if (!(await exists(manifestFile))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "Service DB backup is blocked: deployment manifest is missing.",
      nextAction: "Run S05/S10 first or execute manual sqlite3 .backup as owner-approved procedure.",
      stage: "S11",
      evidenceRef: manifestFile
    });
  }
  const manifestRaw = await fs.readFile(manifestFile, "utf8");
  const parsed = JSON.parse(manifestRaw);
  const validation = validateContractSchema("application-manifest", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "Service DB backup is blocked: deployment manifest schema is invalid.",
      nextAction: "Fix deployment-manifest.json and rerun backup or execute manual backup procedure.",
      stage: "S11",
      evidenceRef: validation.errors.join("; ")
    });
  }
  const status = hasServiceCapabilities(parsed);
  if (!status.hasCapabilities) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "Service DB backup is blocked: application service capabilities are incomplete.",
      nextAction: `Provide app pause/stop/status/recover capabilities (missing caps: ${status.missingCapabilities.join(",") || "none"}; missing commands: ${status.missingCommands.join(",") || "none"}) or run manual backup documented in operations runbook.`,
      stage: "S11",
      evidenceRef: manifestFile
    });
  }
}

async function runSqliteBackup(processAdapter: ProcessAdapter, sourceDbPath: string, targetDbPath: string): Promise<void> {
  const result = await processAdapter.runCommand({
    binary: "/usr/bin/sqlite3",
    args: [sourceDbPath, ".timeout 5000", `.backup ${targetDbPath}`],
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const stderrLower = result.stderr.toLowerCase();
    const isBusy = stderrLower.includes("busy");
    const isSpace = stderrLower.includes("no space") || stderrLower.includes("enospc");
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: isBusy ? "s11_backup_sqlite_busy" : isSpace ? "s11_backup_enospc" : "s11_backup_sqlite_failed",
      publicMessage: "SQLite backup command failed for service database.",
      nextAction: "Resolve sqlite lock or disk pressure and retry backup. Existing verified backups were preserved.",
      stage: "S11",
      evidenceRef: result.stderr.slice(0, 256)
    });
  }
}

async function runSqliteIntegrityCheck(processAdapter: ProcessAdapter, dbPath: string): Promise<void> {
  const result = await processAdapter.runCommand({
    binary: "/usr/bin/sqlite3",
    args: [dbPath, "PRAGMA integrity_check;"],
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut || !/\bok\b/i.test(result.stdout)) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_backup_integrity_failed",
      publicMessage: "Backup SQLite integrity check failed.",
      nextAction: "Create a fresh backup and inspect sqlite integrity before restore.",
      stage: "S11",
      evidenceRef: result.stderr.slice(0, 256)
    });
  }
}

function latestGood(manifests: BackupManifest[]): BackupManifest | null {
  const owned = manifests
    .filter((entry) => entry.entries.length > 0)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return owned.at(-1) ?? null;
}

async function pruneOwnedRetention(root: string, installationId: string, now: Date): Promise<{ retainedLatestGood: string | null; pruned: string[] }> {
  if (!(await exists(root))) {
    return { retainedLatestGood: null, pruned: [] };
  }
  const entries = await fs.readdir(root);
  const manifests: BackupManifest[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".tmp-")) {
      continue;
    }
    const manifestPath = path.join(root, entry, "manifest.json");
    if (!(await exists(manifestPath))) {
      continue;
    }
    const manifest = await readManifest(manifestPath);
    if (manifest.installation_id === installationId) {
      manifests.push(manifest);
    }
  }
  if (manifests.length === 0) {
    return { retainedLatestGood: null, pruned: [] };
  }

  const latest = latestGood(manifests);
  const cutoff = new Date(now.getTime() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pruned: string[] = [];
  for (const manifest of manifests) {
    if (latest !== null && manifest.backup_id === latest.backup_id) {
      continue;
    }
    const created = new Date(manifest.created_at);
    if (Number.isNaN(created.getTime()) || created >= cutoff) {
      continue;
    }
    await fs.rm(path.join(root, manifest.backup_id), { recursive: true, force: false });
    pruned.push(manifest.backup_id);
  }
  return { retainedLatestGood: latest?.backup_id ?? null, pruned };
}

async function discoverBackups(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  return (await fs.readdir(root))
    .filter((entry) => !entry.startsWith(".tmp-"))
    .sort();
}

async function resolveBackupId(root: string, requestedBackupId: string | undefined): Promise<string> {
  if (requestedBackupId !== undefined) {
    return requestedBackupId;
  }
  const backups = await discoverBackups(root);
  if (backups.length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s11_backup_missing",
      publicMessage: "No local S11 backup exists to verify.",
      nextAction: "Run 'factory-setup backup create --config PATH' first.",
      stage: "S11"
    });
  }
  return backups.at(-1) as string;
}

export async function createBackup(deps: BackupDeps, config: SetupConfig): Promise<BackupCreateResult> {
  const root = backupRoot(config);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const backupId = backupIdFromDate(deps.now);
  const temporaryDir = tempBackupDir(root, backupId);
  const finalDir = finalBackupDir(root, backupId);
  await fs.mkdir(temporaryDir, { recursive: false, mode: 0o700 });

  const payloadDir = path.join(temporaryDir, "payload");
  const entries: BackupEntry[] = [];
  const excludedPaths = [
    config.paths.application_auth_dir,
    path.join(config.paths.application_dir, "auth")
  ];
  const appBase = config.paths.application_dir;

  const statePath = path.join(config.paths.application_dir, "state");
  const pausedMarkerPath = path.join(statePath, "PAUSED");
  let pausedPresent = false;
  let unknownUsageObserved = true;

  try {
    await copyTreeAllowlist(
      statePath,
      payloadDir,
      appBase,
      entries,
      "S11"
    );
    await copyTreeAllowlist(
      path.join(config.paths.application_dir, "deployment-manifest.json"),
      payloadDir,
      appBase,
      entries,
      "S11"
    );
    await copyTreeAllowlist(
      path.join(config.paths.application_dir, "policy-level1.json"),
      payloadDir,
      appBase,
      entries,
      "S11"
    );
    pausedPresent = await exists(pausedMarkerPath);
    const liveSmokePath = path.join(statePath, "live-smoke.json");
    if (await exists(liveSmokePath)) {
      const liveSmokeRecord = readJsonRecord(await fs.readFile(liveSmokePath, "utf8"));
      unknownUsageObserved = liveSmokeRecord === null ? true : hasUnknownUsageMarker(liveSmokeRecord);
    }

    const serviceDbPath = resolveServiceDbPath();
    let includesServiceDb = false;
    if (await exists(serviceDbPath)) {
      await ensureServiceDbCapabilities(config);
      const dbBackupPath = path.join(payloadDir, "service-state", "factory.sqlite3");
      await fs.mkdir(path.dirname(dbBackupPath), { recursive: true, mode: 0o700 });
      await runSqliteBackup(deps.processAdapter, serviceDbPath, dbBackupPath);
      const hash = await hashFile(dbBackupPath);
      const stat = await fs.stat(dbBackupPath);
      entries.push({
        source: serviceDbPath,
        archive_path: "service-state/factory.sqlite3",
        sha256: hash,
        bytes: stat.size
      });
      includesServiceDb = true;
    }

    const manifest: BackupManifest = {
      schema_version: 1,
      stage: "S11",
      backup_id: backupId,
      installation_id: config.installation_id,
      created_at: nowIso(deps.now),
      profile: config.profile,
      includes_service_db: includesServiceDb,
      state_paused_present: pausedPresent,
      unknown_usage_observed: unknownUsageObserved,
      excluded_paths: excludedPaths,
      entries: entries.sort((a, b) => a.archive_path.localeCompare(b.archive_path))
    };

    await fs.writeFile(manifestPathFor(temporaryDir), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
    await verifyBackup(deps, config, backupId, temporaryDir);

    await fs.rename(temporaryDir, finalDir);
    const retention = await pruneOwnedRetention(root, config.installation_id, deps.now());
    return {
      backupId,
      backupPath: finalDir,
      manifestPath: manifestPathFor(finalDir),
      retainedLatestGood: retention.retainedLatestGood,
      pruned: retention.pruned
    };
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(
  deps: BackupDeps,
  config: SetupConfig,
  backupId?: string,
  backupRootOverride?: string
): Promise<BackupVerifyResult> {
  const root = backupRootOverride ?? backupRoot(config);
  let resolvedId: string;
  let dir: string;
  if (backupRootOverride !== undefined && await exists(path.join(backupRootOverride, "manifest.json"))) {
    if (backupId === undefined) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "backup_id_required",
        publicMessage: "Backup ID is required for direct backup directory verification.",
        nextAction: "Provide explicit backup ID or verify from backup root.",
        stage: "S11"
      });
    }
    resolvedId = backupId;
    dir = backupRootOverride;
  } else {
    resolvedId = await resolveBackupId(root, backupId);
    dir = finalBackupDir(root, resolvedId);
  }
  const manifestFile = manifestPathFor(dir);
  const manifest = await readManifest(manifestFile);
  if (manifest.installation_id !== config.installation_id) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s11_backup_unowned",
      publicMessage: "Backup belongs to a different installation and cannot be used.",
      nextAction: "Select a backup created by the current installation ID.",
      stage: "S11",
      evidenceRef: manifestFile
    });
  }
  for (const entry of manifest.entries) {
    const relative = entry.archive_path.replaceAll("/", path.sep);
    if (relative.includes(`${path.sep}auth${path.sep}`) || relative.startsWith("auth")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s11_backup_contains_auth",
        publicMessage: "Backup payload contains forbidden auth material.",
        nextAction: "Delete this backup and create a new S11 backup with auth excluded.",
        stage: "S11",
        evidenceRef: relative
      });
    }
    const targetPath = path.join(dir, "payload", relative);
    if (!(await exists(targetPath))) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s11_backup_entry_missing",
        publicMessage: "Backup payload is incomplete.",
        nextAction: "Create a fresh backup before restore.",
        stage: "S11",
        evidenceRef: targetPath
      });
    }
    const observedHash = await hashFile(targetPath);
    if (observedHash !== entry.sha256) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s11_backup_hash_mismatch",
        publicMessage: "Backup integrity hash mismatch detected.",
        nextAction: "Reject this backup and create/verify a fresh one.",
        stage: "S11",
        evidenceRef: targetPath
      });
    }
  }
  if (manifest.includes_service_db) {
    const dbPath = path.join(dir, "payload", "service-state", "factory.sqlite3");
    await runSqliteIntegrityCheck(deps.processAdapter, dbPath);
  }
  return {
    backupId: resolvedId,
    backupPath: dir,
    manifestPath: manifestFile,
    unknownUsageObserved: manifest.unknown_usage_observed
  };
}
export function resolveServiceDbPath(): string {
  const override = process.env.FACTORY_SERVICE_DB_PATH;
  return override !== undefined && override.startsWith("/") ? override : DEFAULT_SERVICE_DB_PATH;
}
