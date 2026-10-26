import { parseStrictJson } from "./strict-json";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import {
  ExitCode,
  type ExecutionPlan,
  type InstallerPlan,
  type SetupConfig,
  type StageId,
  type StageModule,
  type StageOperation,
  type StagePlan
} from "./types";
import { setupError } from "./errors";
import { hashConfig, stableStringify, type Clock } from "./config";
import { decodePlan, nativePlanHash, wireOperation, canonicalHash } from "./plan-format";
import { type StaticPlanContext } from "./plan-context";
import { projectedObservationHash } from "./policy";
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

function mapOperation(operation: StageOperation): ExecutionPlan["stages"][number]["operations"][number] {
  return {
    id: operation.id,
    ...(operation.action ? { action: operation.action } : {}),
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

function planHashFromPlan(plan: Omit<ExecutionPlan, "plan_hash">): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

export async function createPlanFile(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  registry: StageRegistry,
  stageTarget: StageId | null,
  clock: Clock,
  completedOperationReceipts: import("./types").StageReceipt[] = [],
  progressContexts: ReadonlyMap<StageId, import("./types").StageContext> = new Map(),
  context?: StaticPlanContext,
  publish = true
): Promise<{ plan: ExecutionPlan; planPath: string; stageClosure: StageId[]; observations: Map<StageId, import("./types").StageObservation> }> {
  const stageIds = stageTarget === null ? config.selected_stages : [stageTarget];
  const closure = buildStageClosure(registry, stageIds);

  const stagePlans: ExecutionPlan["stages"] = [];
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
      ...progressContexts.get(stageId),
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

  if (!context) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "plan_context_required",
    publicMessage: "Plan production requires checked host/session/artifact context.", nextAction: "Generate the plan through ordinary-owner engine admission." });
  const generated_at = clock.now().toISOString();
  const native: InstallerPlan = {
    schema_version: 1, contract_version: "1.0.0", installation_id: config.installation_id,
    ...context, generated_at, expires_at: new Date(Date.parse(generated_at) + 30 * 60_000).toISOString(),
    desired_hash: hashConfig(config), observations_hash: canonicalHash(closure.map(id => ({ stage: id,
      fingerprint: projectedObservationHash(registry.byId.get(id)!, config, observations.get(id)!) }))),
    target: { mode: stageTarget === null ? "selected" : "explicit", stage_id: stageTarget },
    stage_scope: stagePlans.map(stage => ({ stage_id: stage.stage_id, optional: stage.optional,
      required_capabilities: stage.required_capabilities, requires_gates: stage.required_gates })),
    operations: closure.flatMap(id => registry.byId.get(id)!.plan(config, observations.get(id)!).operations.map(operation => wireOperation(operation, { source_observation: projectedObservationHash(registry.byId.get(id)!, config, observations.get(id)!), version_lock: context.version_lock_hash }))),
    plan_hash: ""
  };
  native.plan_hash = nativePlanHash(native);
  const validation = validateContractSchema("plan", native);
  if (!validation.ok) throw setupError({ exitCode: ExitCode.CliOrSchemaError, code: "producer_plan_schema_error",
    publicMessage: "Trusted producer generated an unsupported C13 document.", nextAction: "Review the producer/schema compatibility; do not execute the document." });
  const plan = decodePlan(native);
  assertPlanTime(plan, clock);
  validatePlanConsistency(config, plan);

  const planPath = path.join(config.paths.setup_state_dir, "plan.json");
  if (publish) await persistPlanFile(fsAdapter, planPath, native);
  return { plan, planPath, stageClosure: closure, observations };
}

/** Proposal publication is atomic; state review remains prepared until the final state commit. */
export async function persistPlanFile(fs: FilesystemAdapter, planPath: string, plan: InstallerPlan): Promise<void> {
  await fs.ensureParentDir(planPath);
  const temporary = `${planPath}.tmp-${randomUUID()}`;
  await fs.writeText(temporary, `${JSON.stringify(plan, null, 2)}\n`, 0o600);
  await fs.fsyncFile(temporary);
  await fs.rename(temporary, planPath);
  await fs.fsyncDir(path.dirname(planPath));
}

export async function loadPlan(fsAdapter: FilesystemAdapter, planPath: string): Promise<ExecutionPlan> {
  const bounded = await fsAdapter.readTextBounded(planPath, 1024 * 1024);
  if (bounded.truncated || bounded.text.includes("\0") || bounded.text.includes("\ufffd")) throw setupError({ exitCode: ExitCode.CliOrSchemaError,
    code: "plan_input_invalid", publicMessage: "Execution plan exceeds bounded valid UTF-8 input.", nextAction: "Generate a fresh reviewed plan." });
  const raw = bounded.text;
  let parsed: unknown;
  try { parsed = parseStrictJson(raw); } catch { throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_json_invalid",
    publicMessage:"Submitted plan is not valid JSON.",nextAction:"Generate a valid reviewed plan."}); }
  if (parsed && typeof parsed === "object" && "created_at" in parsed) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired,
    code: "legacy_plan_review_required", publicMessage: "Historical plan format cannot authorize effects.", nextAction: "Generate and approve an explicit fresh C13 plan; preserve historical progress evidence." });
  const validation = validateContractSchema("plan", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "plan_schema_error",
      publicMessage: `Plan schema validation failed: ${validation.errors.join("; ")}`,
      nextAction: "Regenerate the plan with 'factory-setup plan'."
    });
  }
  return decodePlan(parsed as InstallerPlan);
}

export function validatePlanConsistency(config: SetupConfig, plan: ExecutionPlan): void {
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

  const native = plan.native;
  if (!native) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "legacy_plan_review_required",
    publicMessage: "A strict C13 execution document is required.", nextAction: "Explicitly generate and review a fresh plan." });
  const stageIds = native.stage_scope.map(stage => stage.stage_id);
  const ids = native.operations.map(operation => operation.operation_id);
  const ordered = stageIds.flatMap(id => native.operations.filter(operation => operation.stage_id === id).map(operation => operation.operation_id));
  const normalized = plan.stages.flatMap(stage => stage.operations.map(operation => wireOperation({
    id: operation.id, stageId: operation.stage_id, ...(operation.action ? { action: operation.action } : {}), kind: operation.kind,
    resourceId: operation.resource_id, risk: operation.risk, gateIds: operation.gate_ids, preconditions: operation.preconditions,
    sideEffects: operation.side_effects, timeoutSec: operation.timeout_sec, retryable: operation.retryable
  }, { source_observation: native.operations.find(item => item.operation_id === operation.id)!.expected_before_hashes.source_observation!, version_lock: native.version_lock_hash })));
  if (new Set(stageIds).size !== stageIds.length || new Set(ids).size !== ids.length
    || stableStringify(ordered) !== stableStringify(ids) || stableStringify(normalized) !== stableStringify(native.operations)
    || (native.target.mode === "selected" ? native.target.stage_id !== null : native.target.stage_id === null)) {
    throw setupError({ exitCode: ExitCode.CliOrSchemaError, code: "plan_operation_semantics_invalid",
      publicMessage: "C13 operation identity, order, expected conditions or target is inconsistent.", nextAction: "Generate a new trusted producer plan." });
  }
  if (nativePlanHash(native) !== plan.plan_hash) throw setupError({ exitCode: ExitCode.CliOrSchemaError, code: "plan_hash_invalid",
    publicMessage: "Plan hash does not match the complete canonical C13 document.", nextAction: "Regenerate and review the exact plan bytes." });
}

/** C13 canonical UTC timestamps; the internal created_at alias is never a wire execution field. */
export function assertPlanTime(plan: ExecutionPlan, clock: Clock): void {
  const value = plan.native?.generated_at ?? plan.created_at;
  const created = Date.parse(value), now = clock.now().getTime();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(created)
    || new Date(created).toISOString() !== value) throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_time_invalid",
      publicMessage:"Plan created_at must be a real canonical ISO UTC millisecond timestamp.",nextAction:"Generate and review a new plan."});
  const expiry = plan.native?.expires_at;
  if (expiry !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiry) || !Number.isFinite(Date.parse(expiry))
    || new Date(Date.parse(expiry)).toISOString() !== expiry || Date.parse(expiry) !== created + 30 * 60_000)) {
    throw setupError({ exitCode: ExitCode.CliOrSchemaError, code: "plan_time_invalid", publicMessage: "C13 expiry must be exactly30minutes after canonical generation.", nextAction: "Generate a fresh plan." });
  }
  if (!Number.isFinite(now) || created > now) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_from_future",
    publicMessage:"Plan creation is later than the injected current time.",nextAction:"Reconcile the clock and generate/review a new plan."});
  if (now >= created + 30 * 60_000) throw setupError({exitCode:ExitCode.ManualActionRequired,code:"plan_expired",
    publicMessage:"Plan is at least 30 minutes old and cannot authorize another action.",nextAction:"Generate/review a new plan and approve its required gates."});
}

export function serializeStagePlan(plan: StagePlan): ExecutionPlan["stages"][number] {
  return {stage_id:plan.stageId,optional:plan.optional,required_capabilities:plan.requiredCapabilities,
    required_gates:plan.requiredGates,operations:plan.operations.map(mapOperation)};
}
