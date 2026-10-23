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
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

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
  if (await fsAdapter.exists(paths.stateFile)) {
    priorContent = await fsAdapter.readText(paths.stateFile);
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

export async function readEvents(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<EventRecord[]> {
  const paths = buildStatePaths(config);
  if (!(await fsAdapter.exists(paths.eventsFile))) {
    return [];
  }
  const raw = await fsAdapter.readText(paths.eventsFile);
  if (raw.trim().length === 0) {
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  const events: EventRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    try {
      events.push(parseEventLine(line));
    } catch (error) {
      if (index === lines.length - 1) {
        const quarantinePath = `${paths.eventsFile}.quarantine-${Date.now()}.tail`;
        await fsAdapter.writeText(quarantinePath, `${line}\n`, 0o600);
        await fsAdapter.writeText(paths.eventsFile, `${lines.slice(0, index).join("\n")}\n`, 0o600);
        break;
      }
      throw error;
    }
  }
  return events;
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
  await fsAdapter.appendText(buildStatePaths(config).eventsFile, `${JSON.stringify(record)}\n`);
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
  if (await fsAdapter.exists(paths.recoveryMarkerFile)) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "recovery_required",
      publicMessage: "State recovery is required; automatic reinitialization is blocked.",
      nextAction: "Run 'factory-setup recover --config PATH' and resolve recovery evidence.",
      evidenceRef: paths.recoveryMarkerFile
    });
  }
  if (!(await fsAdapter.exists(paths.stateFile))) {
    if (await fsAdapter.exists(previousPath)) {
      await writeRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
        schema_version: 1,
        reason: "state_primary_missing_previous_present",
        previous_state: previousPath,
        observed_at: new Date().toISOString()
      });
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_primary_missing",
        publicMessage: "Primary state is missing while previous generation exists; recovery is required.",
        nextAction: "Run 'factory-setup recover --config PATH' before continuing.",
        evidenceRef: previousPath
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
  try {
    parsedState = JSON.parse(await fsAdapter.readText(paths.stateFile));
  } catch {
    const quarantinePath = `${paths.stateFile}.corrupt-${Date.now()}`;
    await fsAdapter.rename(paths.stateFile, quarantinePath);
    await writeRecoveryMarker(fsAdapter, paths.recoveryMarkerFile, {
      schema_version: 1,
      reason: "state_corrupt",
      quarantined_state: quarantinePath,
      observed_at: new Date().toISOString()
    });
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "state_corrupt",
      publicMessage: "State file is corrupt and was quarantined.",
      nextAction: "Run 'factory-setup recover --config PATH' and inspect quarantined state.",
      evidenceRef: quarantinePath
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
