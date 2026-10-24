import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { ExitCode, STAGE_IDS, type SetupConfig, type SetupState, type StageId, type StageObservation, type StageStatus } from "./types";
import { setupError } from "./errors";
import { hashConfig, stableStringify, type Clock } from "./config";
import { validateContractSchema } from "./validators";

const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";
const RECOVERY_MARKER_FILE = "recovery-required.json";
const COMMIT_MANIFEST_FILE = "state-commit.json";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const JOURNAL_SCHEMA_VERSION = 2;
const COMMIT_MANIFEST_SCHEMA_VERSION = 1;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const STAGE_ID_SET = new Set<StageId>(STAGE_IDS);
export const FALLBACK_MACHINE_ID_HASH = createHash("sha256").update("unknown-machine-id").digest("hex");

type JournalEventCode = "intent" | "effect" | "verify" | "checkpoint";

interface JournalEventRecord {
  schema_version: 2;
  sequence: number;
  checksum: string;
  at: string;
  installation_id: string;
  attempt_id: string;
  operation_id: string;
  stage: StageId;
  code: JournalEventCode;
  message: string;
  state_hash?: string;
}

interface LegacyEventRecord {
  sequence: number;
  checksum: string;
  at: string;
  operation_id: string;
  stage: StageId;
  code: string;
  message: string;
}

type ParsedJournalEvent =
  | { format: "v2"; record: JournalEventRecord }
  | { format: "legacy"; record: LegacyEventRecord };

interface ParsedJournal {
  records: ParsedJournalEvent[];
  parseError: boolean;
  unknownOrder: boolean;
  unresolvedOperationIds: string[];
  legacyFormat: boolean;
  latestCheckpoint: {
    attemptId: string;
    operationId: string;
    stage: StageId;
    stateHash: string;
    sequence: number;
  } | null;
}

async function writeRecoveryMarker(
  fsAdapter: FilesystemAdapter,
  markerPath: string,
  payload: Record<string, unknown>
): Promise<void> {
  await writeAtomicJson(fsAdapter, markerPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export interface RecoveryMarkerRecord {
  schema_version: 1;
  reason: string;
  observed_at: string;
  recovery_commit?: {
    phase: "prepared" | "primary_restored";
    source: "previous";
    candidate_state_hash: string;
    updated_at: string;
  };
  [key: string]: unknown;
}

export interface JournalInspection {
  hasRecords: boolean;
  unresolvedOperationIds: string[];
  parseError: boolean;
  unknownOrder: boolean;
  oversized: boolean;
  legacyFormat: boolean;
  latestCheckpoint: {
    attemptId: string;
    operationId: string;
    stage: StageId;
    stateHash: string;
    sequence: number;
  } | null;
  evidenceRef: string;
}

export interface StateCommitCheckpointRecord {
  attempt_id: string;
  operation_id: string;
  stage: StageId;
  state_hash: string;
  sequence: number;
  updated_at: string;
}

export interface StateCommitManifest {
  schema_version: 1;
  installation_id: string;
  generation: number;
  last_state_hash: string;
  updated_at: string;
  last_effect_checkpoint?: StateCommitCheckpointRecord;
}

export interface StateEvidenceSummary {
  marker: RecoveryMarkerRecord | null;
  stateExists: boolean;
  previousExists: boolean;
  quarantineEntries: string[];
  journal: JournalInspection;
  commitManifest: StateCommitManifest | null;
}

export interface StatePaths {
  stateDir: string;
  stateFile: string;
  eventsFile: string;
  recoveryMarkerFile: string;
  commitManifestFile: string;
}

export function buildStatePaths(config: SetupConfig): StatePaths {
  const stateDir = config.paths.setup_state_dir;
  return {
    stateDir,
    stateFile: path.join(stateDir, STATE_FILE),
    eventsFile: path.join(stateDir, EVENTS_FILE),
    recoveryMarkerFile: path.join(stateDir, RECOVERY_MARKER_FILE),
    commitManifestFile: path.join(stateDir, COMMIT_MANIFEST_FILE)
  };
}

export interface SaveStateOptions {
  checkpoint?: {
    attemptId: string;
    operationId: string;
    stage: StageId;
    sequence: number;
    stateHash: string;
  };
}

export interface LoadStateOptions {
  initializeIfMissing?: boolean;
  persistConfigDrift?: boolean;
  readOnly?: boolean;
}

function checksumForLegacyEvent(record: Omit<LegacyEventRecord, "checksum">): string {
  return createHash("sha256")
    .update(
      `${record.sequence}|${record.at}|${record.operation_id}|${record.stage}|${record.code}|${record.message}`
    )
    .digest("hex");
}

function checksumForJournalEvent(record: Omit<JournalEventRecord, "checksum">): string {
  return createHash("sha256")
    .update(stableStringify(record))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJournalEventCode(value: unknown): value is JournalEventCode {
  return value === "intent" || value === "effect" || value === "verify" || value === "checkpoint";
}

function toSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function defaultStageStatus(stageId: StageId): StageStatus {
  return stageId === "S00" ? "pending" : "pending";
}

function stageDependenciesHash(stageId: StageId): string {
  return createHash("sha256").update(`deps:${stageId}`).digest("hex");
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function journalUncertainty(journal: JournalInspection): boolean {
  return journal.oversized
    || journal.parseError
    || journal.unknownOrder
    || journal.unresolvedOperationIds.length > 0;
}

function journalHasEvidence(journal: JournalInspection): boolean {
  return journal.hasRecords || journalUncertainty(journal);
}

async function pathExistsStrict(
  fsAdapter: FilesystemAdapter,
  targetPath: string,
  descriptor: string
): Promise<boolean> {
  try {
    await fsAdapter.stat(targetPath);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return false;
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_path_access_failed",
      publicMessage: `Unable to access ${descriptor} while evaluating installer state.`,
      nextAction: "Fix filesystem permissions or I/O errors and rerun diagnostics.",
      evidenceRef: `${targetPath}:${code ?? "unknown"}`
    });
  }
}

async function readTextStrict(
  fsAdapter: FilesystemAdapter,
  targetPath: string,
  descriptor: string
): Promise<string> {
  try {
    return await fsAdapter.readText(targetPath);
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_path_access_failed",
      publicMessage: `Unable to read ${descriptor} while evaluating installer state.`,
      nextAction: "Fix filesystem permissions or I/O errors and rerun diagnostics.",
      evidenceRef: `${targetPath}:${code ?? "unknown"}`
    });
  }
}

function parseCommitManifest(parsed: unknown): StateCommitManifest {
  if (!isRecord(parsed)) {
    throw new Error("commit manifest is not an object");
  }
  const schemaVersion = parsed.schema_version;
  const installationId = parsed.installation_id;
  const generation = toSequence(parsed.generation);
  const lastStateHash = parsed.last_state_hash;
  const updatedAt = parsed.updated_at;
  if (
    schemaVersion !== COMMIT_MANIFEST_SCHEMA_VERSION
    || typeof installationId !== "string"
    || installationId.length === 0
    || generation === null
    || typeof lastStateHash !== "string"
    || !SHA256_HEX_PATTERN.test(lastStateHash)
    || typeof updatedAt !== "string"
  ) {
    throw new Error("invalid commit manifest shape");
  }

  const checkpointRaw = parsed.last_effect_checkpoint;
  let checkpoint: StateCommitCheckpointRecord | undefined;
  if (checkpointRaw !== undefined) {
    if (!isRecord(checkpointRaw)) {
      throw new Error("invalid commit checkpoint record shape");
    }
    const attemptId = checkpointRaw.attempt_id;
    const operationId = checkpointRaw.operation_id;
    const stage = checkpointRaw.stage;
    const stateHash = checkpointRaw.state_hash;
    const sequence = toSequence(checkpointRaw.sequence);
    const checkpointUpdatedAt = checkpointRaw.updated_at;
    if (
      typeof attemptId !== "string"
      || attemptId.length === 0
      || typeof operationId !== "string"
      || operationId.length === 0
      || typeof stage !== "string"
      || !STAGE_ID_SET.has(stage as StageId)
      || typeof stateHash !== "string"
      || !SHA256_HEX_PATTERN.test(stateHash)
      || sequence === null
      || typeof checkpointUpdatedAt !== "string"
    ) {
      throw new Error("invalid commit checkpoint record shape");
    }
    checkpoint = {
      attempt_id: attemptId,
      operation_id: operationId,
      stage: stage as StageId,
      state_hash: stateHash,
      sequence,
      updated_at: checkpointUpdatedAt
    };
  }

  return {
    schema_version: COMMIT_MANIFEST_SCHEMA_VERSION,
    installation_id: installationId,
    generation,
    last_state_hash: lastStateHash,
    updated_at: updatedAt,
    ...(checkpoint === undefined ? {} : { last_effect_checkpoint: checkpoint })
  };
}

export async function readStateCommitManifest(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<StateCommitManifest | null> {
  const manifestPath = buildStatePaths(config).commitManifestFile;
  if (!(await pathExistsStrict(fsAdapter, manifestPath, "state commit manifest"))) {
    return null;
  }
  const raw = await readTextStrict(fsAdapter, manifestPath, "state commit manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_commit_manifest_invalid",
      publicMessage: "State commit manifest is unreadable or invalid JSON.",
      nextAction: "Run recover and reconcile commit metadata before mutating commands.",
      evidenceRef: manifestPath
    });
  }
  try {
    return parseCommitManifest(parsed);
  } catch {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_commit_manifest_invalid",
      publicMessage: "State commit manifest schema is invalid.",
      nextAction: "Run recover and reconcile commit metadata before mutating commands.",
      evidenceRef: manifestPath
    });
  }
}

async function persistStateCommitManifest(
  fsAdapter: FilesystemAdapter,
  manifestPath: string,
  manifest: StateCommitManifest
): Promise<void> {
  try {
    await writeAtomicJson(fsAdapter, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_commit_manifest_write_failed",
      publicMessage: "Failed to persist state commit metadata.",
      nextAction: "Preserve recovery evidence and run recover before mutating commands.",
      evidenceRef: `${manifestPath}:${code ?? "unknown"}`
    });
  }
}

function recoveryEvidenceReference(
  stateDir: string,
  previousPath: string,
  quarantineEntries: string[],
  journal: JournalInspection,
  commitManifestPath: string,
  commitManifestPresent: boolean
): string {
  if (quarantineEntries.length > 0) {
    return path.join(stateDir, quarantineEntries[0] ?? "");
  }
  if (previousPath.length > 0) {
    return previousPath;
  }
  if (commitManifestPresent) {
    return commitManifestPath;
  }
  if (journalHasEvidence(journal)) {
    return journal.evidenceRef;
  }
  return stateDir;
}

async function listStateQuarantineEntries(
  fsAdapter: FilesystemAdapter,
  stateDir: string
): Promise<string[]> {
  try {
    const entries = await fsAdapter.readdir(stateDir);
    return entries
      .filter((entry) => entry.startsWith(`${STATE_FILE}.corrupt-`))
      .sort();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return [];
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_path_access_failed",
      publicMessage: "Unable to inspect setup state directory for recovery evidence.",
      nextAction: "Fix filesystem permissions or I/O errors and rerun diagnostics.",
      evidenceRef: `${stateDir}:${code ?? "unknown"}`
    });
  }
}

async function persistRecoveryMarker(
  fsAdapter: FilesystemAdapter,
  markerPath: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await writeRecoveryMarker(fsAdapter, markerPath, payload);
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_marker_persist_failed",
      publicMessage: "Failed to persist recovery marker; installation remains in uncertain state.",
      nextAction: "Free disk space or repair filesystem, then run recover before mutating commands.",
      evidenceRef: `${markerPath}:${code ?? "unknown"}`
    });
  }
}

async function quarantinePrimaryState(
  fsAdapter: FilesystemAdapter,
  stateFilePath: string,
  quarantinePath: string
): Promise<void> {
  try {
    await fsAdapter.rename(stateFilePath, quarantinePath);
    await fsAdapter.fsyncDir(path.dirname(stateFilePath));
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_quarantine_failed",
      publicMessage: "Failed to quarantine corrupt state file.",
      nextAction: "Run recover and inspect state evidence before retrying mutations.",
      evidenceRef: `${stateFilePath}:${code ?? "unknown"}`
    });
  }
}

function emptyJournalInspection(evidenceRef: string): JournalInspection {
  return {
    hasRecords: false,
    unresolvedOperationIds: [],
    parseError: false,
    unknownOrder: false,
    oversized: false,
    legacyFormat: false,
    latestCheckpoint: null,
    evidenceRef
  };
}

export async function initState(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  clock: Clock,
  config: SetupConfig,
  installerVersion: string
): Promise<SetupState> {
  const paths = buildStatePaths(config);
  const bootId = await processAdapter.bootId();
  const machineIdHash = await processAdapter.machineIdHash();
  if (!UUID_V4_PATTERN.test(bootId)) {
    throw setupError({
      exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "host_boot_id_unavailable",
      publicMessage: "Boot identity is unavailable or invalid on this host.",
      nextAction: "Ensure /proc boot_id is readable and rerun preflight.",
      stage: "S01",
      evidenceRef: bootId
    });
  }
  if (!SHA256_HEX_PATTERN.test(machineIdHash)) {
    throw setupError({
      exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "host_machine_id_unavailable",
      publicMessage: "Machine identity hash is unavailable or invalid on this host.",
      nextAction: "Ensure /etc/machine-id is readable and rerun preflight.",
      stage: "S01",
      evidenceRef: machineIdHash
    });
  }
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installer_version: installerVersion,
    installation_id: config.installation_id,
    host_fingerprint: {
      machine_id_hash: machineIdHash,
      os: "ubuntu-24.04",
      arch: config.host.arch,
      boot_id: bootId
    },
    config_hash: hashConfig(config),
    lock_hash: createHash("sha256").update(paths.stateDir).digest("hex"),
    stages: STAGE_IDS.map((id) => ({
      id,
      status: defaultStageStatus(id),
      observed_at: clock.now().toISOString(),
      checks: {},
      versions: {},
      applied_hashes: [],
      artifacts: [],
      dependencies_hash: stageDependenciesHash(id)
    })),
    pending_gates: [],
    in_flight_operation: null,
    last_error: null
  };
}

async function writeAtomicJson(fsAdapter: FilesystemAdapter, targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = `${targetPath}.tmp-${randomUUID()}`;
  await fsAdapter.ensureParentDir(targetPath);
  await fsAdapter.writeText(tempPath, content, 0o600);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(dir);
}

export async function saveState(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  state: SetupState,
  options?: SaveStateOptions
): Promise<void> {
  const paths = buildStatePaths(config);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const previousPath = `${paths.stateFile}.previous`;
  const existingManifest = await readStateCommitManifest(fsAdapter, config);
  const committedStateHash = stateHash(state);
  const checkpoint = options?.checkpoint;
  if (checkpoint !== undefined && checkpoint.stateHash !== committedStateHash) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "state_checkpoint_hash_mismatch",
      publicMessage: "Checkpoint metadata does not match persisted state hash.",
      nextAction: "Regenerate plan and retry apply.",
      evidenceRef: paths.stateFile
    });
  }
  let priorContent: string | null = null;
  try {
    priorContent = await fsAdapter.readText(paths.stateFile);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  await writeAtomicJson(fsAdapter, paths.stateFile, serialized);
  if (priorContent !== null) {
    const normalizedPrior = priorContent.endsWith("\n") ? priorContent : `${priorContent}\n`;
    await writeAtomicJson(fsAdapter, previousPath, normalizedPrior);
  }
  const manifest: StateCommitManifest = {
    schema_version: COMMIT_MANIFEST_SCHEMA_VERSION,
    installation_id: config.installation_id,
    generation: (existingManifest?.generation ?? 0) + 1,
    last_state_hash: committedStateHash,
    updated_at: new Date().toISOString(),
    ...(() => {
      if (checkpoint !== undefined) {
        return {
          last_effect_checkpoint: {
            attempt_id: checkpoint.attemptId,
            operation_id: checkpoint.operationId,
            stage: checkpoint.stage,
            state_hash: checkpoint.stateHash,
            sequence: checkpoint.sequence,
            updated_at: new Date().toISOString()
          }
        };
      }
      if (existingManifest?.last_effect_checkpoint !== undefined) {
        return {
          last_effect_checkpoint: existingManifest.last_effect_checkpoint
        };
      }
      return {};
    })()
  };
  await persistStateCommitManifest(fsAdapter, paths.commitManifestFile, manifest);
}

export async function recordEffectCheckpoint(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  checkpoint: {
    attemptId: string;
    operationId: string;
    stage: StageId;
    sequence: number;
    stateHash: string;
  }
): Promise<void> {
  const paths = buildStatePaths(config);
  const manifest = await readStateCommitManifest(fsAdapter, config);
  if (manifest === null) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_commit_manifest_missing",
      publicMessage: "State commit manifest is missing while recording checkpoint evidence.",
      nextAction: "Run recover and reconcile state/journal evidence before retrying mutations.",
      evidenceRef: paths.commitManifestFile
    });
  }
  if (manifest.last_state_hash !== checkpoint.stateHash) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_commit_manifest_state_mismatch",
      publicMessage: "Checkpoint evidence does not match current persisted state generation.",
      nextAction: "Run recover and reconcile state/journal evidence before retrying mutations.",
      evidenceRef: paths.commitManifestFile
    });
  }
  const nextManifest: StateCommitManifest = {
    ...manifest,
    generation: manifest.generation + 1,
    updated_at: new Date().toISOString(),
    last_effect_checkpoint: {
      attempt_id: checkpoint.attemptId,
      operation_id: checkpoint.operationId,
      stage: checkpoint.stage,
      state_hash: checkpoint.stateHash,
      sequence: checkpoint.sequence,
      updated_at: new Date().toISOString()
    }
  };
  await persistStateCommitManifest(fsAdapter, paths.commitManifestFile, nextManifest);
}

export async function restorePrimaryState(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  state: SetupState
): Promise<void> {
  const paths = buildStatePaths(config);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const committedStateHash = stateHash(state);
  try {
    await writeAtomicJson(fsAdapter, paths.stateFile, serialized);
    const existingManifest = await readStateCommitManifest(fsAdapter, config);
    const manifest: StateCommitManifest = {
      schema_version: COMMIT_MANIFEST_SCHEMA_VERSION,
      installation_id: config.installation_id,
      generation: (existingManifest?.generation ?? 0) + 1,
      last_state_hash: committedStateHash,
      updated_at: new Date().toISOString(),
      ...(() => {
        const checkpoint = existingManifest?.last_effect_checkpoint;
        if (checkpoint !== undefined && checkpoint.state_hash === committedStateHash) {
          return { last_effect_checkpoint: checkpoint };
        }
        return {};
      })()
    };
    await persistStateCommitManifest(fsAdapter, paths.commitManifestFile, manifest);
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_primary_persist_failed",
      publicMessage: "Failed to persist recovered primary state snapshot.",
      nextAction: "Run recover again to resume recovery commit cleanup after fixing filesystem I/O.",
      retryable: true,
      evidenceRef: `${paths.stateFile}:${code ?? "unknown"}`
    });
  }
}

function parseEventLine(line: string): ParsedJournalEvent {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("event is not an object");
  }

  if (parsed.schema_version === JOURNAL_SCHEMA_VERSION) {
    const sequence = toSequence(parsed.sequence);
    const at = parsed.at;
    const installationId = parsed.installation_id;
    const attemptId = parsed.attempt_id;
    const operationId = parsed.operation_id;
    const stage = parsed.stage;
    const code = parsed.code;
    const message = parsed.message;
    const checksum = parsed.checksum;
    const stateHash = parsed.state_hash;

    if (
      sequence === null
      || typeof at !== "string"
      || typeof installationId !== "string"
      || installationId.length === 0
      || typeof attemptId !== "string"
      || attemptId.length === 0
      || typeof operationId !== "string"
      || operationId.length === 0
      || typeof stage !== "string"
      || !STAGE_ID_SET.has(stage as StageId)
      || !isJournalEventCode(code)
      || typeof message !== "string"
      || typeof checksum !== "string"
      || !SHA256_HEX_PATTERN.test(checksum)
    ) {
      throw new Error("invalid journal v2 record shape");
    }

    let checkpointStateHash: string | undefined;
    if (code === "checkpoint") {
      if (typeof stateHash !== "string" || !SHA256_HEX_PATTERN.test(stateHash)) {
        throw new Error("invalid checkpoint state hash");
      }
      checkpointStateHash = stateHash;
    } else if (stateHash !== undefined) {
      throw new Error("state hash is only valid for checkpoint records");
    }

    const recordWithoutChecksum: Omit<JournalEventRecord, "checksum"> = {
      schema_version: JOURNAL_SCHEMA_VERSION,
      sequence,
      at,
      installation_id: installationId,
      attempt_id: attemptId,
      operation_id: operationId,
      stage: stage as StageId,
      code,
      message,
      ...(checkpointStateHash === undefined ? {} : { state_hash: checkpointStateHash })
    };
    const expected = checksumForJournalEvent(recordWithoutChecksum);
    if (checksum !== expected) {
      throw new Error("invalid journal v2 checksum");
    }
    return {
      format: "v2",
      record: {
        ...recordWithoutChecksum,
        checksum
      }
    };
  }

  const sequence = toSequence(parsed.sequence);
  const at = parsed.at;
  const operationId = parsed.operation_id;
  const stage = parsed.stage;
  const code = parsed.code;
  const message = parsed.message;
  const checksum = parsed.checksum;
  if (
    sequence === null
    || typeof at !== "string"
    || typeof operationId !== "string"
    || operationId.length === 0
    || typeof stage !== "string"
    || !STAGE_ID_SET.has(stage as StageId)
    || typeof code !== "string"
    || code.length === 0
    || typeof message !== "string"
    || typeof checksum !== "string"
    || !SHA256_HEX_PATTERN.test(checksum)
  ) {
    throw new Error("invalid legacy journal record shape");
  }

  const legacyRecord: LegacyEventRecord = {
    sequence,
    at,
    operation_id: operationId,
    stage: stage as StageId,
    code,
    message,
    checksum
  };
  const expected = checksumForLegacyEvent({
    sequence: legacyRecord.sequence,
    at: legacyRecord.at,
    operation_id: legacyRecord.operation_id,
    stage: legacyRecord.stage,
    code: legacyRecord.code,
    message: legacyRecord.message
  });
  if (legacyRecord.checksum !== expected) {
    throw new Error("invalid legacy journal checksum");
  }
  return {
    format: "legacy",
    record: legacyRecord
  };
}

function parseJournalRecords(lines: string[], installationId: string): ParsedJournal {
  const records: ParsedJournalEvent[] = [];
  let parseError = false;
  let unknownOrder = false;
  let legacyFormat = false;
  let expectedSequence = 1;
  let latestCheckpoint: ParsedJournal["latestCheckpoint"] = null;

  const attempts = new Map<string, {
    stage: StageId;
    operationId: string;
    phase: "intent" | "effect" | "verify" | "checkpoint";
  }>();

  for (const line of lines) {
    let parsed: ParsedJournalEvent;
    try {
      parsed = parseEventLine(line);
    } catch {
      parseError = true;
      break;
    }
    records.push(parsed);
    const sequence = parsed.record.sequence;
    if (sequence !== expectedSequence) {
      unknownOrder = true;
    }
    expectedSequence = sequence + 1;

    if (parsed.format === "legacy") {
      legacyFormat = true;
      continue;
    }

    const record = parsed.record;
    if (record.installation_id !== installationId) {
      unknownOrder = true;
      continue;
    }
    const key = `${record.installation_id}:${record.attempt_id}`;
    const existing = attempts.get(key);
    if (existing === undefined) {
      if (record.code !== "intent") {
        unknownOrder = true;
        continue;
      }
      attempts.set(key, {
        stage: record.stage,
        operationId: record.operation_id,
        phase: "intent"
      });
      continue;
    }
    if (existing.stage !== record.stage || existing.operationId !== record.operation_id) {
      unknownOrder = true;
      continue;
    }
    if (
      (existing.phase === "intent" && record.code !== "effect")
      || (existing.phase === "effect" && record.code !== "verify")
      || (existing.phase === "verify" && record.code !== "checkpoint")
      || existing.phase === "checkpoint"
    ) {
      unknownOrder = true;
      continue;
    }

    existing.phase = record.code;
    attempts.set(key, existing);
    if (record.code === "checkpoint") {
      latestCheckpoint = {
        attemptId: record.attempt_id,
        operationId: record.operation_id,
        stage: record.stage,
        stateHash: record.state_hash!,
        sequence: record.sequence
      };
    }
  }

  const unresolvedOperationIds = Array.from(
    new Set(
      Array.from(attempts.values())
        .filter((attempt) => attempt.phase !== "checkpoint")
        .map((attempt) => attempt.operationId)
    )
  ).sort();

  if (legacyFormat) {
    unknownOrder = true;
  }

  return {
    records,
    parseError,
    unknownOrder,
    unresolvedOperationIds,
    legacyFormat,
    latestCheckpoint
  };
}

async function readJournalTextBounded(
  fsAdapter: FilesystemAdapter,
  eventsFile: string
): Promise<{ hasRecords: boolean; oversized: boolean; raw: string }> {
  let bounded: Awaited<ReturnType<FilesystemAdapter["readTextBounded"]>>;
  try {
    bounded = await fsAdapter.readTextBounded(eventsFile, MAX_JOURNAL_BYTES);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { hasRecords: false, oversized: false, raw: "" };
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_path_access_failed",
      publicMessage: "Unable to inspect event journal while evaluating installer state.",
      nextAction: "Fix filesystem permissions or I/O errors and rerun diagnostics.",
      evidenceRef: `${eventsFile}:${code ?? "unknown"}`
    });
  }

  if (bounded.truncated) {
    return { hasRecords: true, oversized: true, raw: "" };
  }
  if (bounded.text.trim().length === 0) {
    return { hasRecords: false, oversized: false, raw: "" };
  }
  return { hasRecords: true, oversized: false, raw: bounded.text };
}

export async function readRecoveryMarker(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<RecoveryMarkerRecord | null> {
  const markerPath = buildStatePaths(config).recoveryMarkerFile;
  if (!(await pathExistsStrict(fsAdapter, markerPath, "recovery marker"))) {
    return null;
  }
  const raw = await readTextStrict(fsAdapter, markerPath, "recovery marker");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_marker_invalid",
      publicMessage: "Recovery marker is unreadable or invalid JSON.",
      nextAction: "Run recover and inspect recovery marker integrity.",
      evidenceRef: markerPath
    });
  }
  if (!isRecord(parsed)) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_marker_invalid",
      publicMessage: "Recovery marker schema is invalid.",
      nextAction: "Run recover and inspect recovery marker integrity.",
      evidenceRef: markerPath
    });
  }
  const objectParsed = parsed;
  if (
    objectParsed.schema_version !== 1
    || typeof objectParsed.reason !== "string"
    || typeof objectParsed.observed_at !== "string"
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_marker_invalid",
      publicMessage: "Recovery marker schema is invalid.",
      nextAction: "Run recover and inspect recovery marker integrity.",
      evidenceRef: markerPath
    });
  }
  const recoveryCommit = objectParsed.recovery_commit;
  if (recoveryCommit !== undefined) {
    if (
      !isRecord(recoveryCommit)
      || (recoveryCommit.phase !== "prepared" && recoveryCommit.phase !== "primary_restored")
      || recoveryCommit.source !== "previous"
      || typeof recoveryCommit.candidate_state_hash !== "string"
      || !SHA256_HEX_PATTERN.test(recoveryCommit.candidate_state_hash)
      || typeof recoveryCommit.updated_at !== "string"
    ) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_marker_invalid",
        publicMessage: "Recovery marker commit metadata is invalid.",
        nextAction: "Run recover and inspect recovery marker integrity.",
        evidenceRef: markerPath
      });
    }
  }
  return objectParsed as RecoveryMarkerRecord;
}

export async function writeRecoveryMarkerRecord(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  marker: RecoveryMarkerRecord
): Promise<void> {
  const markerPath = buildStatePaths(config).recoveryMarkerFile;
  await persistRecoveryMarker(fsAdapter, markerPath, marker);
}

export async function clearRecoveryMarker(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<void> {
  const paths = buildStatePaths(config);
  if (!(await pathExistsStrict(fsAdapter, paths.recoveryMarkerFile, "recovery marker"))) {
    return;
  }
  try {
    await fsAdapter.remove(paths.recoveryMarkerFile, { force: true });
    await fsAdapter.fsyncDir(paths.stateDir);
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_marker_clear_failed",
      publicMessage: "Failed to clear recovery marker after recovery commit.",
      nextAction: "Inspect recovery marker and rerun recover once filesystem is healthy.",
      evidenceRef: `${paths.recoveryMarkerFile}:${code ?? "unknown"}`
    });
  }
}

export async function inspectJournalEvidence(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<JournalInspection> {
  const eventsFile = buildStatePaths(config).eventsFile;
  const journalText = await readJournalTextBounded(fsAdapter, eventsFile);
  if (!journalText.hasRecords) {
    return emptyJournalInspection(eventsFile);
  }
  if (journalText.oversized) {
    return {
      hasRecords: true,
      unresolvedOperationIds: [],
      parseError: false,
      unknownOrder: false,
      oversized: true,
      legacyFormat: false,
      latestCheckpoint: null,
      evidenceRef: eventsFile
    };
  }
  const lines = journalText.raw.split("\n").filter((line) => line.length > 0);
  const parsed = parseJournalRecords(lines, config.installation_id);
  return {
    hasRecords: true,
    unresolvedOperationIds: parsed.unresolvedOperationIds,
    parseError: parsed.parseError,
    unknownOrder: parsed.unknownOrder,
    oversized: false,
    legacyFormat: parsed.legacyFormat,
    latestCheckpoint: parsed.latestCheckpoint,
    evidenceRef: eventsFile
  };
}

export async function inspectStateEvidence(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<StateEvidenceSummary> {
  const paths = buildStatePaths(config);
  const marker = await readRecoveryMarker(fsAdapter, config);
  const stateExists = await pathExistsStrict(fsAdapter, paths.stateFile, "primary state");
  const previousExists = await pathExistsStrict(fsAdapter, `${paths.stateFile}.previous`, "previous state generation");
  const quarantineEntries = await listStateQuarantineEntries(fsAdapter, paths.stateDir);
  const journal = await inspectJournalEvidence(fsAdapter, config);
  const commitManifest = await readStateCommitManifest(fsAdapter, config);
  return {
    marker,
    stateExists,
    previousExists,
    quarantineEntries,
    journal,
    commitManifest
  };
}

export async function readEvents(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<ParsedJournalEvent[]> {
  const paths = buildStatePaths(config);
  const raw = await readJournalTextBounded(fsAdapter, paths.eventsFile);
  if (!raw.hasRecords) {
    return [];
  }
  if (raw.oversized) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "journal_recovery_required",
      publicMessage: "Event journal contains unresolved or corrupt records.",
      nextAction: "Run recover and preserve journal evidence before retrying mutations.",
      evidenceRef: paths.eventsFile
    });
  }
  const lines = raw.raw.split("\n").filter((line) => line.length > 0);
  const parsed = parseJournalRecords(lines, config.installation_id);
  if (parsed.parseError || parsed.unknownOrder) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "journal_recovery_required",
      publicMessage: "Event journal contains unresolved or corrupt records.",
      nextAction: "Run recover and preserve journal evidence before retrying mutations.",
      evidenceRef: paths.eventsFile
    });
  }
  return parsed.records;
}

export async function appendEvent(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  event: {
    operation_id: string;
    stage: StageId;
    code: JournalEventCode;
    message: string;
    attempt_id?: string;
    installation_id?: string;
    state_hash?: string;
    at?: string;
  }
): Promise<{
  sequence: number;
  attempt_id: string;
  operation_id: string;
  stage: StageId;
  code: JournalEventCode;
  state_hash?: string;
}> {
  const eventsPath = buildStatePaths(config).eventsFile;
  const existing = await readEvents(fsAdapter, config);
  const lastSequence = existing.length > 0 ? existing[existing.length - 1]?.record.sequence ?? 0 : 0;
  if (event.code === "checkpoint" && (event.state_hash === undefined || !SHA256_HEX_PATTERN.test(event.state_hash))) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "journal_event_invalid",
      publicMessage: "Checkpoint event requires valid state hash.",
      nextAction: "Fix journal event payload and retry.",
      evidenceRef: eventsPath
    });
  }
  const recordWithoutChecksum: Omit<JournalEventRecord, "checksum"> = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    sequence: lastSequence + 1,
    at: event.at ?? new Date().toISOString(),
    installation_id: event.installation_id ?? config.installation_id,
    attempt_id: event.attempt_id ?? `${event.operation_id}:legacy`,
    operation_id: event.operation_id,
    stage: event.stage,
    code: event.code,
    message: event.message,
    ...(event.code === "checkpoint" ? { state_hash: event.state_hash } : {})
  };
  const record: JournalEventRecord = {
    ...recordWithoutChecksum,
    checksum: checksumForJournalEvent(recordWithoutChecksum)
  };
  try {
    await fsAdapter.appendText(eventsPath, `${JSON.stringify(record)}\n`);
    await fsAdapter.fsyncFile(eventsPath);
    await fsAdapter.fsyncDir(path.dirname(eventsPath));
  } catch (error) {
    const code = errorCode(error);
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "journal_write_failed",
      publicMessage: "Failed to persist event journal update.",
      nextAction: "Preserve recovery evidence and rerun recover before mutating commands.",
      evidenceRef: `${eventsPath}:${code ?? "unknown"}`
    });
  }
  return {
    sequence: record.sequence,
    attempt_id: record.attempt_id,
    operation_id: record.operation_id,
    stage: record.stage,
    code: record.code,
    ...(record.state_hash === undefined ? {} : { state_hash: record.state_hash })
  };
}

export async function loadState(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  clock: Clock,
  config: SetupConfig,
  installerVersion: string,
  options?: LoadStateOptions
): Promise<SetupState> {
  const loadOptions: Required<LoadStateOptions> = {
    initializeIfMissing: options?.initializeIfMissing ?? true,
    persistConfigDrift: options?.persistConfigDrift ?? true,
    readOnly: options?.readOnly ?? false
  };
  const paths = buildStatePaths(config);
  const previousPath = `${paths.stateFile}.previous`;
  const evidence = await inspectStateEvidence(fsAdapter, config);

  if (evidence.marker !== null) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_required",
      publicMessage: "State recovery is required; automatic reinitialization is blocked.",
      nextAction: "Run 'factory-setup recover --config PATH' and resolve recovery evidence.",
      evidenceRef: paths.recoveryMarkerFile
    });
  }

  if (!evidence.stateExists) {
    if (evidence.commitManifest !== null && evidence.commitManifest.installation_id !== config.installation_id) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_commit_manifest_foreign",
        publicMessage: "State commit manifest belongs to a different installation.",
        nextAction: "Use recover with matching installation evidence; do not initialize over foreign state.",
        evidenceRef: paths.commitManifestFile
      });
    }
    const residualEvidencePresent = evidence.previousExists
      || evidence.quarantineEntries.length > 0
      || journalHasEvidence(evidence.journal)
      || evidence.commitManifest !== null;

    if (residualEvidencePresent) {
      const reason = evidence.previousExists
        && evidence.quarantineEntries.length === 0
        && !journalHasEvidence(evidence.journal)
        && evidence.commitManifest === null
        ? "state_primary_missing_previous_present"
        : "state_missing_with_recovery_evidence";
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason,
          previous_present: evidence.previousExists,
          quarantine_entries: evidence.quarantineEntries,
          journal_unresolved_operation_ids: evidence.journal.unresolvedOperationIds,
          journal_parse_error: evidence.journal.parseError,
          journal_oversized: evidence.journal.oversized,
          journal_unknown_order: evidence.journal.unknownOrder,
          journal_legacy_format: evidence.journal.legacyFormat,
          observed_at: clock.now().toISOString()
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_recovery_required",
        publicMessage: "Primary state is missing but recovery evidence is present; automatic initialization is blocked.",
        nextAction: "Run 'factory-setup recover --config PATH' before continuing.",
        evidenceRef: recoveryEvidenceReference(
          paths.stateDir,
          evidence.previousExists ? previousPath : "",
          evidence.quarantineEntries,
          evidence.journal,
          paths.commitManifestFile,
          evidence.commitManifest !== null
        )
      });
    }

    if (!loadOptions.initializeIfMissing) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_missing",
        publicMessage: "Recorded installer state is missing.",
        nextAction: "Run 'factory-setup recover --config PATH' before mutating commands.",
        evidenceRef: paths.stateFile
      });
    }
    const fresh = await initState(fsAdapter, processAdapter, clock, config, installerVersion);
    if (!loadOptions.readOnly) {
      await saveState(fsAdapter, config, fresh);
    }
    return fresh;
  }

  let parsedState: unknown;
  const stateRaw = await readTextStrict(fsAdapter, paths.stateFile, "primary state");
  try {
    parsedState = JSON.parse(stateRaw);
  } catch {
    if (!loadOptions.readOnly) {
      const quarantinePath = `${paths.stateFile}.corrupt-${Date.now()}`;
      await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
        schema_version: 1,
        reason: "state_corrupt_primary",
        state_file: paths.stateFile,
        quarantine_target: quarantinePath,
        previous_present: evidence.previousExists,
        observed_at: clock.now().toISOString()
      });
      await quarantinePrimaryState(fsAdapter, paths.stateFile, quarantinePath);
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_corrupt",
      publicMessage: "State file is corrupt; recovery is required.",
      nextAction: "Run 'factory-setup recover --config PATH' and inspect state evidence.",
      evidenceRef: paths.stateFile
    });
  }

  const validation = validateContractSchema("state", parsedState);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "state_schema_mismatch",
      publicMessage: `State schema mismatch: ${validation.errors.join("; ")}`,
      nextAction: "Recover state with a compatible installer release."
    });
  }

  const state = parsedState as SetupState;

  if (journalUncertainty(evidence.journal)) {
    if (!loadOptions.readOnly) {
      await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
        schema_version: 1,
        reason: "event_journal_uncertain",
        unresolved_operation_ids: evidence.journal.unresolvedOperationIds,
        parse_error: evidence.journal.parseError,
        unknown_order: evidence.journal.unknownOrder,
        oversized: evidence.journal.oversized,
        legacy_format: evidence.journal.legacyFormat,
        observed_at: clock.now().toISOString()
      });
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "journal_recovery_required",
      publicMessage: "Event journal contains unresolved or corrupt records; recovery is required.",
      nextAction: "Run 'factory-setup recover --config PATH' and reconcile event evidence.",
      evidenceRef: evidence.journal.evidenceRef
    });
  }

  const commitManifest = evidence.commitManifest;
  if (commitManifest === null) {
    if (journalHasEvidence(evidence.journal)) {
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason: "state_commit_manifest_missing",
          journal_present: evidence.journal.hasRecords,
          journal_latest_checkpoint: evidence.journal.latestCheckpoint,
          observed_at: clock.now().toISOString()
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_commit_manifest_missing",
        publicMessage: "State commit metadata is missing for recorded journal evidence.",
        nextAction: "Run 'factory-setup recover --config PATH' and reconcile committed state evidence.",
        evidenceRef: paths.commitManifestFile
      });
    }
  } else {
    if (commitManifest.installation_id !== config.installation_id) {
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason: "state_commit_manifest_installation_mismatch",
          manifest_installation_id: commitManifest.installation_id,
          expected_installation_id: config.installation_id,
          observed_at: clock.now().toISOString()
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_commit_manifest_installation_mismatch",
        publicMessage: "State commit metadata belongs to a different installation.",
        nextAction: "Run recover and reconcile installation evidence before mutating commands.",
        evidenceRef: paths.commitManifestFile
      });
    }

    const currentStateHash = stateHash(state);
    if (commitManifest.last_state_hash !== currentStateHash) {
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason: "state_generation_mismatch",
          manifest_state_hash: commitManifest.last_state_hash,
          current_state_hash: currentStateHash,
          observed_at: clock.now().toISOString()
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_generation_mismatch",
        publicMessage: "Primary state generation does not match committed state metadata.",
        nextAction: "Run 'factory-setup recover --config PATH' and reconcile state generations.",
        evidenceRef: paths.commitManifestFile
      });
    }

    const latestCheckpoint = evidence.journal.latestCheckpoint;
    const manifestCheckpoint = commitManifest.last_effect_checkpoint;
    if (latestCheckpoint !== null) {
      const checkpointMismatch = manifestCheckpoint === undefined
        || manifestCheckpoint.state_hash !== latestCheckpoint.stateHash
        || manifestCheckpoint.attempt_id !== latestCheckpoint.attemptId
        || manifestCheckpoint.operation_id !== latestCheckpoint.operationId
        || manifestCheckpoint.stage !== latestCheckpoint.stage
        || manifestCheckpoint.sequence !== latestCheckpoint.sequence;
      if (checkpointMismatch) {
        if (!loadOptions.readOnly) {
          await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
            schema_version: 1,
            reason: "state_checkpoint_proof_mismatch",
            journal_checkpoint: latestCheckpoint,
            manifest_checkpoint: manifestCheckpoint ?? null,
            observed_at: clock.now().toISOString()
          });
        }
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "state_checkpoint_proof_mismatch",
          publicMessage: "Journal checkpoint evidence does not match committed state metadata.",
          nextAction: "Run recover and reconcile committed state evidence before mutating commands.",
          evidenceRef: paths.commitManifestFile
        });
      }
    } else if (manifestCheckpoint !== undefined) {
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason: "state_checkpoint_evidence_missing",
          manifest_checkpoint: manifestCheckpoint,
          observed_at: clock.now().toISOString()
        });
      }
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_checkpoint_evidence_missing",
        publicMessage: "Committed checkpoint metadata exists without corresponding journal checkpoint evidence.",
        nextAction: "Run recover and reconcile journal/state evidence before mutating commands.",
        evidenceRef: evidence.journal.evidenceRef
      });
    }
  }

  const configHash = hashConfig(config);
  if (state.config_hash !== configHash) {
    state.last_error = {
      code: "config_drift",
      stage: "S01",
      operation_id: "config-drift",
      retryable: false,
      public_message: "Config hash differs from recorded state.",
      next_action: "Run 'factory-setup plan' to produce a new plan and obtain new approvals.",
      evidence_ref: paths.stateFile
    };
    state.stages = state.stages.map((stage) =>
      stage.id === "S01" && stage.status === "verified" ? { ...stage, status: "drifted" } : stage
    );
    if (loadOptions.persistConfigDrift && !loadOptions.readOnly) {
      await saveState(fsAdapter, config, state);
    }
  }
  return state;
}

export function updateObservedStage(
  state: SetupState,
  observation: StageObservation,
  status: StageStatus
): SetupState {
  return {
    ...state,
    stages: state.stages.map((stage) =>
      stage.id === observation.stageId
        ? {
            ...stage,
            status,
            observed_at: observation.observedAt,
            checks: observation.checks,
            versions: observation.versions
          }
        : stage
    )
  };
}

export function withInFlightOperation(
  state: SetupState,
  operation: SetupState["in_flight_operation"]
): SetupState {
  return {
    ...state,
    in_flight_operation: operation
  };
}

export function withLastError(state: SetupState, error: SetupState["last_error"]): SetupState {
  return {
    ...state,
    last_error: error
  };
}

export function stateHash(state: SetupState): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}
