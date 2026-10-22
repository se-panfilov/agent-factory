import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";
import { applyUpdate, observeUpdateState, verifyUpdate, type UpdateDeps } from "../operations/update";

const APPLY_GATE_ID = "s14-update-owner-approved";

function checksFromObservation(observed: Awaited<ReturnType<typeof observeUpdateState>>): Record<string, string | number | boolean> {
  return {
    s14_manifest_present: observed.manifestPresent,
    s14_receipt_present: observed.receiptPresent,
    s14_current_present: observed.currentTarget !== null,
    s14_backup_verified: observed.backupVerified,
    s14_paused_present: observed.pausedPresent,
    s14_drift_detected: observed.driftDetected,
    s14_orphan_switched_release: observed.orphanSwitchedRelease
  };
}

function versionsFromObservation(observed: Awaited<ReturnType<typeof observeUpdateState>>): Record<string, string> {
  return {
    s14_manifest_release_id: observed.manifestReleaseId,
    s14_backup_id: observed.backupId,
    s14_current_target: observed.currentTarget ?? "absent",
    s14_receipt_target: observed.receiptCurrentTarget ?? "absent"
  };
}

function statusFromObservation(observed: Awaited<ReturnType<typeof observeUpdateState>>): StageObservation["status"] {
  if (!observed.manifestPresent) {
    return "planned";
  }
  if (observed.driftDetected) {
    return "drifted";
  }
  if (observed.receiptPresent && observed.currentTarget === observed.receiptCurrentTarget && observed.pausedPresent) {
    return "verified";
  }
  if (!observed.backupVerified) {
    return "blocked";
  }
  return "planned";
}

export function createUpdateStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): StageModule {
  let lastConfig: SetupConfig | null = null;
  const deps: UpdateDeps = {
    fsAdapter,
    processAdapter,
    now: () => new Date()
  };

  return {
    id: "S14",
    dependencies: ["S07"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["app-pause", "app-stop", "app-status", "app-migrate", "app-recover"],
    async observe(): Promise<StageObservation> {
      if (lastConfig === null) {
        return {
          stageId: "S14",
          status: "planned",
          checks: {
            s14_config_loaded: false
          },
          versions: {},
          observedAt: new Date().toISOString()
        };
      }
      const observed = await observeUpdateState(deps, lastConfig);
      return {
        stageId: "S14",
        status: statusFromObservation(observed),
        checks: checksFromObservation(observed),
        versions: versionsFromObservation(observed),
        observedAt: observed.observedAt
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      lastConfig = config;
      const operations = observed.status === "verified"
        ? []
        : [
            {
              id: `s14-update-${config.installation_id.slice(0, 12)}`,
              stageId: "S14" as const,
              kind: "mutate" as const,
              resourceId: "s14-maintenance-update",
              risk: "high" as const,
              gateIds: [APPLY_GATE_ID],
              preconditions: [
                "s14_reviewed_manifest_present",
                "s14_verified_backup_present",
                "s14_owner_release_trust_approved",
                "s14_policy_permissions_diff_approved",
                "s14_pause_drain_commands_ready"
              ],
              sideEffects: [
                "pause+drain application workload",
                "run explicit offline smoke and DB migration",
                "switch current symlink atomically and preserve PAUSED marker"
              ],
              timeoutSec: 900,
              retryable: false
            }
          ];
      return {
        stageId: "S14",
        optional: false,
        requiredCapabilities: ["app-pause", "app-stop", "app-status", "app-migrate", "app-recover"],
        operations,
        requiredGates: operations.length > 0 ? [APPLY_GATE_ID] : []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s14_config_not_initialized",
          publicMessage: "S14 apply requires plan generation in the same process.",
          nextAction: "Run plan/apply sequence for S14.",
          stage: "S14"
        });
      }
      const operationId = approvedPlan.operations[0]?.id ?? `s14-apply-${ctx.installationId}`;
      const result = await applyUpdate(deps, lastConfig, operationId);
      return [
        {
          operationId,
          stageId: "S14",
          resourceId: "s14-maintenance-update",
          observedAt: result.observedAt,
          checks: {
            s14_backup_verified: true,
            s14_migration_applied: result.migrated,
            s14_switched_current: result.switched,
            s14_rollback_attempted: result.rollbackAttempted,
            s14_rollback_succeeded: result.rollbackSucceeded,
            s14_reconciled_without_mutations: result.reconciledWithoutMutations,
            s14_paused_preserved: true
          },
          versions: {
            s14_release_id: result.releaseId,
            s14_commit_sha: result.commitSha,
            s14_backup_id: result.backupId,
            s14_current_target: result.currentTarget,
            s14_previous_target: result.previousCurrentTarget ?? "absent"
          },
          artifacts: result.artifacts
        }
      ];
    },
    async verify(): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s14_verify_without_config",
          publicMessage: "S14 verify requires previously loaded config context.",
          nextAction: "Run plan/apply or status --refresh before verify.",
          stage: "S14"
        });
      }
      const observed = await verifyUpdate(deps, lastConfig);
      return [
        {
          operationId: "s14-verify",
          stageId: "S14",
          resourceId: "s14-maintenance-update",
          observedAt: observed.observedAt,
          checks: checksFromObservation(observed),
          versions: versionsFromObservation(observed),
          artifacts: []
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}

export const UPDATE_GATES = {
  APPLY_GATE_ID
} as const;

