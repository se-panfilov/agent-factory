import path from "node:path";
import os from "node:os";
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
import { hashConfig, initConfig, loadConfig, systemClock, type Clock } from "./config";
import { ExitCode, type InstallerPlan, type JsonEnvelope, type SetupConfig, type SetupState, type StageId, type StageModule } from "./types";
import { setupError, toSetupError } from "./errors";
import { approveGate, ensureGateApproved, ensureNonInteractiveGates, upsertPlanGates } from "./gates";
import { acquireLock, consumeCancelRequest, recoverLockOnly, requestCancel } from "./lock";
import { buildStageClosure, createPlanFile, createRegistry, loadPlan, validatePlanConsistency, type StageRegistry } from "./plan";
import { appendEvent, loadState, saveState, updateObservedStage, withInFlightOperation, withLastError } from "./state";

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
  provider?: "live" | "fake";
  fixture?: "toy";
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
    createServiceStage(fsAdapter, systemdAdapter)
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
        case "auth-login":
          return await this.runAuthLogin(options);
        case "auth-status":
          return await this.runAuthStatus(options);
        case "smoke":
          return await this.runSmoke(options);
        default:
          throw setupError({
            exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
            code: "unsupported_command",
            publicMessage: `Command '${command}' is not implemented in P02 scope.`,
            nextAction: "Use commands from init/preflight/plan/apply/status/resume/verify/gate/auth/smoke/cancel/recover."
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
      planHash
    });
    return updateObservedStage(state, observation, observation.status);
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
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const envelope = envelopeBase("init", config, state, null);
    envelope.overall_status = "ok";
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runPreflight(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const stage = this.registry.byId.get("S01");
    if (stage === undefined) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "unsupported_stage",
        publicMessage: "S01 preflight stage is not registered.",
        nextAction: "Use an installer release that provides S01."
      });
    }
    const observation = await stage.observe({
      installationId: config.installation_id,
      contractVersion: "1.0.0",
      profile: config.profile,
      desiredHash: hashConfig(config),
      planHash: "none"
    });
    const nextState = updateObservedStage(state, observation, observation.status);
    await saveState(this.deps.fsAdapter, config, nextState);

    const envelope = envelopeBase("preflight", config, nextState, null);
    envelope.overall_status = observation.status === "blocked" ? "blocked" : "ok";
    envelope.data = {
      checks: observation.checks,
      versions: observation.versions
    };
    return {
      envelope,
      exitCode: observation.status === "blocked" ? ExitCode.UnsupportedHostOrMissingPrivileges : ExitCode.Success
    };
  }

  private async runPlan(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const stageId = options.stageId ?? null;
    const result = await createPlanFile(this.deps.fsAdapter, config, this.registry, stageId, this.deps.clock);
    const envelope = envelopeBase("plan", config, state, result.plan.plan_hash);
    envelope.overall_status = "ok";
    envelope.data = {
      plan_path: result.planPath,
      stage_closure: result.stageClosure
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
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const plan = await loadPlan(this.deps.fsAdapter, options.planPath);
    validatePlanConsistency(config, plan);
    ensureNonInteractiveGates(state, plan.plan_hash, options.nonInteractive ?? false);

    const lock = await acquireLock(this.deps.fsAdapter, this.deps.processAdapter, config);
    try {
      for (const stagePlan of plan.stages) {
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
        const observation = await stage.observe({
          installationId: config.installation_id,
          contractVersion: "1.0.0",
          profile: config.profile,
          desiredHash: plan.desired_hash,
          planHash: plan.plan_hash
        });
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

        state = updateObservedStage(state, observation, "applying");
        state = upsertPlanGates(
          state,
          plan.plan_hash,
          stagePlan.operations[0]?.id ?? `${stagePlan.stage_id}-gate`,
          stagePlan.required_gates,
          this.deps.clock
        );
        for (const gateId of stagePlan.required_gates) {
          ensureGateApproved(state, plan.plan_hash, gateId);
        }
        await saveState(this.deps.fsAdapter, config, state);

        for (const operation of stagePlan.operations) {
          state = withInFlightOperation(state, {
            id: operation.id,
            stage_id: stagePlan.stage_id,
            kind: operation.kind,
            started_at: this.deps.clock.now().toISOString()
          });
          await saveState(this.deps.fsAdapter, config, state);
          await appendEvent(this.deps.fsAdapter, config, {
            operation_id: operation.id,
            stage: stagePlan.stage_id,
            code: "intent",
            message: `intent:${operation.kind}`
          });
        }
        const receipts = await stage.apply(
          {
            installationId: config.installation_id,
            contractVersion: "1.0.0",
            profile: config.profile,
            desiredHash: plan.desired_hash,
            planHash: plan.plan_hash
          },
          {
            stageId: stagePlan.stage_id,
            optional: stagePlan.optional,
            requiredCapabilities: stagePlan.required_capabilities,
            operations: stagePlan.operations.map((op) => ({
              id: op.id,
              stageId: op.stage_id,
              kind: op.kind,
              resourceId: op.resource_id,
              risk: op.risk,
              gateIds: op.gate_ids,
              preconditions: op.preconditions,
              sideEffects: op.side_effects,
              timeoutSec: op.timeout_sec,
              retryable: op.retryable
            })),
            requiredGates: stagePlan.required_gates
          }
        );
        for (const receipt of receipts) {
          await appendEvent(this.deps.fsAdapter, config, {
            operation_id: receipt.operationId,
            stage: receipt.stageId,
            code: "receipt",
            message: `receipt:${receipt.resourceId}`
          });
        }
        await stage.verify({
          installationId: config.installation_id,
          contractVersion: "1.0.0",
          profile: config.profile,
          desiredHash: plan.desired_hash,
          planHash: plan.plan_hash
        });
        state = withInFlightOperation(state, null);
        state = updateObservedStage(state, observation, "verified");
        await saveState(this.deps.fsAdapter, config, state);
      }

      const cancelRequested = await consumeCancelRequest(this.deps.fsAdapter, config);
      if (cancelRequested) {
        throw setupError({
          exitCode: ExitCode.SigIntCleanupConfirmed,
          code: "cancel_requested",
          publicMessage: "Cancellation request consumed after apply.",
          nextAction: "Inspect state and run resume if needed."
        });
      }

      const envelope = envelopeBase("apply", config, state, plan.plan_hash);
      envelope.overall_status = "ok";
      return { envelope, exitCode: ExitCode.Success };
    } catch (error) {
      const setup = toSetupError(error);
      state = withLastError(state, {
        code: setup.code,
        stage: (setup.stage ?? "S01") as StageId,
        operation_id: setup.operationId,
        retryable: setup.retryable,
        public_message: setup.message,
        next_action: setup.nextAction,
        evidence_ref: setup.evidenceRef
      });
      state = withInFlightOperation(state, null);
      await saveState(this.deps.fsAdapter, config, state);
      throw setup;
    } finally {
      await lock.release();
    }
  }

  private async runStatus(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    if (options.refresh === true) {
      const preflight = this.registry.byId.get("S01");
      if (preflight !== undefined) {
        const observation = await preflight.observe({
          installationId: config.installation_id,
          contractVersion: "1.0.0",
          profile: config.profile,
          desiredHash: hashConfig(config),
          planHash: "none"
        });
        const stage = state.stages.find((item) => item.id === "S01");
        if (stage?.status === "verified" && observation.status !== "verified") {
          state = updateObservedStage(state, observation, "drifted");
        } else {
          state = updateObservedStage(state, observation, observation.status);
        }
        await saveState(this.deps.fsAdapter, config, state);
      }
    }
    const envelope = envelopeBase("status", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      refreshed: options.refresh === true
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runResume(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const planOptions: CommandOptions = { configPath: options.configPath };
    if (options.stageId !== undefined) {
      planOptions.stageId = options.stageId;
    }
    const planResult = await this.runPlan(planOptions);
    const planPath = path.join(
      (await loadConfig(this.deps.fsAdapter, options.configPath)).paths.setup_state_dir,
      "plan.json"
    );
    const applyOptions: CommandOptions = {
      configPath: options.configPath,
      planPath
    };
    if (options.nonInteractive !== undefined) {
      applyOptions.nonInteractive = options.nonInteractive;
    }
    return this.runApply(applyOptions).then((applyResult) => ({
      envelope: {
        ...applyResult.envelope,
        command: "resume",
        plan_hash: planResult.envelope.plan_hash
      },
      exitCode: applyResult.exitCode
    }));
  }

  private async runVerify(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const stageTarget = options.stageId ?? "S01";
    const closure = buildStageClosure(this.registry, [stageTarget]);
    for (const stageId of closure) {
      const stage = this.registry.byId.get(stageId);
      if (stage === undefined) {
        continue;
      }
      const receipts = await stage.verify({
        installationId: config.installation_id,
        contractVersion: "1.0.0",
        profile: config.profile,
        desiredHash: hashConfig(config),
        planHash: "verify"
      });
      if (receipts.length > 0) {
        const observation = await stage.observe({
          installationId: config.installation_id,
          contractVersion: "1.0.0",
          profile: config.profile,
          desiredHash: hashConfig(config),
          planHash: "verify"
        });
        state = updateObservedStage(state, observation, "verified");
      }
    }
    await saveState(this.deps.fsAdapter, config, state);
    const envelope = envelopeBase("verify", config, state, null);
    envelope.overall_status = "ok";
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runGateList(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
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
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    state = approveGate(state, options.gateId, options.planHash, this.deps.clock);
    await saveState(this.deps.fsAdapter, config, state);
    const envelope = envelopeBase("gate approve", config, state, options.planHash);
    envelope.overall_status = "ok";
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runCancel(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const cancelPath = await requestCancel(this.deps.fsAdapter, config);
    const envelope = envelopeBase("cancel", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = { cancel_request: cancelPath };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runRecover(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    const state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    if (options.lockOnly === true) {
      const recovered = await recoverLockOnly(this.deps.fsAdapter, this.deps.processAdapter, config);
      const envelope = envelopeBase("recover", config, state, null);
      envelope.overall_status = "ok";
      envelope.data = recovered as unknown as Record<string, unknown>;
      return { envelope, exitCode: ExitCode.Success };
    }
    const envelope = envelopeBase("recover", config, state, null);
    envelope.overall_status = "ok";
    envelope.manual_actions.push("No full recovery operation is implemented in P02; lock-only recovery is available.");
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runAuthLogin(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    await executeAuthLogin(this.deps.fsAdapter, this.deps.processAdapter, config);
    state = await this.refreshStageObservation(state, config, "S08", "auth-login");
    await saveState(this.deps.fsAdapter, config, state);
    const envelope = envelopeBase("auth login", config, state, null);
    envelope.overall_status = "ok";
    envelope.data = {
      auth_present: true
    };
    return { envelope, exitCode: ExitCode.Success };
  }

  private async runAuthStatus(options: CommandOptions): Promise<{ envelope: JsonEnvelope; exitCode: number }> {
    const config = await loadConfig(this.deps.fsAdapter, options.configPath);
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const status = await readAuthStatus(this.deps.fsAdapter, config);
    state = await this.refreshStageObservation(state, config, "S08", "auth-status");
    await saveState(this.deps.fsAdapter, config, state);
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
    let state = await loadState(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      this.deps.clock,
      config,
      this.deps.installerVersion
    );
    const result = await runSmokeCommand(
      this.deps.fsAdapter,
      this.deps.processAdapter,
      config,
      state,
      { provider: options.provider, fixture: options.fixture }
    );
    state = await this.refreshStageObservation(state, config, result.provider === "live" ? "S08" : "S07", "smoke");
    await saveState(this.deps.fsAdapter, config, state);
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
}
