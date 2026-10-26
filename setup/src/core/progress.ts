import path from "node:path";
import { stableStringify, hashConfig } from "./config";
import { setupError } from "./errors";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { inspectJournalEvidence, readStateCommitManifest, receiptHash } from "./state";
import { serializeStagePlan, validatePlanConsistency } from "./plan";
import { validateContractSchema } from "./validators";
import { type PolicyBasis, type PublishedOperation, policyReceipts } from "./policy";
import { ExitCode, type InstallerPlan, type StageContext, type StageModule, type StageOperation, type StagePlan } from "./types";

function blocked(stage: StageModule, message: string): never {
  throw setupError({
    exitCode: ExitCode.DriftOrRecoveryRequired,
    code: "operation_progress_unproven",
    publicMessage: message,
    nextAction: "Preserve evidence and reconcile the published operation sequence before continuing.",
    stage: stage.id
  });
}

function sameOperation(stage: StageModule, ctx: StageContext, reviewed: StagePlan, current: StageOperation, expected: StageOperation): boolean {
  const identity = stage.reconcilePolicyOperation?.(ctx, reviewed, current);
  return stableStringify(identity ? { ...current, ...identity } : current) === stableStringify(expected);
}

/** Only called after ordinary state/generation/journal/manifest admission under the lock. */
export async function restoreOperationProgress(
  fs: FilesystemAdapter, stage: StageModule, ctx: StageContext, basis: PolicyBasis | null
): Promise<PolicyBasis | null> {
  if (!stage.verifyProgress) return basis;
  const manifest = await readStateCommitManifest(fs, ctx.config);
  const retained = (manifest?.completed_operations ?? []).filter(entry => entry.config_hash === hashConfig(ctx.config) && entry.receipt.stageId === stage.id);
  if (basis === null) {
    if (retained.length > 0) blocked(stage, "Legacy access progress has no committed reviewed source policy.");
    return null;
  }
  if (basis.configHash !== hashConfig(ctx.config)) blocked(stage, "Progress belongs to another reviewed configuration.");
  const reviewed = stage.progressPolicyPlan?.(ctx.config, basis.source) ?? stage.plan(ctx.config, basis.source);
  const prefix = reviewed.operations.slice(0, basis.completed.length);
  if (prefix.length !== basis.completed.length || prefix.some((op, index) => op.id !== basis.completed[index])) {
    blocked(stage, "Completed operations are not the exact ordered prefix of the reviewed policy.");
  }
  ctx.operationProgress = { completed: prefix, total: reviewed.operations.length };
  if (prefix.length === 0) {
    if (retained.length > 0) blocked(stage, "Retained access publications have no proven completion prefix.");
    return basis;
  }

  if (basis.version === 1) {
    // v1 has no immutable operation snapshots. Recover them only from the exact
    // plan bound by the already admitted core-owned basis, never a new proposal.
    try {
      const file = await fs.readTextBounded(path.join(ctx.config.paths.setup_state_dir, "plan.json"), 1024 * 1024);
      const parsed: unknown = JSON.parse(file.text);
      if (file.truncated || !validateContractSchema("plan", parsed).ok) throw Error("unsupported legacy plan");
      const plan = parsed as InstallerPlan;
      validatePlanConsistency(ctx.config, plan);
      const old = plan.stages.find(item => item.stage_id === stage.id);
      if (plan.plan_hash !== basis.planHash || !old
        || stableStringify(old) !== stableStringify(serializeStagePlan(stage.plan(ctx.config, basis.source)))) {
        throw Error("legacy policy changed");
      }
    } catch {
      blocked(stage, "Legacy completion needs its exact bound reviewed plan and unchanged producer policy.");
    }
  }

  const journal = await inspectJournalEvidence(fs, ctx.config);
  if (journal.parseError || journal.unknownOrder || journal.oversized || journal.legacyFormat || journal.unresolvedOperationIds.length > 0) {
    blocked(stage, "Journal cannot prove a complete ordered prefix.");
  }
  const bindings = journal.receiptBindings ?? [];
  const entries: PublishedOperation[] = [];
  let previousSequence = 0;
  for (const [index, operation] of prefix.entries()) {
    let entry = basis.progress?.[index];
    if (!entry) {
      const record = retained.find(item => item.receipt.operationId === operation.id && item.receipt.resourceId === operation.resourceId);
      const candidates = bindings.filter(binding => binding.stage === stage.id && binding.operationId === operation.id);
      const binding = record
        ? candidates.find(item => item.attemptId === record.checkpoint.attempt_id && item.sequence === record.checkpoint.sequence)
        : candidates.length === 1 ? candidates[0] : undefined;
      if (!binding) blocked(stage, "Legacy publication is missing or ambiguous; resource aliases are insufficient.");
      entry = { currentId: operation.id, operation, attemptId: binding.attemptId, receiptHash: binding.receiptHash };
    }
    const binding = bindings.find(item => item.stage === stage.id && item.operationId === entry.operation.id
      && item.attemptId === entry.attemptId && item.receiptHash === entry.receiptHash);
    if (!binding || binding.sequence <= previousSequence) blocked(stage, "Operation publication does not match the ordered checkpoint chain.");
    previousSequence = binding.sequence;
    entries.push(entry);
  }

  const upgraded: PolicyBasis = { ...basis, version: 2, progress: entries };
  const proofCtx = { ...ctx, completedOperationReceipts: policyReceipts(ctx, upgraded) };
  const published: StagePlan = { ...reviewed, operations: entries.map(entry => entry.operation) };
  for (const [index, operation] of prefix.entries()) {
    const entry = entries[index]!;
    if (entry.currentId !== operation.id || !sameOperation(stage, proofCtx, published, operation, entry.operation)) {
      blocked(stage, "Published operation differs from the reviewed semantic action/security policy.");
    }
  }
  const frontier = entries.at(-1)!;
  const record = retained.find(item => item.receipt.operationId === frontier.operation.id
    && item.receipt.resourceId === frontier.operation.resourceId && item.checkpoint.attempt_id === frontier.attemptId
    && receiptHash(item.receipt) === frontier.receiptHash);
  const frontierBinding = bindings.find(item => item.attemptId === frontier.attemptId && item.operationId === frontier.operation.id);
  if (!record || !frontierBinding || record.checkpoint.stage !== stage.id
    || record.checkpoint.operation_id !== frontier.operation.id || record.checkpoint.sequence !== frontierBinding.sequence
    || record.checkpoint.state_hash !== frontierBinding.stateHash) {
    blocked(stage, "The current frontier receipt is not retained with its exact publication binding.");
  }
  ctx.previousOperationReceipt = record.receipt;
  await stage.verifyProgress(ctx, basis.source);
  return upgraded;
}

/** Rebind a proven prefix to a newly reviewed catalog, comparing the whole semantic operation. */
export function carryOperationProgress(stage: StageModule, ctx: StageContext, previous: PolicyBasis, source: PolicyBasis["source"]): PublishedOperation[] {
  const oldPlan = stage.progressPolicyPlan?.(ctx.config, previous.source) ?? stage.plan(ctx.config, previous.source);
  const newPlan = stage.progressPolicyPlan?.(ctx.config, source) ?? stage.plan(ctx.config, source);
  if (previous.completed.length === 0 || newPlan.operations.length === 0) return [];
  const proofCtx = { ...ctx, completedOperationReceipts: policyReceipts(ctx, previous) };
  return previous.completed.map((id, index) => {
    const old = oldPlan.operations[index];
    const current = newPlan.operations[index];
    const publication = previous.progress?.[index];
    if (!old || old.id !== id || !current || !publication || !sameOperation(stage, proofCtx, oldPlan, current, old)) {
      blocked(stage, "A new review changes a completed action or its security requirements; explicit reconciliation is required.");
    }
    return { ...publication, currentId: current.id };
  });
}
