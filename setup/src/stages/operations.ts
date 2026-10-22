import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";
import { collectHealth } from "../operations/health";
import { createBackup, verifyBackup } from "../operations/backup";

function checksFromHealth(health: Awaited<ReturnType<typeof collectHealth>>): Record<string, string | number | boolean> {
  return {
    s11_service_healthy: health.serviceHealthy,
    s11_docker_healthy: health.dockerHealthy,
    s11_disk_free_percent: Number(health.diskFreePercent.toFixed(2)),
    s11_ram_available_percent: Number(health.ramAvailablePercent.toFixed(2)),
    s11_ram_5m_healthy: health.ram5mHealthy,
    s11_external_heartbeat_configured: health.externalHeartbeatConfigured,
    s11_external_heartbeat_reachable: health.externalHeartbeatReachable,
    s11_degraded: health.degradedReasons.length > 0,
    s11_degraded_reasons: health.degradedReasons.join(",")
  };
}

export function createOperationsStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): StageModule {
  let lastConfig: SetupConfig | null = null;
  const deps = {
    fsAdapter,
    processAdapter,
    now: () => new Date()
  };

  return {
    id: "S11",
    dependencies: ["S07"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(_ctx: StageContext): Promise<StageObservation> {
      if (lastConfig === null) {
        return {
          stageId: "S11",
          status: "planned",
          checks: {
            s11_config_loaded: false
          },
          versions: {},
          observedAt: new Date().toISOString()
        };
      }
      const health = await collectHealth(deps, lastConfig);
      let backupVerified = false;
      let backupId = "none";
      try {
        const verified = await verifyBackup(deps, lastConfig);
        backupVerified = true;
        backupId = verified.backupId;
      } catch {
        backupVerified = false;
      }
      return {
        stageId: "S11",
        status: backupVerified && health.degradedReasons.length === 0 ? "verified" : "planned",
        checks: {
          ...checksFromHealth(health),
          s11_latest_backup_verified: backupVerified
        },
        versions: {
          s11_latest_backup_id: backupId
        },
        observedAt: health.observedAt
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      lastConfig = config;
      const operationNeeded = observed.status !== "verified";
      const operations = operationNeeded
        ? [
            {
              id: `s11-backup-health-${config.installation_id.slice(0, 8)}`,
              stageId: "S11" as const,
              kind: "mutate" as const,
              resourceId: "operations-backup-health",
              risk: "medium" as const,
              gateIds: [],
              preconditions: [
                "s07_verified_or_observable",
                "backup_dir_writable",
                "service_db_capability_or_level1_only"
              ],
              sideEffects: [
                "create S11 backup snapshot with integrity verification",
                "update local health history and emergency inventory"
              ],
              timeoutSec: 180,
              retryable: false
            }
          ]
        : [];
      return {
        stageId: "S11",
        optional: false,
        requiredCapabilities: [],
        operations,
        requiredGates: []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s11_config_not_initialized",
          publicMessage: "S11 apply requires plan generation in the same process.",
          nextAction: "Run plan/apply sequence for S11.",
          stage: "S11"
        });
      }
      const backup = await createBackup(deps, lastConfig);
      const verified = await verifyBackup(deps, lastConfig, backup.backupId);
      const health = await collectHealth(deps, lastConfig);
      const inventoryPath = `${lastConfig.paths.setup_state_dir}/s11-emergency-inventory.json`;
      await fsAdapter.writeText(
        inventoryPath,
        `${JSON.stringify({
          schema_version: 1,
          installation_id: lastConfig.installation_id,
          owned_container_labels: [
            `agent-factory.installation_id=${lastConfig.installation_id}`,
            `agent-factory.operation_id=${approvedPlan.operations[0]?.id ?? "s11"}`
          ],
          service_unit: lastConfig.profile === "service" ? "agent-factory.service" : null
        }, null, 2)}\n`,
        0o600
      );
      const operationId = approvedPlan.operations[0]?.id ?? `s11-apply-${ctx.installationId}`;
      return [
        {
          operationId,
          stageId: "S11",
          resourceId: "operations-backup-health",
          observedAt: health.observedAt,
          checks: {
            s11_backup_verified: true,
            s11_backup_id: verified.backupId,
            ...checksFromHealth(health)
          },
          versions: {
            s11_latest_backup_id: verified.backupId
          },
          artifacts: [
            backup.backupPath,
            verified.manifestPath,
            inventoryPath
          ]
        }
      ];
    },
    async verify(_ctx: StageContext): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s11_verify_without_config",
          publicMessage: "S11 verify requires previously loaded config context.",
          nextAction: "Run plan/apply or status --refresh before verify.",
          stage: "S11"
        });
      }
      const verified = await verifyBackup(deps, lastConfig);
      const health = await collectHealth(deps, lastConfig);
      if (health.degradedReasons.length > 0) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s11_health_degraded",
          publicMessage: "S11 health checks are degraded.",
          nextAction: "Follow setup/docs/operations.md runbook and rerun verify.",
          stage: "S11",
          evidenceRef: health.degradedReasons.join(",")
        });
      }
      return [
        {
          operationId: "s11-verify",
          stageId: "S11",
          resourceId: "operations-backup-health",
          observedAt: health.observedAt,
          checks: {
            s11_backup_verified: true,
            s11_backup_id: verified.backupId,
            ...checksFromHealth(health)
          },
          versions: {
            s11_latest_backup_id: verified.backupId
          },
          artifacts: [verified.backupPath, verified.manifestPath]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
