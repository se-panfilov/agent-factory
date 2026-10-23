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
const MAX_JOURNAL_BYTES = 1024 * 1024;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const FALLBACK_MACHINE_ID_HASH = createHash("sha256").update("unknown-machine-id").digest("hex");

interface EventRecord {
  sequence: number;
  checksum: string;
  at: string;
  operation_id: string;
  stage: StageId;
  code: string;
  message: string;
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
  [key: string]: unknown;
}

export interface JournalInspection {
  hasRecords: boolean;
  unresolvedOperationIds: string[];
  parseError: boolean;
  unknownOrder: boolean;
  oversized: boolean;
  evidenceRef: string;
}

export interface StateEvidenceSummary {
  marker: RecoveryMarkerRecord | null;
  stateExists: boolean;
  previousExists: boolean;
  quarantineEntries: string[];
  journal: JournalInspection;
}

export interface StatePaths {
  stateDir: string;
  stateFile: string;
  eventsFile: string;
  recoveryMarkerFile: string;
}

export function buildStatePaths(config: SetupConfig): StatePaths {
  const stateDir = config.paths.setup_state_dir;
  return {
    stateDir,
    stateFile: path.join(stateDir, STATE_FILE),
    eventsFile: path.join(stateDir, EVENTS_FILE),
    recoveryMarkerFile: path.join(stateDir, RECOVERY_MARKER_FILE)
  };
}

export interface LoadStateOptions {
  initializeIfMissing?: boolean;
  persistConfigDrift?: boolean;
  readOnly?: boolean;
}

function checksumForEvent(record: Omit<EventRecord, "checksum">): string {
  return createHash("sha256")
    .update(
      `${record.sequence}|${record.at}|${record.operation_id}|${record.stage}|${record.code}|${record.message}`
    )
    .digest("hex");
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

function recoveryEvidenceReference(
  stateDir: string,
  previousPath: string,
  quarantineEntries: string[],
  journal: JournalInspection
): string {
  if (quarantineEntries.length > 0) {
    return path.join(stateDir, quarantineEntries[0] ?? "");
  }
  if (previousPath.length > 0) {
    return previousPath;
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

export async function saveState(fsAdapter: FilesystemAdapter, config: SetupConfig, state: SetupState): Promise<void> {
  const paths = buildStatePaths(config);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const previousPath = `${paths.stateFile}.previous`;
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
}

function parseEventLine(line: string): EventRecord {
  const parsed = JSON.parse(line) as EventRecord;
  const expected = checksumForEvent({
    sequence: parsed.sequence,
    at: parsed.at,
    operation_id: parsed.operation_id,
    stage: parsed.stage,
    code: parsed.code,
    message: parsed.message
  });
  if (parsed.checksum !== expected) {
    throw new Error("invalid event checksum");
  }
  return parsed;
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
  const objectParsed = parsed as Record<string, unknown>;
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
  return objectParsed as RecoveryMarkerRecord;
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
  let eventsStat: Awaited<ReturnType<FilesystemAdapter["stat"]>>;
  try {
    eventsStat = await fsAdapter.stat(eventsFile);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return emptyJournalInspection(eventsFile);
    }
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_path_access_failed",
      publicMessage: "Unable to inspect event journal while evaluating installer state.",
      nextAction: "Fix filesystem permissions or I/O errors and rerun diagnostics.",
      evidenceRef: `${eventsFile}:${code ?? "unknown"}`
    });
  }

  const rawSize = typeof eventsStat.size === "bigint" ? Number(eventsStat.size) : eventsStat.size;
  const size = Number.isFinite(rawSize) ? rawSize : Number.MAX_SAFE_INTEGER;
  if (size > MAX_JOURNAL_BYTES) {
    return {
      hasRecords: true,
      unresolvedOperationIds: [],
      parseError: false,
      unknownOrder: false,
      oversized: true,
      evidenceRef: eventsFile
    };
  }

  const raw = await readTextStrict(fsAdapter, eventsFile, "event journal");
  if (raw.trim().length === 0) {
    return emptyJournalInspection(eventsFile);
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  const intentSeen = new Set<string>();
  const receiptSeen = new Set<string>();
  let unknownOrder = false;
  for (const line of lines) {
    let parsed: EventRecord;
    try {
      parsed = parseEventLine(line);
    } catch {
      return {
        hasRecords: true,
        unresolvedOperationIds: [],
        parseError: true,
        unknownOrder: false,
        oversized: false,
        evidenceRef: eventsFile
      };
    }
    if (parsed.code === "intent") {
      intentSeen.add(parsed.operation_id);
      continue;
    }
    if (parsed.code === "receipt") {
      if (!intentSeen.has(parsed.operation_id)) {
        unknownOrder = true;
      }
      receiptSeen.add(parsed.operation_id);
      continue;
    }
    unknownOrder = true;
  }

  const unresolvedOperationIds = Array.from(intentSeen).filter((id) => !receiptSeen.has(id)).sort();
  return {
    hasRecords: true,
    unresolvedOperationIds,
    parseError: false,
    unknownOrder,
    oversized: false,
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
  return {
    marker,
    stateExists,
    previousExists,
    quarantineEntries,
    journal
  };
}

export async function readEvents(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<EventRecord[]> {
  const paths = buildStatePaths(config);
  const journal = await inspectJournalEvidence(fsAdapter, config);
  if (!journal.hasRecords) {
    return [];
  }
  if (journal.oversized || journal.parseError || journal.unknownOrder) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "journal_recovery_required",
      publicMessage: "Event journal contains unresolved or corrupt records.",
      nextAction: "Run recover and preserve journal evidence before retrying mutations.",
      evidenceRef: journal.evidenceRef
    });
  }

  const raw = await readTextStrict(fsAdapter, paths.eventsFile, "event journal");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => parseEventLine(line));
}

export async function appendEvent(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  event: Omit<EventRecord, "sequence" | "checksum" | "at">
): Promise<void> {
  const events = await readEvents(fsAdapter, config);
  const recordWithoutChecksum = {
    sequence: events.length + 1,
    at: new Date().toISOString(),
    operation_id: event.operation_id,
    stage: event.stage,
    code: event.code,
    message: event.message
  };
  const record: EventRecord = {
    ...recordWithoutChecksum,
    checksum: checksumForEvent(recordWithoutChecksum)
  };
  const eventsPath = buildStatePaths(config).eventsFile;
  await fsAdapter.appendText(eventsPath, `${JSON.stringify(record)}\n`);
  await fsAdapter.fsyncFile(eventsPath);
  await fsAdapter.fsyncDir(path.dirname(eventsPath));
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
    const residualEvidencePresent = evidence.previousExists
      || evidence.quarantineEntries.length > 0
      || journalHasEvidence(evidence.journal);

    if (residualEvidencePresent) {
      if (!loadOptions.readOnly) {
        await persistRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
          schema_version: 1,
          reason: "state_missing_with_recovery_evidence",
          previous_present: evidence.previousExists,
          quarantine_entries: evidence.quarantineEntries,
          journal_unresolved_operation_ids: evidence.journal.unresolvedOperationIds,
          journal_parse_error: evidence.journal.parseError,
          journal_oversized: evidence.journal.oversized,
          journal_unknown_order: evidence.journal.unknownOrder,
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
          evidence.journal
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
