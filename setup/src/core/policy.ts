import { parseStrictJson } from "./strict-json";
import { createHash } from "node:crypto";
import { stableStringify } from "./config";
import { setupError } from "./errors";
import { ADAPTER_ACTIONS, OPERATION_KINDS, OPERATION_RISK_LEVELS, ExitCode, type ExecutionPlan, type SetupConfig, type SetupState, type StageModule, type StageObservation, type StageContext, type StageOperation, type StagePlan } from "./types";
import { serializeStagePlan } from "./plan";

/** Core-owned, schema-validated internal metadata in existing versions storage, not a sidecar. */
export const POLICY_BASIS_KEY = "setup_policy_basis_v1";
export interface PolicyBasis {
  version: 1 | 2 | 3;
  planHash: string;
  configHash: string;
  source: StageObservation;
  expected: string;
  completed: string[];
  progress?: PublishedOperation[];
  /** Core-produced full semantic catalog; source of historical policy after public-plan replacement. */
  catalog?: StagePlan;
  frontier?: StageObservation;
}
/** Semantic operation and exact journal publication retained across reviewed ID changes. */
export interface PublishedOperation {
  currentId: string;
  operation: StageOperation;
  attemptId: string;
  receiptHash: string;
}

function validateProgressRecord(value: unknown, stage: StageModule): PublishedOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("progress shape");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "attemptId,currentId,operation,receiptHash"
    || typeof entry.currentId !== "string" || entry.currentId.length === 0
    || typeof entry.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.attemptId)
    || typeof entry.receiptHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.receiptHash)) throw Error("publication binding");
  validatePolicyOperation(entry.operation, stage);
  return value as PublishedOperation;
}

function validatePolicyOperation(value: unknown, stage: StageModule): StageOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("operation shape");
  const op = value as Record<string, unknown>;
  const operationFields = "gateIds,id,kind,preconditions,resourceId,retryable,risk,sideEffects,stageId,timeoutSec";
  if (Object.keys(op).sort().join(",") !== (op.action === undefined ? operationFields : "action," + operationFields)
    || (op.action !== undefined && !ADAPTER_ACTIONS.some(action => action === op.action))
    || typeof op.id !== "string" || op.id.length === 0 || op.stageId !== stage.id
    || typeof op.resourceId !== "string" || op.resourceId.length === 0
    || !OPERATION_KINDS.some(kind => kind === op.kind) || !OPERATION_RISK_LEVELS.some(risk => risk === op.risk)
    || typeof op.retryable !== "boolean" || typeof op.timeoutSec !== "number" || !Number.isInteger(op.timeoutSec) || op.timeoutSec <= 0) throw Error("operation identity");
  for (const key of ["gateIds", "preconditions", "sideEffects"]) {
    const values = op[key];
    if (!Array.isArray(values) || values.some(item => typeof item !== "string")) throw Error("operation policy");
  }
  return value as StageOperation;
}

function validatePolicyObservation(value: unknown, stage: StageModule): void {
    if (value===null || typeof value!=="object" || Array.isArray(value)) throw Error("source");
    const obs=value as Record<string,unknown>;
    if(Object.keys(obs).sort().join(",")!=="checks,observedAt,stageId,status,versions" || obs.stageId!==stage.id || typeof obs.observedAt!=="string"
      || typeof obs.status!=="string" || !["pending","planned","applying","installed","verified","awaiting_manual","blocked","failed","skipped","interrupted","drifted"].includes(String(obs.status))) throw Error("observation");
    for(const key of ["checks","versions"]){const values=obs[key];if(values===null||typeof values!=="object"||Array.isArray(values))throw Error("record");
      for(const value of Object.values(values)){if(key==="versions"?typeof value!=="string":!(typeof value==="string"||typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value))))throw Error("value");}}
}

function refuse(message: string): never {throw setupError({exitCode:ExitCode.CliOrSchemaError,code:"plan_policy_mismatch",publicMessage:message,nextAction:"Generate a new plan with the trusted producer, review it and approve its required gates."});}
export function policyFingerprint(stage: StageModule, config: SetupConfig, observed: StageObservation): string {
  const view = stage.policyInputs ? {status:observed.status,inputs:stage.policyInputs(observed)}
    : {status:observed.status,policy:serializeStagePlan(stage.plan(config, observed))};
  return createHash("sha256").update(stableStringify(view)).digest("hex");
}
/** Review identity projects producer-defined security facts, not an incidental status label. */
export function projectedObservationHash(stage: StageModule, config: SetupConfig, observed: StageObservation): string {
  const projection = stage.policyInputs ? stage.policyInputs(observed) : serializeStagePlan(stage.plan(config, observed));
  return createHash("sha256").update(stableStringify(projection)).digest("hex");
}
export function readPolicyBasis(state: SetupState, stage: StageModule): PolicyBasis | null {
  const raw = state.stages.find(s => s.id === stage.id)?.versions[POLICY_BASIS_KEY];
  if (raw === undefined) return null;
  try {
    if (Buffer.byteLength(raw)>64*1024) throw Error("oversized");
    const p: unknown = parseStrictJson(raw);
    if (p===null || typeof p!=="object" || Array.isArray(p)) throw Error("shape");
    const v=p as Record<string,unknown>;
    const fields = v.version === 3 ? "catalog,completed,configHash,expected,frontier,planHash,progress,source,version" : v.version === 2 ? "completed,configHash,expected,planHash,progress,source,version" : "completed,configHash,expected,planHash,source,version";
    if (Object.keys(v).sort().join(",")!==fields || (v.version!==1 && v.version!==2 && v.version!==3)
      || [v.planHash,v.configHash,v.expected].some(h=>typeof h!=="string" || !/^[0-9a-f]{64}$/.test(h))) throw Error("binding");
    if (!Array.isArray(v.completed) || v.completed.some(id=>typeof id!=="string") || new Set(v.completed).size!==v.completed.length) throw Error("progress");
    validatePolicyObservation(v.source, stage);
    if (v.version === 3) validatePolicyObservation(v.frontier, stage);
    if (v.version === 2 || v.version === 3) {
      if (!Array.isArray(v.progress) || v.progress.length !== v.completed.length) throw Error("progress length");
      const completed = v.completed as string[];
      const entries = v.progress.map(entry => validateProgressRecord(entry, stage));
      if (entries.some((entry, index) => entry.currentId !== completed[index])
        || new Set(entries.map(entry => entry.attemptId)).size !== entries.length) throw Error("progress order");
    }
    if (v.version === 3) {
      if (!v.catalog || typeof v.catalog !== "object" || Array.isArray(v.catalog)) throw Error("catalog shape");
      const catalog = v.catalog as Record<string, unknown>;
      if (Object.keys(catalog).sort().join(",") !== "operations,optional,requiredCapabilities,requiredGates,stageId"
        || catalog.stageId !== stage.id || catalog.optional !== stage.optional || !Array.isArray(catalog.operations)) throw Error("catalog identity");
      for (const key of ["requiredCapabilities", "requiredGates"]) {
        const values = catalog[key];
        if (!Array.isArray(values) || values.some(value => typeof value !== "string") || new Set(values).size !== values.length) throw Error("catalog constraints");
      }
      const ids = new Set<string>();
      for (const operation of catalog.operations) {
        const checked = validatePolicyOperation(operation, stage);
        if (!checked.action || ids.has(checked.id)) throw Error("catalog operation");
        ids.add(checked.id);
      }
    }
    return p as PolicyBasis;
  } catch {throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"plan_policy_basis_invalid",publicMessage:"Committed policy basis is malformed or unsupported.",nextAction:"Preserve evidence and generate a reviewed plan after reconciliation.",stage:stage.id});}
}
export function withPolicyBasis(state: SetupState, stage: StageModule, basis: PolicyBasis): SetupState {
  const raw=JSON.stringify(basis);if(Buffer.byteLength(raw)>64*1024)refuse("Policy observation exceeds bounded internal metadata.");
  return {...state,stages:state.stages.map(s=>s.id===stage.id?{...s,versions:{...s.versions,[POLICY_BASIS_KEY]:raw}}:s)};
}
export function assertProducerPolicy(stage: StageModule, config: SetupConfig, submitted: ExecutionPlan["stages"][number], source: StageObservation): void {
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
  const proofCtx = {...ctx,completedOperationReceipts:policyReceipts(ctx, basis)};
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
  const proofCtx={...ctx,completedOperationReceipts:policyReceipts(ctx, basis)};
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


export function policyReceipts(ctx: StageContext, basis: PolicyBasis) {
  const publishedIds = new Set(basis.progress?.map(entry => entry.operation.id) ?? basis.completed);
  return (ctx.completedOperationReceipts ?? []).filter(receipt => publishedIds.has(receipt.operationId));
}
