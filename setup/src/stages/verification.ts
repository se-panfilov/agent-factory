import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";
import { runSmokeCommand } from "./auth";

const OBSERVE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const OFFLINE_REPORT_FILENAME = "s07-offline-verification.json";
const NO_SECRET_CHECK_CONTAINER = "agent-factory-s07-check";
const S06_IMAGE_STATE_FILENAME = "s06-agent-image.json";

interface OfflineReportRecord {
  schema_version: 1;
  provider: "fake";
  fixture: "toy";
  status: "runner_ready_offline";
  source_sha: string;
  observed_at: string;
  run_id: string;
  no_secret_boundary_verified: boolean;
}

function offlineReportPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, OFFLINE_REPORT_FILENAME);
}

function imageStatePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, S06_IMAGE_STATE_FILENAME);
}

async function writeAtomic(
  fsAdapter: FilesystemAdapter,
  targetPath: string,
  content: string,
  mode: number
): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

async function toySourceSha(processAdapter: ProcessAdapter, config: SetupConfig): Promise<string> {
  const result = await processAdapter.runCommand({
    binary: "/usr/bin/git",
    args: ["-C", path.join(config.paths.application_work_dir, "factory-toy-fixture"), "rev-parse", "HEAD"],
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || !/^[0-9a-f]{40}$/.test(value)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s07_toy_fixture_missing",
      publicMessage: "S07 requires deterministic toy fixture git identity from S06.",
      nextAction: "Run S06 successfully before S07 offline verification.",
      stage: "S07"
    });
  }
  return value;
}

async function readPinnedImageRef(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<string> {
  const statePath = imageStatePath(config);
  if (!(await fsAdapter.exists(statePath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s07_image_state_missing",
      publicMessage: "S06 pinned image evidence is missing; S07 is blocked.",
      nextAction: "Complete S06 and rerun S07.",
      stage: "S07",
      evidenceRef: statePath
    });
  }
  const parsed = JSON.parse(await fsAdapter.readText(statePath)) as {
    image_id?: unknown;
    image_digest?: unknown;
  };
  const imageId = typeof parsed.image_id === "string" ? parsed.image_id.trim() : "";
  const imageDigest = typeof parsed.image_digest === "string" ? parsed.image_digest.trim() : "";
  if (/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    return imageId;
  }
  if (/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    return imageDigest;
  }
  throw setupError({
    exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "s07_image_state_invalid",
    publicMessage: "S06 image state is invalid; S07 cannot run docker boundary check.",
    nextAction: "Rerun S06 to rebuild image state evidence.",
    stage: "S07"
  });
}

async function validateNoSecretDockerBoundary(
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  imageRef: string
): Promise<void> {
  const create = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: [
      "create",
      "--name",
      NO_SECRET_CHECK_CONTAINER,
      "--read-only",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${path.join(config.paths.application_work_dir, "factory-toy-fixture")},dst=/workspace/toy,readonly`,
      "--mount",
      "type=tmpfs,dst=/tmp",
      imageRef,
      "--version"
    ],
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  if (create.exitCode !== 0 || create.timedOut) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "s07_docker_boundary_create_failed",
      publicMessage: "S07 docker no-secret fixture container creation failed.",
      nextAction: "Inspect docker daemon accessibility and rerun S07.",
      stage: "S07"
    });
  }
  try {
    const inspect = await processAdapter.runCommand({
      binary: "/usr/bin/docker",
      args: ["inspect", "--format", "{{json .Mounts}}", NO_SECRET_CHECK_CONTAINER],
      timeoutMs: OBSERVE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
    if (inspect.exitCode !== 0 || inspect.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s07_docker_boundary_inspect_failed",
        publicMessage: "S07 docker fixture inspection failed.",
        nextAction: "Inspect docker daemon and rerun S07 offline verification.",
        stage: "S07"
      });
    }
    if (inspect.stdout.includes(config.paths.application_auth_dir) || inspect.stdout.includes(config.paths.application_state_dir)) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s07_secret_mount_detected",
        publicMessage: "Docker fixture mount contains auth/state paths; no-secret boundary violated.",
        nextAction: "Fix docker run mount policy and rerun S07.",
        stage: "S07"
      });
    }
  } finally {
    const cleanup = await processAdapter.runCommand({
      binary: "/usr/bin/docker",
      args: ["rm", "-f", NO_SECRET_CHECK_CONTAINER],
      timeoutMs: OBSERVE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
    if (cleanup.exitCode !== 0 || cleanup.timedOut) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s07_cleanup_failed",
        publicMessage: "S07 cleanup failed; offline verification is blocked.",
        nextAction: "Remove fixture container manually and rerun S07.",
        stage: "S07"
      });
    }
  }
}

async function readOfflineReport(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<OfflineReportRecord | null> {
  const reportPath = offlineReportPath(config);
  if (!(await fsAdapter.exists(reportPath))) {
    return null;
  }
  const stat = await fsAdapter.lstat(reportPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s07_offline_report_entry_forbidden",
      publicMessage: "Offline verification report entry must be a regular file.",
      nextAction: "Replace report entry with regular file generated by S07.",
      stage: "S07",
      evidenceRef: reportPath
    });
  }
  const parsed = JSON.parse(await fsAdapter.readText(reportPath)) as Record<string, unknown>;
  if (
    parsed.schema_version !== 1
    || parsed.provider !== "fake"
    || parsed.fixture !== "toy"
    || parsed.status !== "runner_ready_offline"
    || typeof parsed.source_sha !== "string"
    || !/^[0-9a-f]{40}$/.test(parsed.source_sha)
    || typeof parsed.observed_at !== "string"
    || typeof parsed.run_id !== "string"
    || typeof parsed.no_secret_boundary_verified !== "boolean"
  ) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s07_offline_report_invalid",
      publicMessage: "Offline verification report is invalid or drifted.",
      nextAction: "Delete corrupted report and rerun S07.",
      stage: "S07",
      evidenceRef: reportPath
    });
  }
  return {
    schema_version: 1,
    provider: "fake",
    fixture: "toy",
    status: "runner_ready_offline",
    source_sha: parsed.source_sha,
    observed_at: parsed.observed_at,
    run_id: parsed.run_id,
    no_secret_boundary_verified: parsed.no_secret_boundary_verified
  };
}

function inferStatus(report: OfflineReportRecord | null, sourceSha: string): StageObservation["status"] {
  if (report === null) {
    return "planned";
  }
  if (!report.no_secret_boundary_verified) {
    return "blocked";
  }
  if (report.source_sha !== sourceSha) {
    return "drifted";
  }
  return "verified";
}

export function createVerificationStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): StageModule {
  return {
    id: "S07",
    dependencies: ["S06"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-readonly"],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const sourceSha = await toySourceSha(processAdapter, ctx.config);
      const report = await readOfflineReport(fsAdapter, ctx.config);
      return {
        stageId: "S07",
        status: inferStatus(report, sourceSha),
        checks: {
          offline_report_present: report !== null,
          offline_status: report?.status ?? "absent",
          no_secret_boundary_verified: report?.no_secret_boundary_verified ?? false
        },
        versions: {
          fixture_source_sha: sourceSha,
          report_source_sha: report?.source_sha ?? "absent"
        },
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      const operations: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s07-offline-verify-${config.installation_id.slice(0, 12)}`,
              stageId: "S07",
              kind: "mutate",
              resourceId: "runner-offline-verification",
              risk: "medium",
              gateIds: [],
              preconditions: [
                "s06_pinned_image_present",
                "runner_verify_fake_provider_supported"
              ],
              sideEffects: [
                "run fake-provider verification without AI credentials",
                "validate docker no-secret mount boundary and cleanup fixture container"
              ],
              timeoutSec: 300,
              retryable: false
            }
          ];
      return {
        stageId: "S07",
        optional: false,
        requiredCapabilities: ["runner-readonly"],
        operations,
        requiredGates: []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const config = ctx.config;
      const imageRef = await readPinnedImageRef(fsAdapter, config);
      const smoke = await runSmokeCommand(
        fsAdapter,
        processAdapter,
        config,
        null,
        { provider: "fake", fixture: "toy" }
      );
      await validateNoSecretDockerBoundary(processAdapter, config, imageRef);
      const sourceSha = await toySourceSha(processAdapter, config);
      const record: OfflineReportRecord = {
        schema_version: 1,
        provider: "fake",
        fixture: "toy",
        status: "runner_ready_offline",
        source_sha: sourceSha,
        observed_at: new Date().toISOString(),
        run_id: `${smoke.provider}-${smoke.consumedCount}`,
        no_secret_boundary_verified: true
      };
      await writeAtomic(fsAdapter, offlineReportPath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
      return [
        {
          operationId: approvedPlan.operations[0]?.id ?? `s07-apply-${ctx.installationId}`,
          stageId: "S07",
          resourceId: "runner-ready-offline",
          observedAt: new Date().toISOString(),
          checks: {
            runner_ready_offline: true,
            no_secret_boundary_verified: true
          },
          versions: {
            fixture_source_sha: sourceSha
          },
          artifacts: [offlineReportPath(config)]
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const report = await readOfflineReport(fsAdapter, ctx.config);
      const sourceSha = await toySourceSha(processAdapter, ctx.config);
      if (report === null || report.status !== "runner_ready_offline" || !report.no_secret_boundary_verified) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s07_not_verified",
          publicMessage: "S07 offline verification evidence is missing or invalid.",
          nextAction: "Run plan/apply for S07 and inspect no-secret boundary checks.",
          stage: "S07"
        });
      }
      if (report.source_sha !== sourceSha) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s07_source_drifted",
          publicMessage: "Toy fixture source SHA drifted after offline verification.",
          nextAction: "Rerun S07 to refresh offline verification evidence.",
          stage: "S07"
        });
      }
      return [
        {
          operationId: "s07-verify",
          stageId: "S07",
          resourceId: "runner-ready-offline",
          observedAt: new Date().toISOString(),
          checks: {
            runner_ready_offline: true,
            no_secret_boundary_verified: report.no_secret_boundary_verified
          },
          versions: {
            fixture_source_sha: sourceSha
          },
          artifacts: [offlineReportPath(ctx.config)]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
