import { createHash } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import {
  ExitCode,
  type InstallerPlan,
  type SetupConfig,
  type StageId,
  type StageModule,
  type StageOperation,
  type StagePlan
} from "./types";
import { setupError } from "./errors";
import { hashConfig, stableStringify, type Clock } from "./config";
import { validateContractSchema } from "./validators";

export interface StageRegistry {
  byId: ReadonlyMap<StageId, StageModule>;
  ordered: StageModule[];
}

export function createRegistry(modules: StageModule[]): StageRegistry {
  const byId = new Map<StageId, StageModule>();
  for (const module of modules) {
    byId.set(module.id, module);
  }
  return { byId, ordered: modules };
}

export function buildStageClosure(registry: StageRegistry, stageIds: StageId[]): StageId[] {
  const resolved: StageId[] = [];
  const visiting = new Set<StageId>();
  const visited = new Set<StageId>();

  const visit = (stageId: StageId): void => {
    if (visited.has(stageId)) {
      return;
    }
    if (visiting.has(stageId)) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "stage_cycle_detected",
        publicMessage: `Stage dependency cycle detected at ${stageId}.`,
        nextAction: "Fix stage registry dependencies before creating a plan.",
        stage: stageId
      });
    }
    const stage = registry.byId.get(stageId);
    if (stage === undefined) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "unsupported_stage",
        publicMessage: `Stage '${stageId}' is not implemented in this installer release.`,
        nextAction: "Use a release that implements the requested stage.",
        stage: stageId
      });
    }

    visiting.add(stageId);
    for (const dependency of stage.dependencies) {
      visit(dependency);
    }
    visiting.delete(stageId);
    visited.add(stageId);
    resolved.push(stageId);
  };

  for (const stageId of stageIds) {
    visit(stageId);
  }
  return resolved;
}

function mapOperation(operation: StageOperation): InstallerPlan["stages"][number]["operations"][number] {
  return {
    id: operation.id,
    stage_id: operation.stageId,
    kind: operation.kind,
    resource_id: operation.resourceId,
    risk: operation.risk,
    gate_ids: operation.gateIds,
    preconditions: operation.preconditions,
    side_effects: operation.sideEffects,
    timeout_sec: operation.timeoutSec,
    retryable: operation.retryable
  };
}

function planHashFromPlan(plan: Omit<InstallerPlan, "plan_hash">): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

export async function createPlanFile(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  registry: StageRegistry,
  stageTarget: StageId | null,
  clock: Clock,
  completedOperationReceipts: import("./types").StageReceipt[] = []
): Promise<{ plan: InstallerPlan; planPath: string; stageClosure: StageId[]; observations: Map<StageId, import("./types").StageObservation> }> {
  const stageIds = stageTarget === null ? config.selected_stages : [stageTarget];
  const closure = buildStageClosure(registry, stageIds);

  const stagePlans: InstallerPlan["stages"] = [];
  const observations = new Map<StageId, import("./types").StageObservation>();
  for (const stageId of closure) {
    const stage = registry.byId.get(stageId);
    if (stage === undefined) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "unsupported_stage",
        publicMessage: `Stage '${stageId}' is not implemented in this installer release.`,
        nextAction: "Use a release that implements the requested stage.",
        stage: stageId
      });
    }
    const observation = await stage.observe({
      installationId: config.installation_id,
      contractVersion: "1.0.0",
      profile: config.profile,
      desiredHash: hashConfig(config),
      planHash: "pending",
      completedOperationReceipts,
      config
    });
    observations.set(stageId, observation);
    const stagePlan: StagePlan = stage.plan(config, observation);
    stagePlans.push({
      stage_id: stagePlan.stageId,
      optional: stagePlan.optional,
      required_capabilities: stagePlan.requiredCapabilities,
      operations: stagePlan.operations.map(mapOperation),
      required_gates: stagePlan.requiredGates
    });
  }

  const basePlan: Omit<InstallerPlan, "plan_hash"> = {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: config.installation_id,
    desired_hash: hashConfig(config),
    created_at: clock.now().toISOString(),
    stages: stagePlans
  };
  const plan: InstallerPlan = {
    ...basePlan,
    plan_hash: planHashFromPlan(basePlan)
  };

  const planPath = path.join(config.paths.setup_state_dir, "plan.json");
  await fsAdapter.writeText(planPath, `${JSON.stringify(plan, null, 2)}\n`, 0o600);
  await fsAdapter.fsyncFile(planPath);
  await fsAdapter.fsyncDir(path.dirname(planPath));
  return { plan, planPath, stageClosure: closure, observations };
}

export async function loadPlan(fsAdapter: FilesystemAdapter, planPath: string): Promise<InstallerPlan> {
  const raw = await fsAdapter.readText(planPath);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_json_invalid",
    publicMessage:"Submitted plan is not valid JSON.",nextAction:"Generate a valid reviewed plan."}); }
  const validation = validateContractSchema("plan", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "plan_schema_error",
      publicMessage: `Plan schema validation failed: ${validation.errors.join("; ")}`,
      nextAction: "Regenerate the plan with 'factory-setup plan'."
    });
  }
  return parsed as InstallerPlan;
}

export function validatePlanConsistency(config: SetupConfig, plan: InstallerPlan): void {
  if (plan.installation_id !== config.installation_id) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "plan_installation_mismatch",
      publicMessage: "Plan installation_id does not match current configuration.",
      nextAction: "Regenerate the plan from this installation."
    });
  }
  if (plan.contract_version !== "1.0.0") {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "plan_contract_version_unsupported",
      publicMessage: `Plan contract version '${plan.contract_version}' is unsupported.`,
      nextAction: "Regenerate plan with installer contract 1.0.0."
    });
  }

  const desiredHash = hashConfig(config);
  if (plan.desired_hash !== desiredHash) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "stale_plan",
      publicMessage: "Plan desired hash does not match current config hash.",
      nextAction: "Run 'factory-setup plan --config PATH' and re-approve gates."
    });
  }

  const basePlan: Omit<InstallerPlan, "plan_hash"> = {
    schema_version: plan.schema_version,
    contract_version: plan.contract_version,
    installation_id: plan.installation_id,
    desired_hash: plan.desired_hash,
    created_at: plan.created_at,
    stages: plan.stages
  };
  const expected = planHashFromPlan(basePlan);
  if (expected !== plan.plan_hash) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "plan_hash_invalid",
      publicMessage: "Plan hash does not match plan content.",
      nextAction: "Regenerate the plan and avoid manual plan edits."
    });
  }
}

/** Current format uses planner-produced UTC milliseconds; C13 serialization is R2.2. */
export function assertPlanTime(plan: InstallerPlan, clock: Clock): void {
  const value = plan.created_at;
  const created = Date.parse(value), now = clock.now().getTime();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(created)
    || new Date(created).toISOString() !== value) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_time_invalid",
      publicMessage:"Plan created_at must be a real canonical ISO UTC millisecond timestamp.",nextAction:"Generate and review a new plan."});
  if (!Number.isFinite(now) || created > now) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_from_future",
    publicMessage:"Plan creation is later than the injected current time.",nextAction:"Reconcile the clock and generate/review a new plan."});
  if (now >= created + 30 * 60_000) throw setupError({exitCode:ExitCode.ManualActionRequired,code:"plan_expired",
    publicMessage:"Plan is at least 30 minutes old and cannot authorize another action.",nextAction:"Generate/review a new plan and approve its required gates."});
}

export function serializeStagePlan(plan: StagePlan): InstallerPlan["stages"][number] {
  return {stage_id:plan.stageId,optional:plan.optional,required_capabilities:plan.requiredCapabilities,
    required_gates:plan.requiredGates,operations:plan.operations.map(mapOperation)};
}
