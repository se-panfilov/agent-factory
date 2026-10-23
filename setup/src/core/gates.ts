import { type Clock } from "./config";
import { ExitCode, type PersistedGateState, type SetupState } from "./types";
import { setupError } from "./errors";

const GATE_TTL_MS = 30 * 60 * 1000;

function isPrerequisiteGateId(gateId: string): boolean {
  return gateId.endsWith("-required");
}

function effectiveStatus(gate: PersistedGateState, clock: Clock): PersistedGateState["status"] {
  if (new Date(gate.expires_at).getTime() <= clock.now().getTime()) {
    return "expired";
  }
  return gate.status;
}

export function expireGates(state: SetupState, clock: Clock): SetupState {
  return {
    ...state,
    pending_gates: state.pending_gates.map((gate) => ({
      ...gate,
      status: effectiveStatus(gate, clock)
    }))
  };
}

export function requiredGatesForPlan(state: SetupState, planHash: string, clock: Clock): PersistedGateState[] {
  return expireGates(state, clock).pending_gates
    .filter((gate) => gate.plan_hash === planHash && gate.status === "pending");
}

export function ensureNonInteractiveGates(
  state: SetupState,
  planHash: string,
  nonInteractive: boolean,
  clock: Clock
): void {
  if (!nonInteractive) {
    return;
  }
  const required = state.pending_gates.filter((gate) => {
    if (gate.plan_hash !== planHash) {
      return false;
    }
    return effectiveStatus(gate, clock) !== "approved";
  }
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
    const existingIndex = next.findIndex((gate) =>
      gate.id === gateId
      && gate.plan_hash === planHash
      && gate.operation_id === operationId
    );
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      if (existing === undefined) {
        continue;
      }
      const expired = new Date(existing.expires_at).getTime() <= clock.now().getTime();
      if (
        existing.operation_id === operationId
        && existing.status === "approved"
        && !expired
      ) {
        next[existingIndex] = existing;
        continue;
      }
      next[existingIndex] = {
        ...existing,
        operation_id: operationId,
        status: expired && existing.status === "approved" ? "expired" : "pending"
      };
    } else {
      next.push({
        id: gateId,
        operation_id: operationId,
        plan_hash: planHash,
        expires_at: expiresAt,
        status: "pending"
      });
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
  if (isPrerequisiteGateId(gateId)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "gate_prerequisite_not_approvable",
      publicMessage: `Gate '${gateId}' is an external prerequisite and cannot be approved directly.`,
      nextAction: "Satisfy the prerequisite condition and rerun plan/verify."
    });
  }

  const normalized = expireGates(state, clock);
  let found = false;
  let hasExpired = false;
  const updated = normalized.pending_gates.map((gate) => {
    if (gate.id !== gateId || gate.plan_hash !== planHash) {
      return gate;
    }
    found = true;
    if (gate.status === "expired") {
      hasExpired = true;
      return gate;
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
  if (hasExpired) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "gate_expired",
      publicMessage: `Gate '${gateId}' approval has expired and cannot be renewed in place.`,
      nextAction: "Generate a new plan and approve the new gate."
    });
  }
  return { ...normalized, pending_gates: updated };
}

export function ensureGateApproved(
  state: SetupState,
  planHash: string,
  gateId: string,
  clock: Clock,
  operationId?: string
): void {
  const matching = state.pending_gates.filter((item) =>
    item.id === gateId
    && item.plan_hash === planHash
    && (operationId === undefined || item.operation_id === operationId)
  );

  if (matching.length === 0) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "gate_not_approved",
      publicMessage: `Gate '${gateId}' is not approved for plan '${planHash}'.`,
      nextAction: "Approve the gate and retry apply/resume."
    });
  }

  const approved = matching.find((item) => effectiveStatus(item, clock) === "approved");
  if (approved !== undefined) {
    return;
  }

  const hasExpired = matching.some((item) => effectiveStatus(item, clock) === "expired");
  if (hasExpired) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "gate_expired",
      publicMessage: `Gate '${gateId}' approval has expired.`,
      nextAction: "Generate a new plan and approve a fresh gate."
    });
  }

  throw setupError({
    exitCode: ExitCode.ManualActionRequired,
    code: "gate_not_approved",
    publicMessage: `Gate '${gateId}' is not approved for plan '${planHash}'.`,
    nextAction: "Approve the gate and retry apply/resume."
  });
}
