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
  desiredHash: string;
  planHash: string;
}

export interface StageModule {
  id: StageId;
  dependencies: StageId[];
  supportedProfiles: Array<"supervised" | "service">;
  optional: boolean;
  requiredCapabilities: CapabilityName[];
  observe(ctx: StageContext): Promise<StageObservation>;
  plan(desired: unknown, observed: StageObservation): StagePlan;
  apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]>;
  verify(ctx: StageContext): Promise<StageReceipt[]>;
  recover(ctx: StageContext, interruptedOperation: StageOperation): Promise<StageReceipt[]>;
}
