import { type Clock } from "./config";
import { ExitCode, type PersistedGateState, type SetupState } from "./types";
import { setupError } from "./errors";

const GATE_TTL_MS = 30 * 60 * 1000;

export function requiredGatesForPlan(state: SetupState, planHash: string): PersistedGateState[] {
  const now = Date.now();
  return state.pending_gates
    .map((gate) => {
      if (new Date(gate.expires_at).getTime() <= now && gate.status === "approved") {
        return { ...gate, status: "expired" as const };
      }
      return gate;
    })
    .filter((gate) => gate.plan_hash === planHash && gate.status === "pending");
}

export function ensureNonInteractiveGates(
  state: SetupState,
  planHash: string,
  nonInteractive: boolean
): void {
  if (!nonInteractive) {
    return;
  }
  const required = state.pending_gates.filter(
    (gate) => gate.plan_hash === planHash && gate.status !== "approved"
  );
  if (required.length > 0) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "manual_gate_required",
      publicMessage: "Manual gate approval is required in non-interactive mode.",
      nextAction: "Approve required gate(s) with 'factory-setup gate approve --id ... --plan-hash ...'.",
      evidenceRef: required.map((gate) => gate.id).join(",")
    });
  }
}

export function upsertPlanGates(
  state: SetupState,
  planHash: string,
  operationId: string,
  gateIds: string[],
  clock: Clock
): SetupState {
  const expiresAt = new Date(clock.now().getTime() + GATE_TTL_MS).toISOString();
  const next = [...state.pending_gates];
  for (const gateId of gateIds) {
    const existingIndex = next.findIndex((gate) => gate.id === gateId && gate.plan_hash === planHash);
    const gateRecord: PersistedGateState = {
      id: gateId,
      operation_id: operationId,
      plan_hash: planHash,
      expires_at: expiresAt,
      status: "pending"
    };
    if (existingIndex >= 0) {
      next[existingIndex] = gateRecord;
    } else {
      next.push(gateRecord);
    }
  }
  return { ...state, pending_gates: next };
}

export function approveGate(
  state: SetupState,
  gateId: string,
  planHash: string,
  clock: Clock
): SetupState {
  let found = false;
  const updated = state.pending_gates.map((gate) => {
    if (gate.id !== gateId || gate.plan_hash !== planHash) {
      return gate;
    }
    found = true;
    if (new Date(gate.expires_at).getTime() <= clock.now().getTime()) {
      return { ...gate, status: "expired" as const };
    }
    return { ...gate, status: "approved" as const };
  });

  if (!found) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "gate_not_found",
      publicMessage: `Gate '${gateId}' was not found for plan hash '${planHash}'.`,
      nextAction: "Run 'factory-setup gate list' and use an existing gate id."
    });
  }
  return { ...state, pending_gates: updated };
}

export function ensureGateApproved(state: SetupState, planHash: string, gateId: string): void {
  const gate = state.pending_gates.find((item) => item.id === gateId && item.plan_hash === planHash);
  if (gate === undefined || gate.status !== "approved") {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "gate_not_approved",
      publicMessage: `Gate '${gateId}' is not approved for plan '${planHash}'.`,
      nextAction: "Approve the gate and retry apply/resume."
    });
  }
  if (new Date(gate.expires_at).getTime() <= Date.now()) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "gate_expired",
      publicMessage: `Gate '${gateId}' approval has expired.`,
      nextAction: "Generate a new plan and approve a fresh gate."
    });
  }
}
