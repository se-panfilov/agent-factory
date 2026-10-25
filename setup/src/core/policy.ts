import { createHash } from "node:crypto";
import { stableStringify } from "./config";
import { setupError } from "./errors";
import { ExitCode, type InstallerPlan, type SetupConfig, type SetupState, type StageModule, type StageObservation, type StageContext } from "./types";
import { serializeStagePlan } from "./plan";

/** Core-owned, schema-validated internal metadata in existing versions storage, not a sidecar. */
export const POLICY_BASIS_KEY = "setup_policy_basis_v1";
export interface PolicyBasis {
  version: 1;
  planHash: string;
  configHash: string;
  source: StageObservation;
  expected: string;
  completed: string[];
}
function refuse(message: string): never {throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_policy_mismatch",publicMessage:message,nextAction:"Generate a new plan with the trusted producer, review it and approve its required gates."});}
export function policyFingerprint(stage: StageModule, config: SetupConfig, observed: StageObservation): string {
  const view = stage.policyInputs ? {status:observed.status,inputs:stage.policyInputs(observed)}
    : {status:observed.status,policy:serializeStagePlan(stage.plan(config, observed))};
  return createHash("sha256").update(stableStringify(view)).digest("hex");
}
export function readPolicyBasis(state: SetupState, stage: StageModule): PolicyBasis | null {
  const raw = state.stages.find(s => s.id === stage.id)?.versions[POLICY_BASIS_KEY];
  if (raw === undefined) return null;
  try {
    if (Buffer.byteLength(raw)>64*1024) throw Error("oversized");
    const p: unknown = JSON.parse(raw);
    if (p===null || typeof p!=="object" || Array.isArray(p)) throw Error("shape");
    const v=p as Record<string,unknown>;
    if (Object.keys(v).sort().join(",")!=="completed,configHash,expected,planHash,source,version" || v.version!==1
      || [v.planHash,v.configHash,v.expected].some(h=>typeof h!=="string" || !/^[0-9a-f]{64}$/.test(h))) throw Error("binding");
    if (!Array.isArray(v.completed) || v.completed.some(id=>typeof id!=="string") || new Set(v.completed).size!==v.completed.length) throw Error("progress");
    if (v.source===null || typeof v.source!=="object" || Array.isArray(v.source)) throw Error("source");
    const obs=v.source as Record<string,unknown>;
    if(Object.keys(obs).sort().join(",")!=="checks,observedAt,stageId,status,versions" || obs.stageId!==stage.id || typeof obs.observedAt!=="string"
      || typeof obs.status!=="string" || !["pending","planned","applying","installed","verified","awaiting_manual","blocked","failed","skipped","interrupted","drifted"].includes(String(obs.status))) throw Error("observation");
    for(const key of ["checks","versions"]){const values=obs[key];if(values===null||typeof values!=="object"||Array.isArray(values))throw Error("record");
      for(const value of Object.values(values)){if(key==="versions"?typeof value!=="string":!(typeof value==="string"||typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value))))throw Error("value");}}
    return p as PolicyBasis;
  } catch {throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_policy_basis_invalid",publicMessage:"Committed policy basis is malformed or unsupported.",nextAction:"Preserve evidence and generate a reviewed plan after reconciliation.",stage:stage.id});}
}
export function withPolicyBasis(state: SetupState, stage: StageModule, basis: PolicyBasis): SetupState {
  const raw=JSON.stringify(basis);if(Buffer.byteLength(raw)>64*1024)refuse("Policy observation exceeds bounded internal metadata.");
  return {...state,stages:state.stages.map(s=>s.id===stage.id?{...s,versions:{...s.versions,[POLICY_BASIS_KEY]:raw}}:s)};
}
export function assertProducerPolicy(stage: StageModule, config: SetupConfig, submitted: InstallerPlan["stages"][number], source: StageObservation): void {
  const canonical=serializeStagePlan(stage.plan(config,source));
  if (canonical.stage_id!==stage.id || canonical.optional!==stage.optional || stableStringify(canonical)!==stableStringify(submitted)) refuse(`Stage ${stage.id} plan differs from its trusted producer policy.`);
  const ids=submitted.operations.map(o=>o.id);
  if(new Set(ids).size!==ids.length || submitted.operations.some(o=>o.stage_id!==stage.id))refuse(`Stage ${stage.id} has duplicate/foreign operations.`);
}

/** A postcondition may change observed facts, but cannot authorize newly required actions/gates. */
export function assertContinuingPolicy(stage: StageModule, config: SetupConfig, ctx: StageContext, basis: PolicyBasis, observed: StageObservation): void {
  const original = stage.plan(config,basis.source);
  const remaining = original.operations.filter(op=>!basis.completed.includes(op.id));
  if (remaining.length===0) return;
  // A resource-level verified observation cannot erase still-unperformed reviewed orchestration.
  // Re-open only this producer catalog after proven progress, never blocked/manual readiness.
  const planning = basis.completed.length>0 && observed.status==="verified" ? {...observed,status:basis.source.status} : observed;
  const fresh = stage.plan(config,planning);
  const proofCtx = {...ctx,completedOperationReceipts:(ctx.completedOperationReceipts ?? []).filter(r=>basis.completed.includes(r.operationId))};
  const operations = fresh.operations.map(op=>basis.completed.length>0 && stage.reconcilePolicyOperation
    ? {...op,...stage.reconcilePolicyOperation(proofCtx,original,op)} : op).filter(op=>!basis.completed.includes(op.id));
  if (fresh.stageId!==original.stageId || fresh.optional!==original.optional
    || stableStringify(fresh.requiredCapabilities)!==stableStringify(original.requiredCapabilities)
    || fresh.requiredGates.some(g=>!original.requiredGates.includes(g))
    || stableStringify(operations)!==stableStringify(remaining)) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_policy_drift",
      publicMessage:"Current producer requires different remaining actions or security requirements.",nextAction:"Create/review a new plan; prior checkpoints remain known and are not replayed.",stage:stage.id});
}

/** Stage-wide verify is not permission to publish success with newly discovered requirements. */
export function assertCompletionPolicy(stage: StageModule, config: SetupConfig, ctx: StageContext, basis: PolicyBasis, observed: StageObservation): void {
  const original=stage.plan(config,basis.source),fresh=stage.plan(config,observed);
  const proofCtx={...ctx,completedOperationReceipts:(ctx.completedOperationReceipts ?? []).filter(r=>basis.completed.includes(r.operationId))};
  const operations=fresh.operations.map(op=>basis.completed.length>0 && stage.reconcilePolicyOperation
    ? {...op,...stage.reconcilePolicyOperation(proofCtx,original,op)} : op);
  const compatible=fresh.stageId===original.stageId && fresh.optional===original.optional
    && stableStringify(fresh.requiredCapabilities)===stableStringify(original.requiredCapabilities)
    && fresh.requiredGates.every(g=>original.requiredGates.includes(g))
    && operations.every(op=>{
      const approved=original.operations.find(p=>p.id===op.id);
      return approved!==undefined && stableStringify(approved)===stableStringify(op)
        && (basis.completed.includes(op.id) || op.kind==="verify");
    });
  if (!compatible) throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_completion_policy_drift",
    publicMessage:"Verified resources reveal additional unreviewed stage requirements.",nextAction:"Review a new plan before publishing stage completion; completed operation evidence remains known.",stage:stage.id});
}
