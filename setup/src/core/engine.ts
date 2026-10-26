import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { NodeFilesystemAdapter, type FilesystemAdapter } from "../adapters/filesystem";
import { NodeHttpAdapter, type HttpAdapter } from "../adapters/http";
import { NodeProcessAdapter, type ProcessAdapter } from "../adapters/process";
import { NodeAptAdapter } from "../adapters/apt";
import { createNodePreflightProbe, createPreflightStage } from "../stages/preflight";
import { createSystemStage } from "../stages/system";
import { createAccessStage, createNodeAccessAdapter } from "../stages/access";
import { createNodeDockerAdapter } from "../adapters/docker";
import { createDockerStage } from "../stages/docker";
import { createNodeApplicationReleaseAdapter } from "../adapters/git";
import { createApplicationStage } from "../stages/application";
import { createConfigurationStage } from "../stages/configuration";
import { createVerificationStage } from "../stages/verification";
import { createAuthStage, readAuthStatus, runAuthLogin as executeAuthLogin, runSmokeCommand } from "../stages/auth";
import { createNodeProjectStageAdapter, createProjectStage } from "../stages/project";
import { createNodeSystemdAdapter } from "../adapters/systemd";
import { createServiceStage } from "../stages/service";
import { createOperationsStage } from "../stages/operations";
import { createInferenceStage, runInferenceDisable } from "../stages/inference";
import { createPlatformsStage } from "../stages/platforms";
import { createUpdateStage } from "../stages/update";
import { createBackup, verifyBackup } from "../operations/backup";
import { emergencyCancel } from "../operations/emergency";
import { hashConfig, initConfig, loadConfig, stableStringify, systemClock, type Clock } from "./config";
import { ExitCode, type InstallerPlan, type JsonEnvelope, type SetupConfig, type SetupState, type StageId, type StageModule, type StageReceipt, type StageContext, type StageStatus } from "./types";
import { setupError, toSetupError } from "./errors";
import { approveGate, ensureGateApproved, ensureNonInteractiveGates, expireGates, upsertPlanGates } from "./gates";
import { acquireLock, consumeCancelRequest, recoverLockOnly, requestCancel, type LockOwner } from "./lock";
import { assertPlanTime, buildStageClosure, createPlanFile, createRegistry, loadPlan, validatePlanConsistency, type StageRegistry } from "./plan";
import { carryOperationProgress, restoreOperationProgress } from "./progress";
import { assertCompletionPolicy, assertContinuingPolicy, assertProducerPolicy, policyFingerprint, readPolicyBasis, withPolicyBasis, type PolicyBasis } from "./policy";
import {
  appendEvent,
  assertEvidenceAdmission,
  buildStatePaths,
  clearRecoveryMarker,
  FALLBACK_MACHINE_ID_HASH,
  inspectStateEvidence,
  loadState,
  recordEffectCheckpoint,
  readStateCommitManifest,
  receiptHash,
  restorePrimaryState,
  saveState,
  stateHash,
  updateObservedStage,
  withInFlightOperation,
  withLastError,
  writeRecoveryMarkerRecord,
  type LoadStateOptions,
  type StateEvidenceSummary
} from "./state";
import { validateContractSchema } from "./validators";

export interface EngineDeps {
  fsAdapter: FilesystemAdapter;
  processAdapter: ProcessAdapter;
  httpAdapter: HttpAdapter;
  clock: Clock;
  installerVersion: string;
}

export interface CommandOptions {
  configPath: string;
  planPath?: string;
  stageId?: StageId;
  profile?: "supervised" | "service";
  gateId?: string;
  planHash?: string;
  nonInteractive?: boolean;
  refresh?: boolean;
  lockOnly?: boolean;
  emergency?: boolean;
  provider?: "live" | "fake";
  fixture?: "toy";
  backupId?: string;
}

function envelopeBase(
  command: string,
  config: SetupConfig | null,
  state: SetupState | null,
  planHash: string | null
): JsonEnvelope {
  return {
    schema_version: 1,
    command,
    installation_id: config?.installation_id ?? "unknown",
    desired_hash: config === null ? "unknown" : hashConfig(config),
    plan_hash: planHash,
    overall_status: "failed",
    stages: state?.stages.map((item) => ({
      id: item.id,
      status: item.status,
      message: ""
    })) ?? [],
    manual_actions: [],
    error: null
  };
}

function stageFromPlan(plan: InstallerPlan, stageId: StageId): InstallerPlan["stages"][number] {
  const stage = plan.stages.find((item) => item.stage_id === stageId);
  if (stage === undefined) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "stage_not_in_plan",
      publicMessage: `Stage '${stageId}' is absent in plan.`,
      nextAction: "Regenerate the plan for the required stage.",
      stage: stageId
    });
  }
  return stage;
}

const GENERIC_APPLY_FORBIDDEN_STAGES = new Set<StageId>(["S08", "S14"]);

interface SelectedStageStatus {
  id: StageId;
  status: StageStatus;
  optional: boolean;
  checks: Record<string, string | number | boolean>;
}

function blockedExitCodeForStage(stage: SelectedStageStatus): ExitCode {
  if (stage.id === "S01") {
    return ExitCode.UnsupportedHostOrMissingPrivileges;
  }
  if (stage.id === "S00" && stage.checks.bootstrap_receipt_present === false) {
    return ExitCode.BlockedByMissingCapabilityOrEvidence;
  }
  return ExitCode.BlockedByMissingCapabilityOrEvidence;
}

function chooseDominantFailure(current: ExitCode | null, candidate: ExitCode): ExitCode {
  const priority: ExitCode[] = [
    ExitCode.SecurityBoundaryViolation,
    ExitCode.DriftOrRecoveryRequired,
    ExitCode.OperationOrVerificationFailed,
    ExitCode.BlockedByMissingCapabilityOrEvidence,
    ExitCode.ManualActionRequired,
    ExitCode.UnsupportedHostOrMissingPrivileges
  ];
  if (current === null) {
    return candidate;
  }
  const currentPriority = priority.indexOf(current);
  const candidatePriority = priority.indexOf(candidate);
  if (candidatePriority >= 0 && (currentPriority < 0 || candidatePriority < currentPriority)) {
    return candidate;
  }
  return current;
}

function aggregateStageStatuses(stages: SelectedStageStatus[]): {
  overallStatus: "ok" | "blocked" | "failed";
  exitCode: ExitCode;
} {
  let mandatoryFailure: ExitCode | null = null;
  let optionalFailure = false;
  for (const stage of stages) {
    if (stage.status === "verified") {
      continue;
    }
    if (stage.status === "skipped" && stage.optional) {
      continue;
    }

    if (stage.optional) {
      optionalFailure = true;
      continue;
    }

    if (stage.status === "drifted" || stage.status === "interrupted") {
      mandatoryFailure = chooseDominantFailure(mandatoryFailure, ExitCode.DriftOrRecoveryRequired);
      continue;
    }
    if (stage.status === "blocked") {
      mandatoryFailure = chooseDominantFailure(mandatoryFailure, blockedExitCodeForStage(stage));
      continue;
    }
    if (stage.status === "failed") {
      mandatoryFailure = chooseDominantFailure(mandatoryFailure, ExitCode.OperationOrVerificationFailed);
      continue;
    }
    mandatoryFailure = chooseDominantFailure(mandatoryFailure, ExitCode.BlockedByMissingCapabilityOrEvidence);
  }

  if (mandatoryFailure !== null) {
    return {
      overallStatus: mandatoryFailure === ExitCode.UnsupportedHostOrMissingPrivileges
        || mandatoryFailure === ExitCode.ManualActionRequired
        || mandatoryFailure === ExitCode.BlockedByMissingCapabilityOrEvidence
        ? "blocked"
        : "failed",
      exitCode: mandatoryFailure
    };
  }

  if (optionalFailure) {
    return {
      overallStatus: "failed",
      exitCode: ExitCode.OptionalRequestedStageFailed
    };
  }

  return {
    overallStatus: "ok",
    exitCode: ExitCode.Success
  };
}

function bootstrapStage(fsAdapter: FilesystemAdapter): StageModule {
  return {
    id: "S00",
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(ctx) {
      const receiptPath = path.join(
        os.homedir(),
        ".local",
        "state",
        "agent-factory-setup",
        "bootstrap-receipt.json"
      );
      const exists = await fsAdapter.exists(receiptPath);
      return {
        stageId: "S00",
        status: exists ? "verified" : "blocked",
        checks: {
          bootstrap_receipt_present: exists
        },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan(_desired, observed) {
      return {
        stageId: "S00",
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: observed.checks.bootstrap_receipt_present === true ? [] : ["bootstrap-required"]
      };
    },
    async apply(ctx, _approvedPlan) {
      const observation = await this.observe(ctx);
      return [
        {
          operationId: "s00-bootstrap-check",
          stageId: "S00",
          resourceId: "bootstrap-receipt",
          observedAt: observation.observedAt,
          checks: observation.checks,
          versions: observation.versions,
          artifacts: []
        }
      ];
    },
    async verify(ctx) {
      return this.apply(ctx, {
        stageId: "S00",
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: []
      });
    },
    async recover(ctx) {
      return this.verify(ctx);
    }
  };
}

function defaultRegistry(fsAdapter: FilesystemAdapter, processAdapter: ProcessAdapter): StageRegistry {
  const aptAdapter = new NodeAptAdapter(processAdapter, fsAdapter);
  const dockerAdapter = createNodeDockerAdapter(processAdapter, fsAdapter);
  const applicationAdapter = createNodeApplicationReleaseAdapter(processAdapter, fsAdapter);
  const projectAdapter = createNodeProjectStageAdapter(fsAdapter, processAdapter);
  const systemdAdapter = createNodeSystemdAdapter(processAdapter, fsAdapter);
  return createRegistry([
    bootstrapStage(fsAdapter),
    createPreflightStage(createNodePreflightProbe(fsAdapter)),
    createSystemStage(aptAdapter),
    createAccessStage(createNodeAccessAdapter(processAdapter, fsAdapter, aptAdapter)),
    createDockerStage(dockerAdapter),
    createApplicationStage(applicationAdapter),
    createConfigurationStage(fsAdapter, processAdapter),
    createVerificationStage(fsAdapter, processAdapter),
    createAuthStage(fsAdapter, processAdapter),
    createProjectStage(fsAdapter, projectAdapter),
    createServiceStage(fsAdapter, systemdAdapter),
    createOperationsStage(fsAdapter, processAdapter),
    createInferenceStage(fsAdapter, processAdapter),
    createPlatformsStage(fsAdapter),
    createUpdateStage(fsAdapter, processAdapter)
  ]);
}

export class SetupEngine {
  private readonly deps: EngineDeps;
  private readonly registry: StageRegistry;

  constructor(deps?: Partial<EngineDeps>, registry?: StageRegistry) {
    this.deps = {
      fsAdapter: deps?.fsAdapter ?? new NodeFilesystemAdapter(),
      processAdapter: deps?.processAdapter ?? new NodeProcessAdapter(),
      httpAdapter: deps?.httpAdapter ?? new NodeHttpAdapter(),
      clock: deps?.clock ?? systemClock,
      installerVersion: deps?.installerVersion ?? "0.0.1"
    };
    this.registry = registry ?? defaultRegistry(this.deps.fsAdapter, this.deps.processAdapter);
  }

  async run(command: string, options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    try {
      switch (command) {
        case "init":
          return await this.runInit(options);
        case "preflight":
          return await this.runPreflight(options);
        case "plan":
          return await this.runPlan(options);
        case "apply":
          return await this.runApply(options);
        case "status":
          return await this.runStatus(options);
        case "resume":
          return await this.runResume(options);
        case "verify":
          return await this.runVerify(options);
        case "gate-list":
          return await this.runGateList(options);
        case "gate-approve":
          return await this.runGateApprove(options);
        case "cancel":
          return await this.runCancel(options);
        case "recover":
          return await this.runRecover(options);
        case "backup-create":
          return await this.runBackupCreate(options);
        case "backup-verify":
          return await this.runBackupVerify(options);
        case "restore":
          return await this.runRestore(options);
        case "auth-login":
          return await this.runAuthLogin(options);
        case "auth-status":
          return await this.runAuthStatus(options);
        case "smoke":
          return await this.runSmoke(options);
        case "inference-disable":
          return await this.runInferenceDisable(options);
        case "inference-probe":
          return await this.runInferenceProbe(options);
        case "update-plan":
          return await this.runUpdatePlan(options);
        case "update-apply":
          return await this.runUpdateApply(options);
        default:
          throw setupError({
            exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
            code: "unsupported_command",
            publicMessage: `Command '${command}' is not implemented in P02 scope.`,
            nextAction: "Use commands from init/preflight/plan/apply/status/resume/verify/gate/auth/smoke/update/inference/cancel/recover/backup/restore."
          });
      }
    } catch (error) {
      const setup = toSetupError(error);
      const envelope: JsonEnvelope = {
        schema_version: 1,
        command,
        installation_id: "unknown",
        desired_hash: "unknown",
        plan_hash: options.planHash ?? null,
        overall_status: "failed",
        stages: [],
        manual_actions: [setup.nextAction],
        error: {
          code: setup.code,
          stage: setup.stage,
          operation_id: setup.operationId,
          retryable: setup.retryable,
          public_message: setup.message,
          next_action: setup.nextAction,
          evidence_ref: setup.evidenceRef
        }
      };
      return { envelope, exitCode: setup.exitCode };
    }
  }

  private async refreshStageObservation(
    state: SetupState,
    config: SetupConfig,
    stageId: StageId,
    planHash: string
  ): Promise<SetupState> {
    const stage = this.registry.byId.get(stageId);
    if (stage === undefined) {
      return state;
    }
    const observation = await stage.observe({
      installationId: config.installation_id,
      contractVersion: "1.0.0",
      profile: config.profile,
      desiredHash: hashConfig(config),
      planHash,
      config
    });
    return updateObservedStage(state, observation, observation.status);
  }

  private stageContext(config: SetupConfig, desiredHash: string, planHash: string): StageContext {
    return {
      installationId: config.installation_id,
      contractVersion: "1.0.0" as const,
      profile: config.profile,
      desiredHash,
      planHash,
      config
    };
  }

  private async loadStateWithOptions(config: SetupConfig, options?: LoadStateOptions): Promise<SetupState> {
    return loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion,
      options
    );
  }

  private assertOrdinaryOwner(config: SetupConfig, stage: StageId): void {
    const uid = this.deps.processAdapter.uid();
    if (uid === 0 || uid < 0) {
      throw setupError({
        exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
        code: "owner_identity_invalid",
        publicMessage: "Installer must run as ordinary owner account for mutation paths.",
        nextAction: "Run as configured non-root owner user.",
        stage
      });
    }
    const username = this.deps.processAdapter.username();
    if (username !== config.host.expected_user) {
      throw setupError({
        exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
        code: "owner_identity_mismatch",
        publicMessage: "Current user does not match configured owner identity.",
        nextAction: "Use the configured owner account from setup config.",
        stage,
        evidenceRef: `${username}!=${config.host.expected_user}`
      });
    }
  }

  private assertOrdinaryEffectAdmission(state: SetupState): void {
    if (state.in_flight_operation !== null) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "in_flight_operation_present",
        publicMessage: "State contains an unfinished operation and requires explicit recovery.",
        nextAction: "Run recover and reconcile pending operation evidence before retrying mutations.",
        stage: state.in_flight_operation.stage_id,
        operationId: state.in_flight_operation.id
      });
    }
  }

  private async loadRecoveryCandidate(previousPath: string): Promise<SetupState> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.deps.fsAdapter.readText(previousPath));
    } catch {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_invalid",
        publicMessage: "Recovery candidate snapshot is unreadable or invalid JSON.",
        nextAction: "Inspect state.previous and recovery marker evidence before retrying recover.",
        evidenceRef: previousPath
      });
    }
    const validation = validateContractSchema("state", parsed);
    if (!validation.ok) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_invalid",
        publicMessage: `Recovery candidate schema mismatch: ${validation.errors.join("; ")}`,
        nextAction: "Use a reviewed installer release compatible with recorded state schema.",
        evidenceRef: previousPath
      });
    }
    return parsed as SetupState;
  }

  private async assertRecoveryCandidateTrusted(candidate: SetupState, config: SetupConfig, evidenceRef: string): Promise<void> {
    if (candidate.installation_id !== config.installation_id) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_foreign_installation",
        publicMessage: "Recovery candidate belongs to a different installation.",
        nextAction: "Preserve evidence and provide the correct setup config for this installation.",
        evidenceRef
      });
    }
    if (candidate.host_fingerprint.os !== config.host.os || candidate.host_fingerprint.arch !== config.host.arch) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_host_mismatch",
        publicMessage: "Recovery candidate host fingerprint does not match configured host identity.",
        nextAction: "Use the original host/config pair or reconcile evidence manually.",
        evidenceRef
      });
    }
    const expectedLockHash = createHash("sha256").update(config.paths.setup_state_dir).digest("hex");
    if (candidate.lock_hash !== expectedLockHash) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_lock_mismatch",
        publicMessage: "Recovery candidate lock hash does not match current installation path.",
        nextAction: "Preserve state evidence and recover with matching installation paths.",
        evidenceRef
      });
    }
    const machineIdHash = await this.deps.processAdapter.machineIdHash();
    if (!/^[0-9a-f]{64}$/.test(machineIdHash) || machineIdHash === FALLBACK_MACHINE_ID_HASH) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_host_identity_unavailable",
        publicMessage: "Host machine identity is unavailable for trusted recovery candidate validation.",
        nextAction: "Fix machine identity source and rerun recover without deleting existing evidence.",
        evidenceRef
      });
    }
    if (candidate.host_fingerprint.machine_id_hash !== machineIdHash) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_candidate_host_mismatch",
        publicMessage: "Recovery candidate machine identity does not match this host.",
        nextAction: "Preserve evidence and run recovery on the original host.",
        evidenceRef
      });
    }
  }

  private journalUnsafeForRecovery(evidence: StateEvidenceSummary): boolean {
    return evidence.journal.oversized
      || evidence.journal.parseError
      || evidence.journal.unknownOrder
      || evidence.journal.legacyFormat
      || evidence.journal.unresolvedOperationIds.length > 0;
  }

  private checkpointMatchesManifest(evidence: StateEvidenceSummary): boolean {
    const manifestCheckpoint = evidence.commitManifest?.last_effect_checkpoint;
    const latestCheckpoint = evidence.journal.latestCheckpoint;
    if (manifestCheckpoint === undefined) {
      return latestCheckpoint === null;
    }
    if (latestCheckpoint === null) {
      return false;
    }
    return manifestCheckpoint.attempt_id === latestCheckpoint.attemptId
      && manifestCheckpoint.operation_id === latestCheckpoint.operationId
      && manifestCheckpoint.stage === latestCheckpoint.stage
      && manifestCheckpoint.sequence === latestCheckpoint.sequence
      && manifestCheckpoint.state_hash === latestCheckpoint.stateHash;
  }

  private async assertRecoveryCleanupAdmission(
    config: SetupConfig,
    paths: ReturnType<typeof buildStatePaths>,
    evidence: StateEvidenceSummary,
    candidateStateHash: string,
    unresolvedNextAction: string
  ): Promise<SetupState> {
    await assertEvidenceAdmission(this.deps.fsAdapter, config, evidence);
    if (!evidence.stateExists) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Recovery marker indicates committed primary state, but current primary state is missing.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.stateFile
      });
    }
    if (evidence.quarantineEntries.length > 0) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Recovery evidence contains quarantined primary snapshots requiring manual reconciliation.",
        nextAction: unresolvedNextAction,
        evidenceRef: path.join(paths.stateDir, evidence.quarantineEntries[0] ?? "")
      });
    }
    if (this.journalUnsafeForRecovery(evidence)) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Recovery evidence contains unsafe journal history that cannot be reconciled automatically.",
        nextAction: unresolvedNextAction,
        evidenceRef: evidence.journal.evidenceRef
      });
    }
    if (evidence.commitManifest === null) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Committed state manifest is missing; cleanup cannot prove recovered generation safety.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.commitManifestFile
      });
    }
    if (evidence.commitManifest.installation_id !== config.installation_id) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Commit metadata installation identity does not match current config.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.commitManifestFile
      });
    }
    if (!this.checkpointMatchesManifest(evidence)) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Recovery cleanup cannot prove journal checkpoint identity against commit metadata.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.commitManifestFile
      });
    }

    const restoredPrimary = await this.loadRecoveryCandidate(paths.stateFile);
    await this.assertRecoveryCandidateTrusted(restoredPrimary, config, paths.stateFile);
    if (restoredPrimary.in_flight_operation !== null) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Primary state still contains unfinished operation evidence after recovery commit.",
        nextAction: unresolvedNextAction,
        stage: restoredPrimary.in_flight_operation.stage_id,
        operationId: restoredPrimary.in_flight_operation.id,
        evidenceRef: paths.stateFile
      });
    }
    const restoredHash = stateHash(restoredPrimary);
    if (restoredHash !== candidateStateHash) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Recovery commit marker does not match current primary snapshot.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.stateFile
      });
    }
    if (evidence.commitManifest.last_state_hash !== restoredHash) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "recovery_unresolved",
        publicMessage: "Commit manifest generation does not match recovered primary state.",
        nextAction: unresolvedNextAction,
        evidenceRef: paths.commitManifestFile
      });
    }
    return restoredPrimary;
  }

  private stageStatusesForSelection(
    state: SetupState,
    stageIds: StageId[]
  ): SelectedStageStatus[] {
    return stageIds.map((id) => {
      const persisted = state.stages.find((entry) => entry.id === id);
      const stageDef = this.registry.byId.get(id);
      return {
        id,
        status: persisted?.status ?? "pending",
        optional: stageDef?.optional ?? false,
        checks: persisted?.checks ?? {}
      };
    });
  }

  private validateApplyPlanAdmission(config: SetupConfig, plan: InstallerPlan): void {
    const stageIds = plan.stages.map((stage) => stage.stage_id);
    const uniqueStageIds = new Set(stageIds);
    if (uniqueStageIds.size !== stageIds.length) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "plan_stage_duplicate",
        publicMessage: "Plan contains duplicate stage entries.",
        nextAction: "Regenerate plan with deterministic stage closure."
      });
    }

    const operationIds = new Set<string>();
    for (const stage of plan.stages) {
      if (GENERIC_APPLY_FORBIDDEN_STAGES.has(stage.stage_id)) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "entrypoint_policy_blocked",
          publicMessage: `Stage ${stage.stage_id} requires a dedicated command and is blocked in generic apply.`,
          nextAction: stage.stage_id === "S14"
            ? "Use dedicated update workflow once Q5 update implementation is qualified."
            : "Use dedicated auth/smoke commands for S08 flows.",
          stage: stage.stage_id
        });
      }
      const stageDef = this.registry.byId.get(stage.stage_id);
      if (stageDef === undefined) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "unsupported_stage",
          publicMessage: `Stage '${stage.stage_id}' is not implemented.`,
          nextAction: "Use a release that supports all planned stages.",
          stage: stage.stage_id
        });
      }
      if (!stageDef.supportedProfiles.includes(config.profile)) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "stage_profile_unsupported",
          publicMessage: `Stage '${stage.stage_id}' is not supported by profile '${config.profile}'.`,
          nextAction: "Use a compatible profile or regenerate plan.",
          stage: stage.stage_id
        });
      }
      const expectedCapabilities = new Set(stageDef.requiredCapabilities);
      for (const capability of stageDef.requiredCapabilities) {
        if (!stage.required_capabilities.includes(capability)) {
          throw setupError({
            exitCode: ExitCode.CliOrSchemaError,
            code: "plan_capability_missing",
            publicMessage: `Plan omits required capability '${capability}' for stage '${stage.stage_id}'.`,
            nextAction: "Regenerate plan with complete capability requirements.",
            stage: stage.stage_id
          });
        }
      }
      for (const capability of stage.required_capabilities) {
        if (!expectedCapabilities.has(capability)) {
          throw setupError({
            exitCode: ExitCode.CliOrSchemaError,
            code: "plan_capability_mismatch",
            publicMessage: `Plan capability '${capability}' is not declared by stage '${stage.stage_id}'.`,
            nextAction: "Regenerate plan with reviewed stage capability set.",
            stage: stage.stage_id
          });
        }
      }

      const requiredSet = new Set(stage.required_gates);
      for (const operation of stage.operations) {
        if (operation.stage_id !== stage.stage_id || operationIds.has(operation.id)) throw setupError({exitCode:ExitCode.CliOrSchemaError,
          code:"plan_operation_identity_invalid",publicMessage:"Operation parent or globally unique ID is inconsistent.",nextAction:"Generate a plan with canonical unique operation identities.",stage:stage.stage_id});
        operationIds.add(operation.id);
        for (const gateId of operation.gate_ids) {
          if (!requiredSet.has(gateId)) {
            throw setupError({
              exitCode: ExitCode.CliOrSchemaError,
              code: "plan_gate_representation_mismatch",
              publicMessage: `Gate '${gateId}' for operation '${operation.id}' is not listed in stage required_gates.`,
              nextAction: "Regenerate plan to keep stage and operation gate declarations consistent.",
              stage: stage.stage_id,
              operationId: operation.id
            });
          }
        }
      }
    }

    const dependencySet = new Set<StageId>();
    for (const stage of plan.stages) {
      for (const dependency of this.registry.byId.get(stage.stage_id)?.dependencies ?? []) {
        dependencySet.add(dependency);
      }
    }
    const roots = stageIds.filter((id) => !dependencySet.has(id));
    const expectedClosure = buildStageClosure(this.registry, roots.length > 0 ? roots : stageIds);
    for (const stage of plan.stages) {
      for (const dependency of this.registry.byId.get(stage.stage_id)?.dependencies ?? []) {
        const dependencyIndex = stageIds.indexOf(dependency);
        const stageIndex = stageIds.indexOf(stage.stage_id);
        if (dependencyIndex < 0 || dependencyIndex > stageIndex) {
          throw setupError({
            exitCode: ExitCode.CliOrSchemaError,
            code: "plan_dependency_order_invalid",
            publicMessage: `Plan dependency ordering is invalid for stage '${stage.stage_id}'.`,
            nextAction: "Regenerate the plan and avoid manual edits.",
            stage: stage.stage_id
          });
        }
      }
    }

    const expectedSet = new Set(expectedClosure);
    for (const stageId of stageIds) {
      if (!expectedSet.has(stageId)) {
        throw setupError({
          exitCode: ExitCode.CliOrSchemaError,
          code: "plan_stage_closure_invalid",
          publicMessage: `Plan contains stage '${stageId}' outside dependency closure.`,
          nextAction: "Regenerate plan from selected stage closure.",
          stage: stageId
        });
      }
    }
  }

  private async consumeCancelOrThrow(config: SetupConfig, owner: LockOwner): Promise<void> {
    const cancelRequested = await consumeCancelRequest(this.deps.fsAdapter, config, owner);
    if (cancelRequested) {
      throw setupError({
        exitCode: ExitCode.SigIntCleanupConfirmed,
        code: "cancel_requested",
        publicMessage: "Cancellation request consumed before next mutation.",
        nextAction: "Inspect state and run resume if needed."
      });
    }
  }

  private mandatoryStagesSucceeded(state: SetupState, plan: InstallerPlan): boolean {
    for (const stagePlan of plan.stages) {
      if (stagePlan.optional) {
        continue;
      }
      const persisted = state.stages.find((entry) => entry.id === stagePlan.stage_id);
      if (persisted?.status !== "verified") {
        return false;
      }
    }
    return true;
  }

  private validateEffectReceipts(
    stagePlan: InstallerPlan["stages"][number],
    effectOperations: InstallerPlan["stages"][number]["operations"],
    receipts: StageReceipt[]
  ): Map<string, StageReceipt> {
    const expectedByOperation = new Map(
      effectOperations.map((operation) => [operation.id, operation] as const)
    );
    const matched = new Map<string, StageReceipt>();
    for (const receipt of receipts) {
      if (receipt.stageId !== stagePlan.stage_id) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "stage_effect_receipt_stage_mismatch",
          publicMessage: `Stage ${stagePlan.stage_id} returned receipt for unexpected stage '${receipt.stageId}'.`,
          nextAction: "Preserve state/journal evidence and run recover before retrying apply.",
          stage: stagePlan.stage_id
        });
      }
      const planned = expectedByOperation.get(receipt.operationId);
      if (planned === undefined) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "stage_effect_receipt_unplanned",
          publicMessage: `Stage ${stagePlan.stage_id} returned unplanned operation receipt '${receipt.operationId}'.`,
          nextAction: "Preserve state/journal evidence and run recover before retrying apply.",
          stage: stagePlan.stage_id
        });
      }
      if (matched.has(receipt.operationId)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "stage_effect_receipt_duplicate",
          publicMessage: `Stage ${stagePlan.stage_id} returned duplicate receipt for operation '${receipt.operationId}'.`,
          nextAction: "Preserve state/journal evidence and run recover before retrying apply.",
          stage: stagePlan.stage_id,
          operationId: receipt.operationId
        });
      }
      if (planned.resource_id !== receipt.resourceId) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "stage_effect_receipt_resource_mismatch",
          publicMessage: `Stage ${stagePlan.stage_id} receipt resource mismatch for operation '${receipt.operationId}'.`,
          nextAction: "Preserve state/journal evidence and run recover before retrying apply.",
          stage: stagePlan.stage_id,
          operationId: receipt.operationId,
          evidenceRef: `${planned.resource_id}!=${receipt.resourceId}`
        });
      }
      matched.set(receipt.operationId, receipt);
    }

    const missing = effectOperations
      .filter((operation) => !matched.has(operation.id))
      .map((operation) => operation.id);
    if (missing.length > 0) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "stage_effect_receipt_missing",
        publicMessage: `Stage ${stagePlan.stage_id} did not provide effect receipts for all planned operations.`,
        nextAction: "Preserve state/journal evidence and run recover before retrying apply.",
        stage: stagePlan.stage_id,
        evidenceRef: missing.join(",")
      });
    }

    return matched;
  }

  private async runInit(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    if (options.profile === undefined) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "profile_required",
        publicMessage: "init requires --profile supervised|service",
        nextAction: "Run init with --profile supervised or --profile service."
      });
    }
    const config = await initConfig(
      this.deps.fsAdapter,
      options.configPath,
      options.profile,
      this.deps.processAdapter.username()
    );
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState;
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: true });
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("init", config, state, null);
    envelope.overall_status = "ok";
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runPreflight(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const stage = this.registry.byId.get("S01");
    if (stage === undefined) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "unsupported_stage",
        publicMessage: "S01 preflight stage is not registered.",
        nextAction: "Use an installer release that provides S01."
      });
    }
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let observationStatus: StageStatus = "blocked";
    let observationChecks: Record<string, string | number | boolean> = {};
    let observationVersions: Record<string, string> = {};
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: true });
      const observation = await stage.observe({
        installationId: config.installation_id,
        contractVersion: "1.0.0",
        profile: config.profile,
        desiredHash: hashConfig(config),
        planHash: "none",
        config
      });
      observationStatus = observation.status;
      observationChecks = observation.checks;
      observationVersions = observation.versions;
      state = updateObservedStage(state, observation, observation.status);
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }

    const envelope = envelopeBase("preflight", config, state, null);
    envelope.overall_status = observationStatus === "blocked" ? "blocked" : "ok";
    envelope.data = {
      checks: observationChecks,
      versions: observationVersions
    };
    return {
      envelope,
      exitCode: observationStatus === "blocked" ? ExitCode.UnsupportedHostOrMissingPrivileges : ExitCode.Success
    };
  }

  private async requestHash(file: string): Promise<string> {
    let raw: Awaited<ReturnType<FilesystemAdapter["readTextBounded"]>>;
    try { raw = await this.deps.fsAdapter.readTextBounded(file, 1024 * 1024); }
    catch { throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"request_input_unreadable",publicMessage:"Reviewed config/plan cannot be read for admission.",nextAction:"Restore bounded read access and review the request before retrying."}); }
    if (raw.text.includes("\ufffd") || raw.text.includes("\0")) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"request_input_encoding_invalid",publicMessage:"Config/plan requires unambiguous UTF-8 JSON text.",nextAction:"Regenerate the reviewed input without invalid encoding or NUL bytes."});
    if (raw.truncated) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"request_input_oversized",publicMessage:"Config/plan exceeds bounded admission input size.",nextAction:"Provide a bounded reviewed config/plan."});
    return createHash("sha256").update(raw.text).digest("hex");
  }

  private async assertRequestUnchanged(options: CommandOptions, configHash: string, planHash?: string): Promise<void> {
    if (await this.requestHash(options.configPath) !== configHash || (planHash !== undefined && options.planPath !== undefined && await this.requestHash(options.planPath) !== planHash)) {
      throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"request_changed_after_read",publicMessage:"Config/plan bytes changed while waiting for admission.",nextAction:"Generate/review a new plan; the in-memory request was not executed."});
    }
  }

  private async policyObservation(stage: StageModule, ctx: StageContext) {
    return stage.observePolicy ? stage.observePolicy(ctx) : stage.observe(ctx);
  }

  private async runPlan(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const configBytes = await this.requestHash(options.configPath);
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state: SetupState;
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let result: Awaited<ReturnType<typeof createPlanFile>> | null = null;
    try {
      await this.assertRequestUnchanged(options, configBytes);
      state = await this.loadStateWithOptions(config, { initializeIfMissing: true });
      if (state.in_flight_operation !== null) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "in_flight_operation_present",
          publicMessage: "State contains an unfinished operation; automatic re-plan is blocked.",
          nextAction: "Run recover/resume workflow and reconcile pending operation.",
          stage: state.in_flight_operation.stage_id,
          operationId: state.in_flight_operation.id
        });
      }
      const stageId = options.stageId ?? null;
      const progressContexts = new Map<StageId, StageContext>();
      const admittedBases = new Map<StageId, PolicyBasis | null>();
      const boundReceipts = (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations
        ?.filter(entry => entry.config_hash === hashConfig(config)).map(entry => entry.receipt) ?? [];
      for (const id of buildStageClosure(this.registry, stageId === null ? config.selected_stages : [stageId])) {
        const stage = this.registry.byId.get(id)!;
        const ctx = { ...this.stageContext(config, hashConfig(config), "planning"), completedOperationReceipts: boundReceipts };
        const previous = await restoreOperationProgress(this.deps.fsAdapter, stage, ctx, readPolicyBasis(state, stage));
        progressContexts.set(id, ctx);
        admittedBases.set(id, previous);
      }
      result = await createPlanFile(this.deps.fsAdapter, config, this.registry, stageId, this.deps.clock, boundReceipts, progressContexts);
      state = expireGates(state, this.deps.clock);
      for (const stagePlan of result.plan.stages) {
        const stage = this.registry.byId.get(stagePlan.stage_id)!;
        const ctx = { ...progressContexts.get(stage.id)!, ...this.stageContext(config, result.plan.desired_hash, result.plan.plan_hash) };
        ctx.completedOperationReceipts = (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations?.filter(e => e.config_hash === hashConfig(config)).map(e => e.receipt) ?? [];
        const observed = await this.policyObservation(stage, ctx);
        const source = result.observations.get(stage.id)!;
        assertProducerPolicy(stage, config, stagePlan, source);
        const previous = admittedBases.get(stage.id) ?? null;
        const carried = stage.verifyProgress && previous ? carryOperationProgress(stage, ctx, previous, source) : undefined;
        const completed: string[] = carried?.map(entry => entry.currentId) ?? [];
        const prior = previous?.configHash === hashConfig(config) ? stage.plan(config,previous.source) : null;
        for (const operation of carried === undefined ? stage.plan(config,source).operations : []) {
          const old = prior?.operations.find(o=>o.id===operation.id);
          const receipt = ctx.completedOperationReceipts.find(r=>r.operationId===operation.id && r.stageId===stage.id && r.resourceId===operation.resourceId);
          const samePolicy = previous === null || (old !== undefined && previous.completed.includes(operation.id) && stableStringify(old)===stableStringify(operation));
          if (!receipt || !samePolicy) continue;
          try {
            if (stage.verifyOperation) { await stage.verifyOperation(ctx,receipt); completed.push(operation.id); }
            else if (observed.status==="verified") { await stage.verify(ctx); completed.push(operation.id); }
            else throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"legacy_policy_progress_unverified",publicMessage:"Legacy partial progress has no current postcondition verifier.",nextAction:"Reconcile existing effects before enrolling a new reviewed policy.",stage:stage.id});
          } catch(error) {
            const failure=toSetupError(error);
            if (failure.code==="legacy_policy_progress_unverified" || ![ExitCode.DriftOrRecoveryRequired,ExitCode.ManualActionRequired].includes(failure.exitCode)) throw error;
            // Proven old effect whose resource has since drifted: explicit new review may reconcile it.
            // Unknown journal outcomes were already rejected by ordinary evidence admission.
          }
        }
        state = withPolicyBasis(state, stage, {version:stage.verifyProgress ? 2 : 1,planHash:result.plan.plan_hash,configHash:hashConfig(config),source,
          expected:policyFingerprint(stage, config, observed),completed, ...(stage.verifyProgress ? {progress:carried ?? []} : {})});
        for (const gateId of stagePlan.required_gates) {
          state = upsertPlanGates(
            state,
            result.plan.plan_hash,
            `stage:${stagePlan.stage_id}`,
            [gateId],
            this.deps.clock
          );
        }
        for (const operation of stagePlan.operations) {
          state = upsertPlanGates(state, result.plan.plan_hash, operation.id, operation.gate_ids, this.deps.clock);
        }
      }
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    if (result === null) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "plan_generation_failed",
        publicMessage: "Plan generation did not produce a result.",
        nextAction: "Inspect previous errors and rerun plan."
      });
    }
    const envelope = envelopeBase("plan", config, state, result.plan.plan_hash);
    envelope.overall_status = "ok";
    envelope.data = {
      plan_path: result.planPath,
      stage_closure: result.stageClosure,
      required_approvals: state.pending_gates.filter((gate) => gate.plan_hash === result.plan.plan_hash).map((gate) => ({
        id: gate.id,
        operation_id: gate.operation_id,
        status: gate.status,
        expires_at: gate.expires_at
      }))
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runApply(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    if (options.planPath === undefined) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "plan_required",
        publicMessage: "apply requires --plan PATH",
        nextAction: "Run 'factory-setup plan' and pass --plan."
      });
    }
    const configBytes = await this.requestHash(options.configPath), planBytes = await this.requestHash(options.planPath);
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const plan = await loadPlan(this.deps.fsAdapter, options.planPath);
    validatePlanConsistency(config, plan);
    this.validateApplyPlanAdmission(config, plan);

    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let activeStage: StageId | null = null;
    let persistFailure = false;
    const policies = new Map<StageId, PolicyBasis>();
    try {
      await this.assertRequestUnchanged(options, configBytes, planBytes);
      const lockedConfig = await loadConfig(this.deps.fsAdapter, options.configPath);
      const lockedPlan = await loadPlan(this.deps.fsAdapter, options.planPath);
      if (stableStringify(config)!==stableStringify(lockedConfig) || stableStringify(plan)!==stableStringify(lockedPlan)) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"request_changed_after_read",publicMessage:"Parsed request changed during lock acquisition.",nextAction:"Regenerate and review the plan."});
      assertPlanTime(plan, this.deps.clock);
      state = await this.loadStateWithOptions(config, { initializeIfMissing: true });
      state = expireGates(state, this.deps.clock);
      this.assertOrdinaryEffectAdmission(state);
      ensureNonInteractiveGates(state, plan.plan_hash, options.nonInteractive ?? false, this.deps.clock);
      await this.consumeCancelOrThrow(config, lock.owner);
      let reviewMismatch = false;
      // Validate every stage before publishing any applying state or target intent.
      for (const proposed of plan.stages) {
        const stage = this.registry.byId.get(proposed.stage_id)!;
        const ctx = this.stageContext(config, plan.desired_hash, plan.plan_hash);
        ctx.completedOperationReceipts = (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations?.filter(e => e.config_hash === hashConfig(config)).map(e => e.receipt) ?? [];
        const existing = await restoreOperationProgress(this.deps.fsAdapter, stage, ctx, readPolicyBasis(state, stage));
        if (existing===null && proposed.operations.length>0 && ctx.completedOperationReceipts.some(r=>r.stageId===stage.id)) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,
          code:"legacy_policy_review_required",publicMessage:"Legacy known progress needs an explicit current producer review before further actions.",nextAction:"Generate/review a plan; matching committed operations will be reverified rather than replayed.",stage:stage.id});
        const observed = await this.policyObservation(stage, ctx);
        const basis: PolicyBasis = existing ?? {version:1,planHash:plan.plan_hash,configHash:hashConfig(config),source:observed,expected:policyFingerprint(stage, config, observed),completed:[]};
        assertProducerPolicy(stage, config, proposed, basis.source);
        if (basis.planHash !== plan.plan_hash || basis.configHash !== hashConfig(config)) reviewMismatch = true;
        if (!stage.verifyProgress && basis.completed.some(id => !proposed.operations.some(o => o.id === id))) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_progress_invalid",publicMessage:"Committed progress is outside the reviewed operation sequence.",nextAction:"Preserve state and reconcile progress."});
        const first = proposed.operations.find(o => !basis.completed.includes(o.id));
        if (first) await stage.admitOperation?.(ctx, {id:first.id,resourceId:first.resource_id,preconditions:first.preconditions});
        if (policyFingerprint(stage, config, observed)!==basis.expected) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_observation_drift",publicMessage:"Significant producer policy inputs changed since review or verified progress.",nextAction:"Generate/review a new plan; no new operation was admitted.",stage:stage.id});
        policies.set(stage.id, basis);
      }
      if (reviewMismatch) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_review_required",publicMessage:"Plan is not the current committed producer review.",nextAction:"Generate and review a new plan."});

      for (const stagePlan of plan.stages) {
        assertPlanTime(plan, this.deps.clock);
        await this.assertRequestUnchanged(options, configBytes, planBytes);
        assertPlanTime(plan, this.deps.clock);
        activeStage = stagePlan.stage_id;
        const stage = this.registry.byId.get(stagePlan.stage_id);
        if (stage === undefined) {
          throw setupError({
            exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
            code: "unsupported_stage",
            publicMessage: `Stage '${stagePlan.stage_id}' is not implemented.`,
            nextAction: "Use a release that supports all planned stages.",
            stage: stagePlan.stage_id
          });
        }
        await this.consumeCancelOrThrow(config, lock.owner);
        const stageCtx = this.stageContext(config, plan.desired_hash, plan.plan_hash);
        stageCtx.completedOperationReceipts = (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations?.filter(e => e.config_hash === hashConfig(config)).map(e => e.receipt) ?? [];
        await restoreOperationProgress(this.deps.fsAdapter, stage, stageCtx, policies.get(stage.id)!);
        const observation = await stage.observe(stageCtx);
        if (
          state.stages.some(
            (entry) => entry.id === stagePlan.stage_id && entry.status === "verified" && observation.status !== "verified"
          )
        ) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "state_resource_drift",
            publicMessage: `Recorded verified state drifted for stage ${stagePlan.stage_id}.`,
            nextAction: "Run verify/status --refresh and create a new plan.",
            stage: stagePlan.stage_id
          });
        }

        state = withPolicyBasis(state, stage, policies.get(stage.id)!);
        state = updateObservedStage(state, observation, "applying");
        for (const gateId of stagePlan.required_gates) {
          ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, `stage:${stagePlan.stage_id}`);
        }
        for (const operation of stagePlan.operations) {
          for (const gateId of operation.gate_ids) {
            ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, operation.id);
          }
        }
        await saveState(this.deps.fsAdapter, config, state);
        await this.consumeCancelOrThrow(config, lock.owner);

        const executeWithApply = stagePlan.operations.some((operation) => operation.kind !== "verify");
        if (executeWithApply) {
          this.assertOrdinaryOwner(config, stagePlan.stage_id);
          for (const operation of stagePlan.operations) {
            let basis = policies.get(stage.id)!;
            if (basis.completed.includes(operation.id)) continue;
            assertPlanTime(plan, this.deps.clock);
            await this.assertRequestUnchanged(options, configBytes, planBytes);
            const current = await this.policyObservation(stage, stageCtx);
            await stage.admitOperation?.(stageCtx, {id:operation.id,resourceId:operation.resource_id,preconditions:operation.preconditions});
            if (policyFingerprint(stage, config, current)!==basis.expected) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_observation_drift",publicMessage:"Producer policy inputs changed before the next action.",nextAction:"Review a new plan before further effects.",stage:stage.id});
            assertContinuingPolicy(stage,config,stageCtx,basis,current);
            for (const gateId of stagePlan.required_gates) ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, `stage:${stagePlan.stage_id}`);
            for (const gateId of operation.gate_ids) ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, operation.id);
            await this.assertRequestUnchanged(options, configBytes, planBytes);
            assertPlanTime(plan, this.deps.clock);
            for (const gateId of stagePlan.required_gates) ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, `stage:${stagePlan.stage_id}`);
            for (const gateId of operation.gate_ids) ensureGateApproved(state, plan.plan_hash, gateId, this.deps.clock, operation.id);
            const attemptId = randomUUID();
            persistFailure = true;
            state = withInFlightOperation(state, {
              id: `${stagePlan.stage_id}:${operation.id}:${attemptId}`,
              stage_id: stagePlan.stage_id,
              kind: operation.kind,
              started_at: this.deps.clock.now().toISOString()
            });
            await saveState(this.deps.fsAdapter, config, state);
            await appendEvent(this.deps.fsAdapter, config, {
              operation_id: operation.id,
              stage: stagePlan.stage_id,
              code: "intent",
              message: `intent:${operation.id}`,
              attempt_id: attemptId
            });

            const receipts = await stage.apply(
              stageCtx,
              {
                stageId: stagePlan.stage_id,
                optional: stagePlan.optional,
                requiredCapabilities: stagePlan.required_capabilities,
                operations: [
                  {
                    id: operation.id,
                    stageId: operation.stage_id,
                    kind: operation.kind,
                    resourceId: operation.resource_id,
                    risk: operation.risk,
                    gateIds: operation.gate_ids,
                    preconditions: operation.preconditions,
                    sideEffects: operation.side_effects,
                    timeoutSec: operation.timeout_sec,
                    retryable: operation.retryable
                  }
                ],
                requiredGates: stagePlan.required_gates
              }
            );
            const matchedReceipts = this.validateEffectReceipts(stagePlan, [operation], receipts);
            const receipt = matchedReceipts.get(operation.id);
            if (receipt === undefined) {
              throw setupError({
                exitCode: ExitCode.DriftOrRecoveryRequired,
                code: "stage_effect_receipt_missing",
                publicMessage: `Stage ${stagePlan.stage_id} did not provide effect evidence for operation '${operation.id}'.`,
                nextAction: "Preserve state and journal evidence, then run recover before retrying apply.",
                stage: stagePlan.stage_id,
                operationId: operation.id
              });
            }
            await appendEvent(this.deps.fsAdapter, config, {
              operation_id: operation.id,
              stage: stagePlan.stage_id,
              code: "effect",
              message: `effect:${receipt.resourceId}:${receiptHash(receipt)}`,
              attempt_id: attemptId
            });
            await stage.verifyOperation?.(stageCtx, receipt);
            await appendEvent(this.deps.fsAdapter, config, {
              operation_id: operation.id,
              stage: stagePlan.stage_id,
              code: "verify",
              message: `verify:postconditions:${receipt.resourceId}:${receiptHash(receipt)}`,
              attempt_id: attemptId
            });
            const canonical = stage.progressPolicyPlan?.(config, basis.source) ?? stage.plan(config, basis.source);
            const completedIds = [...basis.completed, operation.id];
            const progressCtx: StageContext = { ...stageCtx, completedOperationReceipts: [...(stageCtx.completedOperationReceipts ?? []), receipt] };
            if (stage.verifyProgress) progressCtx.operationProgress = {
              completed: canonical.operations.filter(item => completedIds.includes(item.id)), total: canonical.operations.length
            };
            const confirmed = await this.policyObservation(stage, progressCtx);
            const publication = canonical.operations.find(item => item.id === operation.id)!;
            basis = { ...basis, expected: policyFingerprint(stage, config, confirmed), completed: completedIds,
              ...(stage.verifyProgress ? { version: 2, progress: [...(basis.progress ?? []), {
                currentId: operation.id, operation: publication, attemptId, receiptHash: receiptHash(receipt)
              }] } : {}) };
            policies.set(stage.id, basis);
            state = withPolicyBasis(state, stage, basis);
            state = withInFlightOperation(state, null);
            await saveState(this.deps.fsAdapter, config, state);
            const committedStateHash = stateHash(state);
            const checkpointRecord = await appendEvent(this.deps.fsAdapter, config, {
              operation_id: operation.id,
              stage: stagePlan.stage_id,
              code: "checkpoint",
              message: "checkpoint:operation-complete",
              attempt_id: attemptId,
              state_hash: committedStateHash
            });
            await recordEffectCheckpoint(this.deps.fsAdapter, config, {
              attemptId,
              operationId: operation.id,
              stage: stagePlan.stage_id,
              sequence: checkpointRecord.sequence,
              stateHash: committedStateHash,
              receipt
            });
            persistFailure = false;
            stageCtx.previousOperationReceipt = receipt;
            if (progressCtx.operationProgress) stageCtx.operationProgress = progressCtx.operationProgress;
            stageCtx.completedOperationReceipts = [...(stageCtx.completedOperationReceipts ?? []), receipt];
            if (receipt.checks.manual_pause_required === true) {
              state = updateObservedStage(state, { stageId: stagePlan.stage_id, status: "awaiting_manual", checks: receipt.checks,
                versions: receipt.versions, observedAt: receipt.observedAt }, "awaiting_manual");
              await saveState(this.deps.fsAdapter, config, state);
              throw setupError({ exitCode: ExitCode.ManualActionRequired, code: "operation_manual_pause",
                publicMessage: "Operation completed; a new owner login session is required before continuing.",
                nextAction: "Log out and back in, run plan, review remaining operations and approve the new plan, then resume.", stage: stagePlan.stage_id });
            }
            await this.consumeCancelOrThrow(config, lock.owner);
          }
        }
        persistFailure = true;
        await stage.verify(stageCtx);
        const observedAfter = await stage.observe(stageCtx);
        assertCompletionPolicy(stage,config,stageCtx,policies.get(stage.id)!,observedAfter);
        const optionalSkipAccepted = stagePlan.optional
          && !executeWithApply
          && observedAfter.status === "skipped";
        if (observedAfter.status !== "verified" && !optionalSkipAccepted) {
          let exitCode = ExitCode.OperationOrVerificationFailed;
          if (observedAfter.status === "blocked") {
            exitCode = blockedExitCodeForStage({
              id: stagePlan.stage_id,
              status: observedAfter.status,
              optional: stagePlan.optional,
              checks: observedAfter.checks
            });
          } else if (observedAfter.status === "drifted" || observedAfter.status === "interrupted") {
            exitCode = ExitCode.DriftOrRecoveryRequired;
          }
          throw setupError({
            exitCode,
            code: "postcondition_not_verified",
            publicMessage: `Stage ${stagePlan.stage_id} did not reach expected terminal status after apply (observed: ${observedAfter.status}).`,
            nextAction: "Inspect stage checks and rerun with a fresh plan.",
            stage: stagePlan.stage_id
          });
        }
        const policyAfter = await this.policyObservation(stage,stageCtx);
        const factView = (observed: typeof observedAfter) => stage.observePolicy && stage.policyInputs
          ? stableStringify(stage.policyInputs(observed)) : policyFingerprint(stage,config,observed);
        if (factView(policyAfter)!==factView(observedAfter)) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_completion_input_drift",
          publicMessage:"Policy inputs changed after stage verification.",nextAction:"Reconcile resources and review a new plan before completion.",stage:stage.id});
        const completeBasis = {...policies.get(stage.id)!,expected:policyFingerprint(stage,config,policyAfter)};
        policies.set(stage.id,completeBasis);
        state = withPolicyBasis(state,stage,completeBasis);
        state = withInFlightOperation(state, null);
        state = updateObservedStage(state, observedAfter, optionalSkipAccepted ? "skipped" : "verified");
        await saveState(this.deps.fsAdapter, config, state, { finalVerified: true });
        persistFailure = false;
        await this.consumeCancelOrThrow(config, lock.owner);
      }

      if (state === null) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "state_unavailable_after_apply",
          publicMessage: "State became unavailable after apply execution.",
          nextAction: "Run recover and inspect state persistence.",
          evidenceRef: config.paths.setup_state_dir
        });
      }
      const envelope = envelopeBase("apply", config, state, plan.plan_hash);
      const selection = this.stageStatusesForSelection(state, plan.stages.map((entry) => entry.stage_id));
      const aggregate = aggregateStageStatuses(selection);
      envelope.overall_status = aggregate.overallStatus;
      envelope.data = {
        applied_stages: plan.stages.map((entry) => entry.stage_id)
      };
      return { envelope, exitCode: aggregate.exitCode };
    } catch (error) {
      let setup = toSetupError(error);
      const failedStage = setup.stage ?? activeStage;
      if (setup.stage === null && failedStage !== null) {
        setup = setupError({ exitCode: setup.exitCode, code: setup.code, publicMessage: setup.message,
          nextAction: setup.nextAction, stage: failedStage, operationId: setup.operationId, retryable: setup.retryable, evidenceRef: setup.evidenceRef });
      }
      const failedStagePlan = failedStage === null ? null : plan.stages.find((entry) => entry.stage_id === failedStage);
      if (
        failedStagePlan?.optional === true
        && this.registry.byId.get(failedStagePlan.stage_id)?.optional === true
        && setup.exitCode !== ExitCode.OptionalRequestedStageFailed
        && state !== null
        && this.mandatoryStagesSucceeded(state, plan)
      ) {
        setup = setupError({
          exitCode: ExitCode.OptionalRequestedStageFailed,
          code: setup.code,
          publicMessage: setup.message,
          nextAction: setup.nextAction,
          stage: setup.stage,
          operationId: setup.operationId,
          retryable: setup.retryable,
          evidenceRef: setup.evidenceRef
        });
      }
      if (state !== null && persistFailure) {
        if (failedStage !== null) {
          const failureStatus: StageStatus = state.in_flight_operation?.stage_id === failedStage ? "interrupted"
            : setup.exitCode === ExitCode.ManualActionRequired ? "awaiting_manual"
            : setup.exitCode === ExitCode.OperationOrVerificationFailed ? "failed" : "blocked";
          state = { ...state, stages: state.stages.map(s => s.id === failedStage ? { ...s, status: failureStatus } : s) };
        }
        state = withLastError(state, {
          code: setup.code,
          stage: (setup.stage ?? "S01") as StageId,
          operation_id: setup.operationId,
          retryable: setup.retryable,
          public_message: setup.message,
          next_action: setup.nextAction,
          evidence_ref: setup.evidenceRef
        });
        state = withInFlightOperation(state, state.in_flight_operation === null ? null : state.in_flight_operation);
        await saveState(this.deps.fsAdapter, config, state);
      }
      throw setup;
    } finally {
      await lock.release();
    }
  }

  private async runStatus(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const selectedClosure = buildStageClosure(this.registry, config.selected_stages);
    let state: SetupState;
    if (options.refresh === true) {
      const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
      try {
        state = await this.loadStateWithOptions(config, {
          initializeIfMissing: false,
          persistConfigDrift: false,
          readOnly: false
        });
        for (const stageId of selectedClosure) {
          const stage = this.registry.byId.get(stageId);
          if (stage === undefined) {
            continue;
          }
          const observation = await stage.observe({
            ...this.stageContext(config, hashConfig(config), "status-refresh"),
            completedOperationReceipts: (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations?.filter(e => e.config_hash === hashConfig(config)).map(e => e.receipt) ?? []
          });
          const persisted = state.stages.find((item) => item.id === stageId);
          if (persisted?.status === "verified" && observation.status !== "verified") {
            state = updateObservedStage(state, observation, "drifted");
          } else {
            state = updateObservedStage(state, observation, observation.status);
          }
        }
        await saveState(this.deps.fsAdapter, config, state);
      } finally {
        await lock.release();
      }
    } else {
      state = await this.loadStateWithOptions(config, {
        initializeIfMissing: false,
        persistConfigDrift: false,
        readOnly: true
      });
    }
    const envelope = envelopeBase("status", config, state, null);
    const selectedStatuses = this.stageStatusesForSelection(state, selectedClosure);
    const aggregate = aggregateStageStatuses(selectedStatuses);
    envelope.overall_status = aggregate.overallStatus;
    envelope.data = {
      refreshed: options.refresh === true,
      recorded_state_only: options.refresh !== true,
      selected_stage_closure: selectedClosure,
      stage_age_seconds: selectedStatuses.reduce<Record<string, number>>((acc, item) => {
        const persisted = state.stages.find((entry) => entry.id === item.id);
        const observedAt = persisted?.observed_at;
        if (observedAt !== undefined) {
          acc[item.id] = Math.max(0, Math.floor((this.deps.clock.now().getTime() - new Date(observedAt).getTime()) / 1000));
        }
        return acc;
      }, {})
    };
    return { envelope, exitCode: aggregate.exitCode };
  }

  private async runResume(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const planPath = path.join(config.paths.setup_state_dir, "plan.json");
    if (!(await this.deps.fsAdapter.exists(planPath))) {
      const lock = await acquireLock(this.deps.fsAdapter,this.deps.processAdapter,config);
      try {
        this.assertOrdinaryEffectAdmission(await this.loadStateWithOptions(config,{initializeIfMissing:false,readOnly:true}));
        throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_required",publicMessage:"Resume requires an existing reviewed plan.",nextAction:"Generate/review a plan explicitly before resume."});
      } finally { await lock.release(); }
    }
    const result = await this.runApply({...options,planPath});
    return {...result,envelope:{...result.envelope,command:"resume"}};
  }

  private async runVerify(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const closure = options.stageId === undefined
      ? buildStageClosure(this.registry, config.selected_stages)
      : buildStageClosure(this.registry, [options.stageId]);
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let verifyingStage: StageId | null = null;
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      for (const stageId of closure) {
        const stage = this.registry.byId.get(stageId);
        if (stage === undefined) {
          continue;
        }
        verifyingStage = stageId;
        const ctx = { ...this.stageContext(config, hashConfig(config), "verify"),
          completedOperationReceipts: (await readStateCommitManifest(this.deps.fsAdapter, config))?.completed_operations?.filter(e => e.config_hash === hashConfig(config)).map(e => e.receipt) ?? [] };
        await stage.verify(ctx);
        const observation = await stage.observe(ctx);
        state = updateObservedStage(state, observation, observation.status);
      }
      await saveState(this.deps.fsAdapter, config, state);
    } catch (error) {
      const failure = toSetupError(error);
      if (state !== null && verifyingStage !== null) {
        const id = verifyingStage;
        state = { ...state, stages: state.stages.map(s => s.id === id ? { ...s,
          status: failure.exitCode === ExitCode.ManualActionRequired ? "awaiting_manual" : failure.exitCode === ExitCode.DriftOrRecoveryRequired ? "drifted" : "blocked",
          checks: { ...s.checks, current_verification_failed: true } } : s) };
        await saveState(this.deps.fsAdapter, config, state);
      }
      throw error;
    } finally {
      await lock.release();
    }
    if (state === null) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "state_unavailable_verify",
        publicMessage: "State is unavailable for verify result aggregation.",
        nextAction: "Run recover and retry verify.",
        evidenceRef: config.paths.setup_state_dir
      });
    }
    const envelope = envelopeBase("verify", config, state, null);
    const selectedStatuses = this.stageStatusesForSelection(state, closure);
    const aggregate = aggregateStageStatuses(selectedStatuses);
    envelope.overall_status = aggregate.overallStatus;
    envelope.data = {
      target_stage: options.stageId ?? "selected_stages",
      stage_closure: closure
    };
    return { envelope, exitCode: aggregate.exitCode };
  }

  private async runGateList(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = expireGates(
      await this.loadStateWithOptions(config, {
        initializeIfMissing: false,
        persistConfigDrift: false,
        readOnly: true
      }),
      this.deps.clock
    );
    const envelope = envelopeBase("gate list", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      pending_gates: state.pending_gates
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runGateApprove(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    if (options.gateId === undefined || options.planHash === undefined) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "gate_approve_args_missing",
        publicMessage: "gate approve requires --id and --plan-hash.",
        nextAction: "Run gate approve with both --id and --plan-hash."
      });
    }
    const configBytes = await this.requestHash(options.configPath);
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state: SetupState;
    const planPath = path.join(config.paths.setup_state_dir,"plan.json"), planBytes = await this.requestHash(planPath);
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    try {
      await this.assertRequestUnchanged({...options,planPath},configBytes,planBytes);
      const plan = await loadPlan(this.deps.fsAdapter,planPath);
      validatePlanConsistency(config,plan);
      if(plan.plan_hash!==options.planHash) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"gate_plan_mismatch",publicMessage:"Approval is not for the current reviewed plan.",nextAction:"Review the current plan and approve its exact identity."});
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      state = expireGates(state, this.deps.clock);
      try {
        assertPlanTime(plan,this.deps.clock);
        state = approveGate(state, options.gateId, options.planHash, this.deps.clock);
      } finally {
        await saveState(this.deps.fsAdapter, config, state);
      }
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("gate approve", config, state, options.planHash);
    envelope.overall_status = "ok";
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runCancel(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state: SetupState | null = null;
    try {
      state = await this.loadStateWithOptions(config, {
        initializeIfMissing: false,
        persistConfigDrift: false,
        readOnly: true
      });
    } catch {
      state = null;
    }
    if (options.emergency === true) {
      const result = await emergencyCancel(
        {
          processAdapter: this.deps.processAdapter
        },
        config
      );
      const envelope = envelopeBase("cancel", config, state, null);
      envelope.overall_status = "ok";
      envelope.data = {
        emergency: true,
        paused_marker: result.pausedMarkerPath,
        stopped_containers: result.stoppedContainers,
        skipped_foreign_containers: result.skippedForeignContainers
      };
      return { envelope, exitCode: ExitCode.Success };
    }
    const cancelPath = await requestCancel(this.deps.fsAdapter, config);
    const envelope = envelopeBase("cancel", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = { cancel_request: cancelPath };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runRecover(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const paths = buildStatePaths(config);
    const previousPath = `${paths.stateFile}.previous`;
    const unresolvedNextAction = "Preserve state/marker/journal evidence, run manual reconciliation, then rerun recover. Do not delete recovery artifacts.";

    if (options.lockOnly === true) {
      const recovered = await recoverLockOnly(this.deps.fsAdapter, this.deps.processAdapter, config);
      const evidence = await inspectStateEvidence(this.deps.fsAdapter, config);
      let state: SetupState | null = null;
      const blockers: string[] = [];
      if (evidence.marker !== null) {
        blockers.push(`recovery marker present (${evidence.marker.reason})`);
      }
      if (evidence.journal.hasRecords) {
        blockers.push("event journal contains historical or unresolved entries");
      }
      if (evidence.commitManifest !== null) {
        blockers.push("state commit manifest is present and requires full recovery admission");
      }
      if (evidence.stateExists && evidence.marker === null) {
        try {
          state = await this.loadStateWithOptions(config, {
            initializeIfMissing: false,
            persistConfigDrift: false,
            readOnly: true
          });
          if (state.in_flight_operation !== null) {
            blockers.push(`in-flight operation present (${state.in_flight_operation.id})`);
          }
        } catch (error) {
          blockers.push(`state diagnostic failed: ${toSetupError(error).code}`);
          state = null;
        }
      }
      const envelope = envelopeBase("recover", config, state, null);
      envelope.overall_status = "ok";
      envelope.data = {
        ...recovered,
        recovery_blockers: blockers
      };
      return { envelope, exitCode: ExitCode.Success };
    }

    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    try {
      const evidence = await inspectStateEvidence(this.deps.fsAdapter, config);
      await assertEvidenceAdmission(this.deps.fsAdapter, config, evidence);

      if (evidence.marker === null && evidence.stateExists) {
        state = await this.loadStateWithOptions(config, {
          initializeIfMissing: false,
          persistConfigDrift: false,
          readOnly: true
        });
        if (state.in_flight_operation !== null) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "recovery_unresolved",
            publicMessage: "Unfinished operation is still present; recovery cannot declare success.",
            nextAction: unresolvedNextAction,
            stage: state.in_flight_operation.stage_id,
            operationId: state.in_flight_operation.id,
            evidenceRef: paths.stateFile
          });
        }
        const envelope = envelopeBase("recover", config, state, null);
        envelope.overall_status = "ok";
        envelope.data = {
          outcome: "recovery_not_required",
          scope: "state_consistent"
        };
        return { envelope, exitCode: ExitCode.Success };
      }

      if (
        evidence.marker === null
        && !evidence.stateExists
        && !evidence.previousExists
        && evidence.quarantineEntries.length === 0
        && !evidence.journal.hasRecords
        && evidence.commitManifest === null
      ) {
        const envelope = envelopeBase("recover", config, null, null);
        envelope.overall_status = "ok";
        envelope.data = {
          outcome: "recovery_not_required",
          scope: "fresh_installation_without_state"
        };
        return { envelope, exitCode: ExitCode.Success };
      }

      const markerReason = evidence.marker?.reason ?? "marker_missing";
      const markerCommit = evidence.marker?.recovery_commit;
      const nowIso = this.deps.clock.now().toISOString();
      const commitManifest = evidence.commitManifest;

      if (commitManifest !== null && commitManifest.installation_id !== config.installation_id) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "recovery_unresolved",
          publicMessage: "Commit metadata installation identity does not match current config.",
          nextAction: unresolvedNextAction,
          evidenceRef: paths.commitManifestFile
        });
      }

      if (markerCommit?.phase === "primary_restored") {
        await this.assertRecoveryCleanupAdmission(
          config,
          paths,
          evidence,
          markerCommit.candidate_state_hash,
          unresolvedNextAction
        );
        await clearRecoveryMarker(this.deps.fsAdapter, config);
        state = await this.loadStateWithOptions(config, {
          initializeIfMissing: false,
          persistConfigDrift: false,
          readOnly: true
        });
        const envelope = envelopeBase("recover", config, state, null);
        envelope.overall_status = "ok";
        envelope.data = {
          outcome: "recovered_previous_generation",
          source: previousPath,
          marker_reason: markerReason,
          resumed_cleanup: true
        };
        return { envelope, exitCode: ExitCode.Success };
      }

      if (!evidence.previousExists) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "recovery_unresolved",
          publicMessage: "Recovery candidate snapshot is missing.",
          nextAction: unresolvedNextAction,
          evidenceRef: previousPath
        });
      }
      if (evidence.quarantineEntries.length > 0) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "recovery_unresolved",
          publicMessage: "Recovery evidence contains quarantined primary snapshots requiring manual reconciliation.",
          nextAction: unresolvedNextAction,
          evidenceRef: path.join(paths.stateDir, evidence.quarantineEntries[0] ?? "")
        });
      }
      if (this.journalUnsafeForRecovery(evidence)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "recovery_unresolved",
          publicMessage: "Recovery evidence contains unsafe journal history that cannot be reconciled automatically.",
          nextAction: unresolvedNextAction,
          evidenceRef: evidence.journal.evidenceRef
        });
      }

      const candidate = await this.loadRecoveryCandidate(previousPath);
      await this.assertRecoveryCandidateTrusted(candidate, config, previousPath);
      const candidateHash = stateHash(candidate);
      if (candidate.in_flight_operation !== null) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "recovery_unresolved",
          publicMessage: "Recovery candidate still contains unfinished operation evidence.",
          nextAction: unresolvedNextAction,
          stage: candidate.in_flight_operation.stage_id,
          operationId: candidate.in_flight_operation.id,
          evidenceRef: previousPath
        });
      }

      if (markerCommit?.phase === "prepared") {
        if (commitManifest?.last_effect_checkpoint?.state_hash !== candidateHash
          && !commitManifest?.clean_proof?.snapshot_hashes.includes(candidateHash)) {
          throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "recovery_unresolved",
            publicMessage: "Prepared candidate lacks clean completion proof.", nextAction: unresolvedNextAction });
        }
        if (candidateHash !== markerCommit.candidate_state_hash) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "recovery_unresolved",
            publicMessage: "Prepared recovery candidate changed since recovery decision was recorded.",
            nextAction: unresolvedNextAction,
            evidenceRef: previousPath
          });
        }
        if (commitManifest?.last_state_hash !== candidateHash && !commitManifest?.clean_proof?.snapshot_hashes.includes(candidateHash)) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "recovery_unresolved",
            publicMessage: "Prepared recovery candidate does not match committed manifest generation.",
            nextAction: unresolvedNextAction,
            evidenceRef: paths.commitManifestFile
          });
        }
        if (evidence.stateExists) {
          const preparedPrimary = await this.loadRecoveryCandidate(paths.stateFile);
          await this.assertRecoveryCandidateTrusted(preparedPrimary, config, paths.stateFile);
          if (preparedPrimary.in_flight_operation !== null) {
            throw setupError({
              exitCode: ExitCode.DriftOrRecoveryRequired,
              code: "recovery_unresolved",
              publicMessage: "Current primary state contains unfinished operation evidence and cannot be overwritten by prepared recovery.",
              nextAction: unresolvedNextAction,
              stage: preparedPrimary.in_flight_operation.stage_id,
              operationId: preparedPrimary.in_flight_operation.id,
              evidenceRef: paths.stateFile
            });
          }
          if (stateHash(preparedPrimary) !== markerCommit.candidate_state_hash) {
            throw setupError({
              exitCode: ExitCode.DriftOrRecoveryRequired,
              code: "recovery_unresolved",
              publicMessage: "Current primary state differs from prepared recovery decision.",
              nextAction: unresolvedNextAction,
              evidenceRef: paths.stateFile
            });
          }
          if (commitManifest?.last_state_hash !== candidateHash) {
            await restorePrimaryState(this.deps.fsAdapter, config, candidate);
          }
        } else {
          await restorePrimaryState(this.deps.fsAdapter, config, candidate);
        }
      } else {
        const canStartPreparedRecovery = (evidence.marker === null || evidence.marker.recovery_commit === undefined)
          && !evidence.stateExists
          && commitManifest !== null
          && (commitManifest.last_state_hash === candidateHash || commitManifest.clean_proof?.snapshot_hashes.includes(candidateHash) === true)
          && commitManifest.last_effect_checkpoint !== undefined
          && (commitManifest.last_effect_checkpoint.state_hash === candidateHash || commitManifest.clean_proof?.snapshot_hashes.includes(candidateHash) === true)
          && this.checkpointMatchesManifest(evidence)
          && evidence.journal.latestCheckpoint !== null;

        if (!canStartPreparedRecovery) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "recovery_unresolved",
            publicMessage: "Recovery outcome cannot be proven with current marker/journal evidence.",
            nextAction: unresolvedNextAction,
            evidenceRef: evidence.previousExists ? previousPath : paths.stateDir
          });
        }

        await writeRecoveryMarkerRecord(this.deps.fsAdapter, config, {
          schema_version: 1,
          reason: evidence.marker?.reason ?? "state_primary_missing_previous_present",
          observed_at: evidence.marker?.observed_at ?? nowIso,
          recovery_commit: {
            phase: "prepared",
            source: "previous",
            candidate_state_hash: candidateHash,
            source_manifest: commitManifest,
            updated_at: nowIso
          }
        });
        await restorePrimaryState(this.deps.fsAdapter, config, candidate);
      }

      await writeRecoveryMarkerRecord(this.deps.fsAdapter, config, {
        schema_version: 1,
        reason: evidence.marker?.reason ?? "state_primary_missing_previous_present",
        observed_at: evidence.marker?.observed_at ?? nowIso,
        recovery_commit: {
          phase: "primary_restored",
          source: "previous",
          candidate_state_hash: candidateHash,
          ...(markerCommit?.source_manifest === undefined ? (commitManifest === null ? {} : { source_manifest: commitManifest }) : { source_manifest: markerCommit.source_manifest }),
          updated_at: this.deps.clock.now().toISOString()
        }
      });

      const cleanupEvidence = await inspectStateEvidence(this.deps.fsAdapter, config);
      await this.assertRecoveryCleanupAdmission(
        config,
        paths,
        cleanupEvidence,
        candidateHash,
        unresolvedNextAction
      );
      await clearRecoveryMarker(this.deps.fsAdapter, config);

      state = await this.loadStateWithOptions(config, {
        initializeIfMissing: false,
        persistConfigDrift: false,
        readOnly: true
      });

      const envelope = envelopeBase("recover", config, state, null);
      envelope.overall_status = "ok";
      envelope.data = {
        outcome: "recovered_previous_generation",
        source: previousPath,
        marker_reason: markerReason,
        resumed_cleanup: markerCommit?.phase === "prepared" || markerCommit?.phase === "primary_restored"
      };
      return { envelope, exitCode: ExitCode.Success };
    } catch (error) {
      const setup = toSetupError(error);
      const envelope = envelopeBase("recover", config, state, null);
      envelope.overall_status = setup.exitCode === ExitCode.DriftOrRecoveryRequired ? "blocked" : "failed";
      envelope.manual_actions.push(setup.nextAction);
      envelope.error = {
        code: setup.code,
        stage: setup.stage,
        operation_id: setup.operationId,
        retryable: setup.retryable,
        public_message: setup.message,
        next_action: setup.nextAction,
        evidence_ref: setup.evidenceRef
      };
      return { envelope, exitCode: setup.exitCode };
    } finally {
      await lock.release();
    }
  }

  private async runBackupCreate(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    this.assertOrdinaryOwner(config, "S11");
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let result: Awaited<ReturnType<typeof createBackup>> | null = null;
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      this.assertOrdinaryEffectAdmission(state);
      result = await createBackup(
        {
          fsAdapter: this.deps.fsAdapter,
          processAdapter: this.deps.processAdapter,
          now: () => this.deps.clock.now()
        },
        config
      );
      state = await this.refreshStageObservation(state, config, "S11", "backup-create");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("backup create", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      backup_id: result?.backupId ?? "unknown",
      backup_path: result?.backupPath ?? "unknown",
      retained_latest_good: result?.retainedLatestGood ?? false,
      pruned_backups: result?.pruned ?? []
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runBackupVerify(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let verified: Awaited<ReturnType<typeof verifyBackup>> | null = null;
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      verified = await verifyBackup(
        {
          fsAdapter: this.deps.fsAdapter,
          processAdapter: this.deps.processAdapter,
          now: () => this.deps.clock.now()
        },
        config,
        options.backupId
      );
      state = await this.refreshStageObservation(state, config, "S11", "backup-verify");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("backup verify", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      backup_id: verified?.backupId ?? "unknown",
      backup_path: verified?.backupPath ?? "unknown",
      manifest_path: verified?.manifestPath ?? "unknown",
      unknown_usage_observed: verified?.unknownUsageObserved ?? false
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runRestore(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await this.loadStateWithOptions(config, {
      initializeIfMissing: false,
      persistConfigDrift: false,
      readOnly: true
    });
    const envelope = envelopeBase("restore", config, state, null);
    envelope.overall_status = "blocked";
    envelope.manual_actions.push("Restore remains blocked until Q4 payload integrity, confinement and transaction protocol are qualified.");
    return {
      envelope,
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence
    };
  }

  private async runAuthLogin(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    this.assertOrdinaryOwner(config, "S08");
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      this.assertOrdinaryEffectAdmission(state);
      await executeAuthLogin(this.deps.fsAdapter, this.deps.processAdapter, config);
      state = await this.refreshStageObservation(state, config, "S08", "auth-login");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("auth login", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      auth_present: true
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runAuthStatus(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let status: Awaited<ReturnType<typeof readAuthStatus>> = {
      authenticated: false,
      quotaHealthy: "unknown"
    };
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: true });
      status = await readAuthStatus(this.deps.fsAdapter, config);
      state = await this.refreshStageObservation(state, config, "S08", "auth-status");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("auth status", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      authenticated: status.authenticated,
      quota_healthy: status.quotaHealthy
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runSmoke(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    if (options.provider === undefined || options.fixture === undefined) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "smoke_args_missing",
        publicMessage: "smoke requires --provider fake|live and --fixture toy.",
        nextAction: "Run smoke with --provider and --fixture flags."
      });
    }
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    this.assertOrdinaryOwner(config, options.provider === "live" ? "S08" : "S07");
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let result: Awaited<ReturnType<typeof runSmokeCommand>> = {
      provider: options.provider,
      fixture: options.fixture,
      status: "failed",
      sourceSha: "unknown",
      consumedCount: 0
    };
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      this.assertOrdinaryEffectAdmission(state);
      result = await runSmokeCommand(
        this.deps.fsAdapter,
        this.deps.processAdapter,
        config,
        state,
        { provider: options.provider, fixture: options.fixture }
      );
      state = await this.refreshStageObservation(state, config, result.provider === "live" ? "S08" : "S07", "smoke");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("smoke", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      provider: result.provider,
      fixture: result.fixture,
      status: result.status,
      source_sha: result.sourceSha,
      consumed_count: result.consumedCount
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runInferenceDisable(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    this.assertOrdinaryOwner(config, "S12");
    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    let state: SetupState | null = null;
    let result: Awaited<ReturnType<typeof runInferenceDisable>> = {
      scheduledBlocked: true,
      stopped: false,
      alreadyDisabled: false,
      composePath: "unknown"
    };
    try {
      state = await this.loadStateWithOptions(config, { initializeIfMissing: false });
      this.assertOrdinaryEffectAdmission(state);
      result = await runInferenceDisable(this.deps.fsAdapter, this.deps.processAdapter, config);
      state = await this.refreshStageObservation(state, config, "S12", "inference-disable");
      await saveState(this.deps.fsAdapter, config, state);
    } finally {
      await lock.release();
    }
    const envelope = envelopeBase("inference disable", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      scheduled_blocked: result.scheduledBlocked,
      stopped: result.stopped,
      already_disabled: result.alreadyDisabled,
      compose_path: result.composePath
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runInferenceProbe(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await this.loadStateWithOptions(config, {
      initializeIfMissing: false,
      persistConfigDrift: false,
      readOnly: true
    });
    const envelope = envelopeBase("inference probe", config, state, null);
    envelope.overall_status = "blocked";
    envelope.manual_actions.push("S12 probe command requires reviewed implementation and explicit owner gate.");
    return { envelope, exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence };
  }

  private async runUpdatePlan(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await this.loadStateWithOptions(config, {
      initializeIfMissing: false,
      persistConfigDrift: false,
      readOnly: true
    });
    const envelope = envelopeBase("update plan", config, state, null);
    envelope.overall_status = "blocked";
    envelope.manual_actions.push("Dedicated update plan/apply workflow is blocked until Q5 admission and transaction hardening is complete.");
    return { envelope, exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence };
  }

  private async runUpdateApply(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await this.loadStateWithOptions(config, {
      initializeIfMissing: false,
      persistConfigDrift: false,
      readOnly: true
    });
    const envelope = envelopeBase("update apply", config, state, null);
    envelope.overall_status = "blocked";
    envelope.manual_actions.push("Dedicated update plan/apply workflow is blocked until Q5 admission and transaction hardening is complete.");
    return { envelope, exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence };
  }
}
