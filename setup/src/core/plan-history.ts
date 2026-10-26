import { parseStrictJson } from "./strict-json";
/** Historical policy reader; never passed to effect admission as an execution plan. */
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { validateContractSchema } from "./validators";
import { canonicalHash, decodePlan, nativePlanHash } from "./plan-format";
import { reviewContextHash, REVIEW_KEY } from "./plan-context";
import { hashConfig } from "./config";
import { setupError } from "./errors";
import { ExitCode, type ExecutionPlan, type InstallerPlan, type SetupConfig, type SetupState, type StageId, type StagePlan } from "./types";

export async function readHistoricalStage(fs: FilesystemAdapter, config: SetupConfig, state: SetupState, stage: StageId, basisPlanHash?: string): Promise<StagePlan> {
  try {
    const raw = await fs.readTextBounded(path.join(config.paths.setup_state_dir, "plan.json"), 1024 * 1024);
    if (raw.truncated || raw.text.includes("\0") || raw.text.includes("\ufffd")) throw Error("historical encoding/bound");
    const parsed: unknown = parseStrictJson(raw.text);
    let plan: ExecutionPlan;
    if (validateContractSchema("plan", parsed).ok) {
      const native = parsed as InstallerPlan;
      if (nativePlanHash(native) !== native.plan_hash) throw Error("historical hash");
      plan = decodePlan(native);
      // With no basis, only an exact independently published core review can prove policy.
      if (basisPlanHash === undefined) {
        const r = JSON.parse(state.stages.find(item => item.id === "S00")?.versions[REVIEW_KEY] ?? "null") as Record<string, unknown> | null;
        if (!r || Object.keys(r).sort().join(",") !== "context_hash,phase,plan_hash,version" || r.version !== 1 || r.phase !== "committed" || r.plan_hash !== native.plan_hash || r.context_hash !== reviewContextHash(native)) throw Error("historical review missing");
      }
    } else if (validateContractSchema("legacy-plan", parsed).ok && basisPlanHash !== undefined) {
      plan = parsed as ExecutionPlan;
      const { plan_hash, ...body } = plan;
      if (canonicalHash(body) !== plan_hash) throw Error("legacy historical hash");
    } else throw Error("no historical policy schema");
    if ((basisPlanHash !== undefined && plan.plan_hash !== basisPlanHash) || plan.desired_hash !== hashConfig(config) || plan.installation_id !== config.installation_id) throw Error("historical binding");
    const old = plan.stages.find(item => item.stage_id === stage);
    if (!old) throw Error("historical stage absent");
    return { stageId: old.stage_id, optional: old.optional, requiredCapabilities: old.required_capabilities, requiredGates: old.required_gates,
      operations: old.operations.map(op => ({ id: op.id, stageId: op.stage_id, ...(op.action ? { action: op.action } : {}), kind: op.kind,
        resourceId: op.resource_id, risk: op.risk, gateIds: op.gate_ids, preconditions: op.preconditions, sideEffects: op.side_effects,
        timeoutSec: op.timeout_sec, retryable: op.retryable })) };
  } catch {
    throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "historical_policy_unproven",
      publicMessage: "Known generic-stage progress requires its exact independently bound historical policy.",
      nextAction: "Preserve receipts and the exact historical plan; reconcile unsupported policy migration before a new effect.", stage });
  }
}
