import path from "node:path";
import { promises as fs } from "node:fs";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";
import { type BackupDeps, verifyBackup } from "./backup";
import { type RestoreDeps, restoreBackup } from "./restore";

const UPDATE_MANIFEST_FILENAME = "s14-update-manifest.json";
const UPDATE_RECEIPT_FILENAME = "s14-update-receipt.json";
const UPDATE_OBSERVATION_FILENAME = "s14-update-observation.json";
const COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;
const MANIFEST_SCHEMA_VERSION = 1;
const INSTALLER_STATE_SCHEMA = 1;

type UpdateCommandKey = "pause" | "drain" | "offline_smoke" | "migrate" | "restart_paused";

export interface UpdateManifest {
  schema_version: 1;
  stage: "S14";
  backup_id: string;
  installer_release: {
    version: string;
    state_schema: number;
  };
  app_release: {
    release_id: string;
    version: string;
    commit_sha: string;
    release_dir: string;
    immutable: boolean;
  };
  compatibility: {
    min_supported_state_schema: number;
    max_supported_state_schema: number;
    old_binary_rollback_compatible: boolean;
    allow_restore_from_backup: boolean;
  };
  approvals: {
    release_trust: boolean;
    policy_diff_approved: boolean;
    permissions_diff_approved: boolean;
    migration_approved: boolean;
  };
  commands: Record<UpdateCommandKey, string[]>;
  updates: {
    os: "none" | "separate-plan";
    docker: "none" | "separate-plan";
    model: "none" | "separate-plan";
  };
}

interface UpdateReceipt {
  schema_version: 1;
  stage: "S14";
  installation_id: string;
  backup_id: string;
  app_release_id: string;
  app_commit_sha: string;
  previous_current_target: string | null;
  current_target: string;
  migration_applied: boolean;
  paused_preserved: boolean;
  observed_at: string;
  applied_at: string;
}

interface ParsedCommand {
  binary: string;
  args: string[];
}

export interface UpdateObservation {
  manifestPresent: boolean;
  manifestReleaseId: string;
  currentTarget: string | null;
  receiptPresent: boolean;
  receiptCurrentTarget: string | null;
  driftDetected: boolean;
  orphanSwitchedRelease: boolean;
  pausedPresent: boolean;
  backupId: string;
  backupVerified: boolean;
  observedAt: string;
}

export interface UpdateApplyResult {
  operationId: string;
  observedAt: string;
  backupId: string;
  releaseId: string;
  commitSha: string;
  currentTarget: string;
  previousCurrentTarget: string | null;
  migrated: boolean;
  switched: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  reconciledWithoutMutations: boolean;
  artifacts: string[];
}

export interface UpdateDeps extends BackupDeps, RestoreDeps {
  fsAdapter: FilesystemAdapter;
  processAdapter: ProcessAdapter;
  now(): Date;
}

function pausedPath(config: SetupConfig): string {
  return path.join(config.paths.application_state_dir, "PAUSED");
}

function currentSymlinkPath(config: SetupConfig): string {
  return path.join(config.paths.application_dir, "current");
}

function updateManifestPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, UPDATE_MANIFEST_FILENAME);
}

function updateReceiptPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, UPDATE_RECEIPT_FILENAME);
}

function updateObservationPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, UPDATE_OBSERVATION_FILENAME);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

async function writeAtomic(fsAdapter: FilesystemAdapter, targetPath: string, payload: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, payload, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

async function readRegularJson(fsAdapter: FilesystemAdapter, targetPath: string, stage: "S14"): Promise<unknown | null> {
  if (!(await fsAdapter.exists(targetPath))) {
    return null;
  }
  const stat = await fsAdapter.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s14_forbidden_entry_type",
      publicMessage: `S14 input '${path.basename(targetPath)}' must be a regular JSON file.`,
      nextAction: "Replace symlink/special file with a reviewed regular JSON file.",
      stage,
      evidenceRef: targetPath
    });
  }
  return JSON.parse(await fsAdapter.readText(targetPath));
}

function isSha40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function validateCommand(command: string[], targetPath: string): ParsedCommand {
  if (!Array.isArray(command) || command.length === 0) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_command_invalid",
      publicMessage: "S14 update manifest command entry is invalid.",
      nextAction: "Provide non-empty argv arrays in commands.pause/drain/offline_smoke/migrate/restart_paused.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  for (const part of command) {
    if (typeof part !== "string" || part.trim().length === 0 || /[\n\r]/.test(part)) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s14_command_unsafe",
        publicMessage: "S14 update command contains unsafe argv parts.",
        nextAction: "Keep command argv as clean strings without control characters.",
        stage: "S14",
        evidenceRef: targetPath
      });
    }
    const lowered = part.toLowerCase();
    if (lowered.includes("git pull")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s14_git_pull_forbidden",
        publicMessage: "S14 update manifest forbids in-place git pull in production tree.",
        nextAction: "Use a reviewed immutable release path instead of git pull.",
        stage: "S14",
        evidenceRef: targetPath
      });
    }
    if (lowered === "latest" || lowered.includes("/latest") || lowered.includes(":latest")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s14_latest_forbidden",
        publicMessage: "S14 update manifest must not use floating 'latest' references.",
        nextAction: "Pin exact reviewed versions/SHAs in update manifest.",
        stage: "S14",
        evidenceRef: targetPath
      });
    }
  }
  return {
    binary: command[0] ?? "",
    args: command.slice(1)
  };
}

function validateManifest(raw: unknown, targetPath: string): UpdateManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_manifest_invalid",
      publicMessage: "S14 update manifest payload is invalid.",
      nextAction: "Provide reviewed s14-update-manifest.json with required fields.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  const record = raw as Partial<UpdateManifest>;
  if (
    record.schema_version !== MANIFEST_SCHEMA_VERSION
    || record.stage !== "S14"
    || typeof record.backup_id !== "string"
    || typeof record.installer_release !== "object"
    || record.installer_release === null
    || typeof record.app_release !== "object"
    || record.app_release === null
    || typeof record.compatibility !== "object"
    || record.compatibility === null
    || typeof record.approvals !== "object"
    || record.approvals === null
    || typeof record.commands !== "object"
    || record.commands === null
    || typeof record.updates !== "object"
    || record.updates === null
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_manifest_invalid",
      publicMessage: "S14 update manifest payload is invalid.",
      nextAction: "Provide reviewed s14-update-manifest.json with required fields.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  const installerRelease = record.installer_release as UpdateManifest["installer_release"];
  const appRelease = record.app_release as UpdateManifest["app_release"];
  const compatibility = record.compatibility as UpdateManifest["compatibility"];
  const approvals = record.approvals as UpdateManifest["approvals"];
  const commands = record.commands as UpdateManifest["commands"];
  const updates = record.updates as UpdateManifest["updates"];
  if (
    typeof installerRelease.version !== "string"
    || typeof installerRelease.state_schema !== "number"
    || typeof appRelease.release_id !== "string"
    || typeof appRelease.version !== "string"
    || typeof appRelease.commit_sha !== "string"
    || typeof appRelease.release_dir !== "string"
    || typeof appRelease.immutable !== "boolean"
    || typeof compatibility.min_supported_state_schema !== "number"
    || typeof compatibility.max_supported_state_schema !== "number"
    || typeof compatibility.old_binary_rollback_compatible !== "boolean"
    || typeof compatibility.allow_restore_from_backup !== "boolean"
    || typeof approvals.release_trust !== "boolean"
    || typeof approvals.policy_diff_approved !== "boolean"
    || typeof approvals.permissions_diff_approved !== "boolean"
    || typeof approvals.migration_approved !== "boolean"
    || typeof updates.os !== "string"
    || typeof updates.docker !== "string"
    || typeof updates.model !== "string"
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_manifest_invalid",
      publicMessage: "S14 update manifest payload is invalid.",
      nextAction: "Fill installer_release/app_release/compatibility/approvals/updates with complete values.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  if (!isSha40(appRelease.commit_sha)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_commit_sha_invalid",
      publicMessage: "S14 app_release.commit_sha must be a lowercase 40-char SHA.",
      nextAction: "Pin exact reviewed release commit SHA in manifest.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  if (!appRelease.immutable) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_release_not_immutable",
      publicMessage: "S14 requires immutable reviewed release payload.",
      nextAction: "Publish reviewed immutable release and set app_release.immutable=true.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  if (
    compatibility.min_supported_state_schema > compatibility.max_supported_state_schema
    || compatibility.min_supported_state_schema < 1
    || compatibility.max_supported_state_schema < 1
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s14_state_schema_range_invalid",
      publicMessage: "S14 compatibility state schema range is invalid.",
      nextAction: "Fix compatibility.min_supported_state_schema/max_supported_state_schema in manifest.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  if (installerRelease.state_schema > INSTALLER_STATE_SCHEMA) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_future_state_schema_refused",
      publicMessage: "S14 manifest references a future installer state schema.",
      nextAction: "Use a newer installer release or provide compatible schema migration package.",
      stage: "S14",
      evidenceRef: String(installerRelease.state_schema)
    });
  }
  const commandKeys: UpdateCommandKey[] = ["pause", "drain", "offline_smoke", "migrate", "restart_paused"];
  for (const key of commandKeys) {
    validateCommand(commands[key], targetPath);
  }
  if (updates.os !== "none" || updates.docker !== "none" || updates.model !== "none") {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_cross_domain_update_blocked",
      publicMessage: "S14 app/setup update must not bundle OS/Docker/model upgrades.",
      nextAction: "Prepare separate approved plans for OS/Docker/model updates.",
      stage: "S14",
      evidenceRef: targetPath
    });
  }
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    stage: "S14",
    backup_id: record.backup_id,
    installer_release: installerRelease,
    app_release: appRelease,
    compatibility,
    approvals,
    commands,
    updates
  };
}

export async function readUpdateManifest(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<UpdateManifest | null> {
  const target = updateManifestPath(config);
  const parsed = await readRegularJson(fsAdapter, target, "S14");
  if (parsed === null) {
    return null;
  }
  return validateManifest(parsed, target);
}

async function readUpdateReceipt(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<UpdateReceipt | null> {
  const target = updateReceiptPath(config);
  const parsed = await readRegularJson(fsAdapter, target, "S14");
  if (parsed === null || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const receipt = parsed as Partial<UpdateReceipt>;
  if (
    receipt.schema_version !== MANIFEST_SCHEMA_VERSION
    || receipt.stage !== "S14"
    || typeof receipt.installation_id !== "string"
    || typeof receipt.backup_id !== "string"
    || typeof receipt.app_release_id !== "string"
    || typeof receipt.app_commit_sha !== "string"
    || typeof receipt.current_target !== "string"
    || typeof receipt.migration_applied !== "boolean"
    || typeof receipt.paused_preserved !== "boolean"
    || typeof receipt.observed_at !== "string"
    || typeof receipt.applied_at !== "string"
    || (receipt.previous_current_target !== null && typeof receipt.previous_current_target !== "string")
  ) {
    return null;
  }
  return receipt as UpdateReceipt;
}

async function readCurrentTarget(config: SetupConfig): Promise<string | null> {
  const currentPath = currentSymlinkPath(config);
  try {
    const stat = await fs.lstat(currentPath);
    if (!stat.isSymbolicLink()) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s14_current_not_symlink",
        publicMessage: "S14 current release pointer must be a symlink.",
        nextAction: "Replace current pointer with a managed symlink before applying update.",
        stage: "S14",
        evidenceRef: currentPath
      });
    }
    const link = await fs.readlink(currentPath, "utf8");
    return path.resolve(path.dirname(currentPath), link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writePausedMarker(config: SetupConfig, operationId: string): Promise<void> {
  const target = pausedPath(config);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${new Date().toISOString()} ${operationId}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runCommand(
  processAdapter: ProcessAdapter,
  argv: string[],
  operationId: string,
  label: string
): Promise<void> {
  const parsed = validateCommand(argv, label);
  const result = await processAdapter.runCommand({
    binary: parsed.binary,
    args: parsed.args,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    operationId
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: `s14_command_${label}_failed`,
      publicMessage: `S14 command '${label}' failed.`,
      nextAction: "Inspect command stderr in local logs, keep PAUSED state, and rerun after fix.",
      stage: "S14",
      operationId,
      evidenceRef: result.stderr.slice(0, 256)
    });
  }
}

function assertApprovals(manifest: UpdateManifest): void {
  if (!manifest.approvals.release_trust) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s14_release_trust_required",
      publicMessage: "S14 requires explicit owner release trust approval.",
      nextAction: "Set approvals.release_trust=true after owner confirms release provenance.",
      stage: "S14"
    });
  }
  if (!manifest.approvals.policy_diff_approved || !manifest.approvals.permissions_diff_approved) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s14_diff_approval_required",
      publicMessage: "S14 requires owner approval for policy/permissions differences.",
      nextAction: "Set approvals.policy_diff_approved=true and approvals.permissions_diff_approved=true after diff review.",
      stage: "S14"
    });
  }
  if (!manifest.approvals.migration_approved) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s14_migration_approval_required",
      publicMessage: "S14 requires explicit migration approval before DB changes.",
      nextAction: "Set approvals.migration_approved=true after owner validates migration/rollback plan.",
      stage: "S14"
    });
  }
}

async function ensureReleasePath(manifest: UpdateManifest): Promise<string> {
  const releaseDir = path.resolve(manifest.app_release.release_dir);
  if (releaseDir.toLowerCase().includes("latest")) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s14_latest_forbidden",
      publicMessage: "S14 refuses release paths that include 'latest'.",
      nextAction: "Use immutable reviewed release directory with explicit version/commit.",
      stage: "S14",
      evidenceRef: releaseDir
    });
  }
  const stat = await fs.stat(releaseDir).catch(() => null);
  if (stat === null || !stat.isDirectory()) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_release_dir_missing",
      publicMessage: "S14 update release directory is missing.",
      nextAction: "Stage reviewed release payload first and rerun S14.",
      stage: "S14",
      evidenceRef: releaseDir
    });
  }
  return releaseDir;
}

async function switchCurrentSymlink(config: SetupConfig, nextTarget: string): Promise<void> {
  const currentPath = currentSymlinkPath(config);
  await fs.mkdir(path.dirname(currentPath), { recursive: true, mode: 0o700 });
  const tempLink = `${currentPath}.next`;
  await fs.rm(tempLink, { force: true });
  await fs.symlink(nextTarget, tempLink);
  await fs.rename(tempLink, currentPath);
}

function buildReceipt(
  config: SetupConfig,
  manifest: UpdateManifest,
  observedAt: string,
  previousCurrentTarget: string | null,
  currentTarget: string,
  migrated: boolean,
  appliedAt: string
): UpdateReceipt {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    stage: "S14",
    installation_id: config.installation_id,
    backup_id: manifest.backup_id,
    app_release_id: manifest.app_release.release_id,
    app_commit_sha: manifest.app_release.commit_sha,
    previous_current_target: previousCurrentTarget,
    current_target: currentTarget,
    migration_applied: migrated,
    paused_preserved: true,
    observed_at: observedAt,
    applied_at: appliedAt
  };
}

async function writeReceipt(fsAdapter: FilesystemAdapter, config: SetupConfig, receipt: UpdateReceipt): Promise<void> {
  await writeAtomic(fsAdapter, updateReceiptPath(config), `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

function checkStateSchemaCompatibility(manifest: UpdateManifest): void {
  if (
    INSTALLER_STATE_SCHEMA < manifest.compatibility.min_supported_state_schema
    || INSTALLER_STATE_SCHEMA > manifest.compatibility.max_supported_state_schema
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_state_schema_incompatible",
      publicMessage: "S14 installer state schema is incompatible with update manifest.",
      nextAction: "Use compatible installer release or a reviewed state migration package before retrying S14.",
      stage: "S14"
    });
  }
}

export async function observeUpdateState(deps: UpdateDeps, config: SetupConfig): Promise<UpdateObservation> {
  const observedAt = nowIso(deps.now);
  const manifest = await readUpdateManifest(deps.fsAdapter, config);
  const receipt = await readUpdateReceipt(deps.fsAdapter, config);
  const currentTarget = await readCurrentTarget(config);
  const pausedPresent = await deps.fsAdapter.exists(pausedPath(config));
  let backupVerified = false;
  if (manifest !== null) {
    try {
      await verifyBackup(deps, config, manifest.backup_id);
      backupVerified = true;
    } catch {
      backupVerified = false;
    }
  }
  const driftDetected = receipt !== null && currentTarget !== receipt.current_target;
  const orphanSwitchedRelease = manifest !== null && receipt === null && currentTarget !== null && currentTarget === path.resolve(manifest.app_release.release_dir);
  const observation: UpdateObservation = {
    manifestPresent: manifest !== null,
    manifestReleaseId: manifest?.app_release.release_id ?? "absent",
    currentTarget,
    receiptPresent: receipt !== null,
    receiptCurrentTarget: receipt?.current_target ?? null,
    driftDetected,
    orphanSwitchedRelease,
    pausedPresent,
    backupId: manifest?.backup_id ?? "absent",
    backupVerified,
    observedAt
  };
  await writeAtomic(deps.fsAdapter, updateObservationPath(config), `${JSON.stringify(observation, null, 2)}\n`, 0o600);
  return observation;
}

function ensureRollbackCompatibility(manifest: UpdateManifest): void {
  if (manifest.compatibility.old_binary_rollback_compatible) {
    return;
  }
  if (!manifest.compatibility.allow_restore_from_backup) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_incompatible_old_binary_refused",
      publicMessage: "S14 cannot proceed because old binary rollback is incompatible and backup restore rollback is disabled.",
      nextAction: "Enable compatibility.allow_restore_from_backup or provide compatible old binary rollback plan.",
      stage: "S14"
    });
  }
}

async function rollbackAfterFailure(
  deps: UpdateDeps,
  config: SetupConfig,
  manifest: UpdateManifest,
  previousCurrentTarget: string | null,
  operationId: string
): Promise<void> {
  if (manifest.compatibility.old_binary_rollback_compatible && previousCurrentTarget !== null) {
    await switchCurrentSymlink(config, previousCurrentTarget);
    await runCommand(deps.processAdapter, manifest.commands.restart_paused, operationId, "restart_paused");
    return;
  }
  if (manifest.compatibility.allow_restore_from_backup) {
    await restoreBackup(deps, config, manifest.backup_id);
    await runCommand(deps.processAdapter, manifest.commands.restart_paused, operationId, "restart_paused");
    return;
  }
  throw setupError({
    exitCode: ExitCode.DriftOrRecoveryRequired,
    code: "s14_rollback_not_possible",
    publicMessage: "S14 rollback could not be executed with current compatibility settings.",
    nextAction: "Run owner-approved manual restore procedure and keep application paused.",
    stage: "S14",
    operationId
  });
}

export async function applyUpdate(
  deps: UpdateDeps,
  config: SetupConfig,
  operationId: string
): Promise<UpdateApplyResult> {
  const observedAt = nowIso(deps.now);
  const manifest = await readUpdateManifest(deps.fsAdapter, config);
  if (manifest === null) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_manifest_missing",
      publicMessage: "S14 update manifest is missing.",
      nextAction: "Create reviewed s14-update-manifest.json and rerun S14.",
      stage: "S14",
      operationId,
      evidenceRef: updateManifestPath(config)
    });
  }
  checkStateSchemaCompatibility(manifest);
  assertApprovals(manifest);
  ensureRollbackCompatibility(manifest);
  const releasePath = await ensureReleasePath(manifest);
  const observation = await observeUpdateState(deps, config);
  if (observation.driftDetected) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_receipt_current_drift",
      publicMessage: "S14 detected drift: receipt current target differs from active current symlink.",
      nextAction: "Run recover/verify and reconcile release pointer before applying new update.",
      stage: "S14",
      operationId
    });
  }

  const existingReceipt = await readUpdateReceipt(deps.fsAdapter, config);
  if (observation.orphanSwitchedRelease && existingReceipt === null) {
    const adoptedReceipt = buildReceipt(
      config,
      manifest,
      observation.observedAt,
      observation.currentTarget,
      releasePath,
      true,
      nowIso(deps.now)
    );
    await writePausedMarker(config, `${operationId}:reconcile`);
    await writeReceipt(deps.fsAdapter, config, adoptedReceipt);
    return {
      operationId,
      observedAt: observation.observedAt,
      backupId: manifest.backup_id,
      releaseId: manifest.app_release.release_id,
      commitSha: manifest.app_release.commit_sha,
      currentTarget: releasePath,
      previousCurrentTarget: observation.currentTarget,
      migrated: false,
      switched: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
      reconciledWithoutMutations: true,
      artifacts: [updateObservationPath(config), updateReceiptPath(config)]
    };
  }
  if (existingReceipt !== null && existingReceipt.current_target === releasePath && observation.currentTarget === releasePath) {
    return {
      operationId,
      observedAt: observation.observedAt,
      backupId: manifest.backup_id,
      releaseId: manifest.app_release.release_id,
      commitSha: manifest.app_release.commit_sha,
      currentTarget: releasePath,
      previousCurrentTarget: existingReceipt.previous_current_target,
      migrated: false,
      switched: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
      reconciledWithoutMutations: true,
      artifacts: [updateObservationPath(config), updateReceiptPath(config)]
    };
  }

  await verifyBackup(deps, config, manifest.backup_id);
  const previousCurrentTarget = observation.currentTarget;
  let migrated = false;
  let switched = false;
  let rollbackAttempted = false;
  let rollbackSucceeded = false;
  try {
    await writePausedMarker(config, `${operationId}:pause`);
    await runCommand(deps.processAdapter, manifest.commands.pause, operationId, "pause");
    await runCommand(deps.processAdapter, manifest.commands.drain, operationId, "drain");
    await runCommand(deps.processAdapter, manifest.commands.offline_smoke, operationId, "offline_smoke");
    await runCommand(deps.processAdapter, manifest.commands.migrate, operationId, "migrate");
    migrated = true;
    await switchCurrentSymlink(config, releasePath);
    switched = true;
    await runCommand(deps.processAdapter, manifest.commands.restart_paused, operationId, "restart_paused");
    await writePausedMarker(config, `${operationId}:post-update`);
    const effectiveCurrent = await readCurrentTarget(config);
    if (effectiveCurrent !== releasePath) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s14_current_switch_verification_failed",
        publicMessage: "S14 could not verify the updated current symlink target.",
        nextAction: "Inspect release pointer and run recover while keeping PAUSED.",
        stage: "S14",
        operationId,
        evidenceRef: effectiveCurrent ?? "absent"
      });
    }
    const receipt = buildReceipt(
      config,
      manifest,
      observation.observedAt,
      previousCurrentTarget,
      releasePath,
      migrated,
      nowIso(deps.now)
    );
    await writeReceipt(deps.fsAdapter, config, receipt);
    return {
      operationId,
      observedAt: observation.observedAt,
      backupId: manifest.backup_id,
      releaseId: manifest.app_release.release_id,
      commitSha: manifest.app_release.commit_sha,
      currentTarget: releasePath,
      previousCurrentTarget,
      migrated,
      switched,
      rollbackAttempted,
      rollbackSucceeded,
      reconciledWithoutMutations: false,
      artifacts: [updateObservationPath(config), updateReceiptPath(config), updateManifestPath(config)]
    };
  } catch (error) {
    await writePausedMarker(config, `${operationId}:failure`);
    if (migrated || switched) {
      rollbackAttempted = true;
      try {
        await rollbackAfterFailure(deps, config, manifest, previousCurrentTarget, operationId);
        rollbackSucceeded = true;
      } catch (rollbackError) {
        const rollbackSetup = rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s14_rollback_partial",
          publicMessage: "S14 rollback failed after migration/switch failure.",
          nextAction: "Keep PAUSED marker, run manual recovery from verified backup, and do not continue with destructive actions.",
          stage: "S14",
          operationId,
          evidenceRef: rollbackSetup
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s14_update_rolled_back",
        publicMessage: "S14 update failed after migration and was rolled back in PAUSED state.",
        nextAction: "Inspect migration/restart logs, verify restored state, then generate a new reviewed update plan.",
        stage: "S14",
        operationId,
        evidenceRef: error instanceof Error ? error.message : "unknown update error"
      });
    }
    throw error;
  }
}

export async function verifyUpdate(deps: UpdateDeps, config: SetupConfig): Promise<UpdateObservation> {
  const observation = await observeUpdateState(deps, config);
  if (!observation.manifestPresent) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_manifest_missing",
      publicMessage: "S14 verify requires update manifest.",
      nextAction: "Provide reviewed s14-update-manifest.json and rerun verify.",
      stage: "S14",
      evidenceRef: updateManifestPath(config)
    });
  }
  if (observation.driftDetected) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_receipt_current_drift",
      publicMessage: "S14 verify detected drift between receipt and current release pointer.",
      nextAction: "Run recover flow and reconcile current symlink before next update.",
      stage: "S14"
    });
  }
  if (!observation.pausedPresent) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s14_paused_missing",
      publicMessage: "S14 verify requires PAUSED marker to remain present after update.",
      nextAction: "Restore PAUSED marker and validate application pause status before proceeding.",
      stage: "S14"
    });
  }
  if (!observation.receiptPresent || observation.currentTarget === null) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s14_receipt_missing",
      publicMessage: "S14 verify requires update receipt and active current release target.",
      nextAction: "Run S14 apply/recover to complete receipt and pointer reconciliation.",
      stage: "S14",
      evidenceRef: updateReceiptPath(config)
    });
  }
  return observation;
}

