import type { ProviderRun, RunAssessment } from "./types.js";
import { validateRoleResult } from "./role-result-validator.js";

const KNOWN_PROVIDER_EVENTS = new Set([
  "turn.completed",
  "turn.failed",
  "error",
  "message",
]);

export function assessProviderRun(run: ProviderRun): RunAssessment {
  if (run.events.some((event) => !KNOWN_PROVIDER_EVENTS.has(event.type))) {
    return { phase: "blocked", reason: "unknown_provider_event" };
  }

  const hasCompleted = run.events.some((event) => event.type === "turn.completed");
  const hasProviderError = run.events.some(
    (event) => event.type === "turn.failed" || event.type === "error"
  );
  if (!hasCompleted || hasProviderError) {
    return { phase: "blocked", reason: "provider_protocol_error" };
  }

  if (run.exitCode !== 0) {
    return { phase: "blocked", reason: "provider_or_runtime_error" };
  }

  const validation = validateRoleResult(
    run.role,
    run.taskId,
    run.inputSha,
    run.resultText
  );

  if (!validation.ok) {
    return { phase: "blocked", reason: "invalid_result" };
  }

  return { phase: "needs_review", reason: null };
}
