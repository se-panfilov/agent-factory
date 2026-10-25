export const STAGE_IDS = [
  "S00",
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "S08",
  "S09",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14"
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export const CAPABILITY_NAMES = [
  "runner-readonly",
  "runner-live-smoke",
  "app-recover",
  "app-serve",
  "app-pause",
  "app-stop",
  "app-migrate",
  "app-status",
  "platform-browser-smoke",
  "platform-collector",
  "local-inference"
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const STAGE_STATUSES = [
  "pending",
  "planned",
  "applying",
  "installed",
  "verified",
  "awaiting_manual",
  "blocked",
  "failed",
  "skipped",
  "interrupted",
  "drifted"
] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

export const OPERATION_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type OperationRiskLevel = (typeof OPERATION_RISK_LEVELS)[number];

export const OPERATION_KINDS = [
  "observe",
  "mutate",
  "verify",
  "manual_gate",
  "recover"
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export enum ExitCode {
  Success = 0,
  CliOrSchemaError = 2,
  UnsupportedHostOrMissingPrivileges = 3,
  ManualActionRequired = 4,
  BlockedByMissingCapabilityOrEvidence = 5,
  OperationOrVerificationFailed = 6,
  LockOwnedByAnotherInstaller = 7,
  DriftOrRecoveryRequired = 8,
  SecurityBoundaryViolation = 9,
  OptionalRequestedStageFailed = 10,
  SigIntCleanupConfirmed = 130,
  SigTermCleanupConfirmed = 143
}

export interface StageOperation {
  id: string;
  stageId: StageId;
  kind: OperationKind;
  resourceId: string;
  risk: OperationRiskLevel;
  gateIds: string[];
  preconditions: string[];
  sideEffects: string[];
  timeoutSec: number;
  retryable: boolean;
}

export interface StageReceipt {
  operationId: string;
  stageId: StageId;
  resourceId: string;
  observedAt: string;
  checks: Record<string, string | number | boolean>;
  versions: Record<string, string>;
  artifacts: string[];
}

export interface StageError {
  code: string;
  stage: StageId;
  operationId: string;
  retryable: boolean;
  publicMessage: string;
  nextAction: string;
  evidenceRef: string;
}

export interface StagePlan {
  stageId: StageId;
  optional: boolean;
  requiredCapabilities: CapabilityName[];
  operations: StageOperation[];
  requiredGates: string[];
}

export interface StageObservation {
  stageId: StageId;
  status: StageStatus;
  checks: Record<string, string | number | boolean>;
  versions: Record<string, string>;
  observedAt: string;
}

export interface StageContext {
  installationId: string;
  contractVersion: "1.0.0";
  profile: "supervised" | "service";
  desiredHash: string;
  planHash: string;
  config: SetupConfig;
  /** Core supplies only the previous durably checkpointed operation in this stage. */
  previousOperationReceipt?: StageReceipt;
  completedOperationReceipts?: StageReceipt[];
}

export interface StageModule {
  id: StageId;
  dependencies: StageId[];
  supportedProfiles: Array<"supervised" | "service">;
  optional: boolean;
  requiredCapabilities: CapabilityName[];
  observe(ctx: StageContext): Promise<StageObservation>;
  plan(desired: unknown, observed: StageObservation): StagePlan;
  /** Non-executable policy observation, used before intent/checkpoint. Default: observe. */
  observePolicy?(ctx: StageContext): Promise<StageObservation>;
  /** Significant inputs beyond the canonical producer plan (no timestamps/volatile counters). */
  policyInputs?(observed: StageObservation): {checks: StageObservation["checks"]; versions: StageObservation["versions"]};
  /** Only rebase observation-derived identity/preconditions after core-proven own progress. Never gates/effects. */
  reconcilePolicyOperation?(ctx: StageContext, reviewed: StagePlan, current: StageOperation): Pick<StageOperation,"id"|"preconditions">;
  /** Read-only prerequisite check before in-flight/intent publication. */
  admitOperation?(ctx: StageContext, operation: Pick<StageOperation, "id" | "resourceId" | "preconditions">): Promise<void>;
  apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]>;
  /** Confirm operation-specific postconditions after effect evidence and before checkpoint. */
  verifyOperation?(ctx: StageContext, receipt: StageReceipt): Promise<void>;
  verify(ctx: StageContext): Promise<StageReceipt[]>;
  recover(ctx: StageContext, interruptedOperation: StageOperation): Promise<StageReceipt[]>;
}

export interface SetupConfig {
  schema_version: 1;
  contract_version: "1.0.0";
  installation_id: string;
  profile: "supervised" | "service";
  host: {
    os: "ubuntu-24.04";
    arch: "amd64" | "arm64";
    expected_user: string;
  };
  paths: {
    setup_state_dir: string;
    setup_cache_dir: string;
    setup_bin_dir: string;
    setup_node_dir: string;
    application_dir: string;
    application_state_dir: string;
    application_auth_dir: string;
    application_work_dir: string;
  };
  release: {
    archive_path: string;
    sha256: string;
    source_commit: string;
  };
  version_lock_path: string;
  selected_stages: StageId[];
  resource_profile: "daily3" | "standard";
  network: {
    mode: "cloud-only" | "hybrid";
    allow_paid_fallback: false;
    proxy_url?: string;
  };
  secret_refs: {
    auth_dir: string;
    ca_bundle_path?: string;
  };
  github: {
    repository_allowlist: string[];
  };
  optional_features: {
    inference: boolean;
    platforms: boolean;
  };
  operations?: {
    backup_path: string;
    retention_days: number;
    health_secret_ref?: string;
  };
}

export interface StateHostFingerprint {
  machine_id_hash: string;
  os: "ubuntu-24.04";
  arch: "amd64" | "arm64";
  boot_id: string;
}

export interface PersistedStageState {
  id: StageId;
  status: StageStatus;
  observed_at: string;
  checks: Record<string, string | number | boolean>;
  versions: Record<string, string>;
  applied_hashes: string[];
  artifacts: string[];
  dependencies_hash: string;
}

export interface PersistedGateState {
  id: string;
  operation_id: string;
  plan_hash: string;
  expires_at: string;
  status: "pending" | "approved" | "expired" | "rejected";
}

export interface PersistedInFlightOperation {
  id: string;
  stage_id: StageId;
  kind: OperationKind;
  started_at: string;
}

export interface SetupState {
  schema_version: 1;
  contract_version: "1.0.0";
  installer_version: string;
  installation_id: string;
  host_fingerprint: StateHostFingerprint;
  config_hash: string;
  lock_hash: string;
  stages: PersistedStageState[];
  pending_gates: PersistedGateState[];
  in_flight_operation: PersistedInFlightOperation | null;
  last_error: {
    code: string;
    stage: StageId;
    operation_id: string;
    retryable: boolean;
    public_message: string;
    next_action: string;
    evidence_ref: string;
  } | null;
}

export interface InstallerPlan {
  schema_version: 1;
  contract_version: "1.0.0";
  installation_id: string;
  desired_hash: string;
  plan_hash: string;
  created_at: string;
  stages: Array<{
    stage_id: StageId;
    optional: boolean;
    required_capabilities: CapabilityName[];
    operations: Array<{
      id: string;
      stage_id: StageId;
      kind: OperationKind;
      resource_id: string;
      risk: OperationRiskLevel;
      gate_ids: string[];
      preconditions: string[];
      side_effects: string[];
      timeout_sec: number;
      retryable: boolean;
    }>;
    required_gates: string[];
  }>;
}

export interface JsonEnvelope {
  schema_version: 1;
  command: string;
  installation_id: string;
  desired_hash: string;
  plan_hash: string | null;
  overall_status: string;
  stages: Array<{
    id: StageId;
    status: StageStatus;
    message: string;
  }>;
  manual_actions: string[];
  error: {
    code: string;
    stage: StageId | null;
    operation_id: string;
    retryable: boolean;
    public_message: string;
    next_action: string;
    evidence_ref: string;
  } | null;
  data?: Record<string, unknown>;
}
