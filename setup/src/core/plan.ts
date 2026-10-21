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
  clock: Clock
): Promise<{ plan: InstallerPlan; planPath: string; stageClosure: StageId[] }> {
  const stageIds = stageTarget === null ? config.selected_stages : [stageTarget];
  const closure = buildStageClosure(registry, stageIds);

  const stagePlans: InstallerPlan["stages"] = [];
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
      planHash: "pending"
    });
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
  return { plan, planPath, stageClosure: closure };
}

export async function loadPlan(fsAdapter: FilesystemAdapter, planPath: string): Promise<InstallerPlan> {
  const raw = await fsAdapter.readText(planPath);
  const parsed = JSON.parse(raw);
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
