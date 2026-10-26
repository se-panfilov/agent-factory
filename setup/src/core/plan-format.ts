import { actionPostconditions, actionUnknownEffects } from "./action-postconditions";
import { createHash } from "node:crypto";
import { stableStringify } from "./config";
import { setupError } from "./errors";
import { ExitCode, type ExecutionPlan, type InstallerPlan, type StageOperation, type PlanOperation, type PlanStageScope } from "./types";

export const canonicalHash = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
export function nativePlanHash(plan: Omit<InstallerPlan, "plan_hash"> | InstallerPlan): string {
  const { plan_hash: _ignored, ...body } = plan as InstallerPlan;
  return canonicalHash(body);
}
export function wireOperation(operation: StageOperation, before?: { source_observation: string; version_lock: string }): PlanOperation {
  const action = operation.action;
  if (action === undefined) throw setupError({ exitCode: ExitCode.CliOrSchemaError, code: "producer_action_missing",
    publicMessage: "Trusted producer must declare a concrete adapter action.", nextAction: "Use a reviewed producer with a closed operation mapping.", stage: operation.stageId });
  return {
    operation_id: operation.id, stage_id: operation.stageId, kind: action, resources: [operation.resourceId],
    expected_before_hashes: { reviewed_constraints: canonicalHash(operation.preconditions), ...(before ?? {}) },
    expected_after: { verifier: "operation-postconditions", action, checks: actionPostconditions(action) }, requires_gates: operation.gateIds,
    retry_policy: { retryable: operation.retryable, timeout_sec: operation.timeoutSec },
    estimated_effects: operation.sideEffects, unknown_effects: actionUnknownEffects(action), risk: operation.risk,
    constraints: operation.preconditions, execution_kind: operation.kind
  };
}
export function decodePlan(native: InstallerPlan): ExecutionPlan {
  const view: ExecutionPlan = {
    schema_version: 1, contract_version: native.contract_version, installation_id: native.installation_id,
    desired_hash: native.desired_hash, plan_hash: native.plan_hash, created_at: native.generated_at,
    stages: native.stage_scope.map(scope => ({
      stage_id: scope.stage_id, optional: scope.optional, required_capabilities: scope.required_capabilities,
      required_gates: scope.requires_gates,
      operations: native.operations.filter(operation => operation.stage_id === scope.stage_id).map(operation => ({
        id: operation.operation_id, stage_id: operation.stage_id, action: operation.kind, kind: operation.execution_kind,
        resource_id: operation.resources[0]!, risk: operation.risk, gate_ids: operation.requires_gates,
        preconditions: operation.constraints, side_effects: operation.estimated_effects,
        timeout_sec: operation.retry_policy.timeout_sec, retryable: operation.retry_policy.retryable
      }))
    }))
  };
  Object.defineProperty(view, "native", { value: native, enumerable: true, writable: true });
  return view;
}
/** Fixture/editor conversion; production checks the original flat bytes and never rewrites a proposal. */
export function encodePlan(view: ExecutionPlan): InstallerPlan {
  if (!view.native) throw Error("Historical plan requires explicit fresh review, not automatic encoding.");
  const scope: PlanStageScope[] = view.stages.map(stage => ({ stage_id: stage.stage_id, optional: stage.optional,
    required_capabilities: stage.required_capabilities, requires_gates: stage.required_gates }));
  const expires = Date.parse(view.created_at) + 30 * 60_000;
  return { ...view.native, plan_hash: view.plan_hash, generated_at: view.created_at,
    expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : view.native.expires_at,
    stage_scope: scope, operations: view.stages.flatMap(stage => stage.operations.map(operation => wireOperation({
      id: operation.id, stageId: operation.stage_id, ...(operation.action ? { action: operation.action } : {}),
      kind: operation.kind, resourceId: operation.resource_id, risk: operation.risk, gateIds: operation.gate_ids,
      preconditions: operation.preconditions, sideEffects: operation.side_effects, timeoutSec: operation.timeout_sec, retryable: operation.retryable
    }, { source_observation: view.native!.operations.find(item => item.operation_id === operation.id)?.expected_before_hashes.source_observation ?? view.native!.observations_hash, version_lock: view.native!.version_lock_hash }))) };
}
