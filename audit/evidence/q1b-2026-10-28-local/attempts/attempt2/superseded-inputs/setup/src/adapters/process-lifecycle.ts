import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setupError } from "../core/errors";
import { ExitCode } from "../core/types";

/** Internal authority, never deserialized from plan/config or a cancel request. */
export type ExecutionPolicy = "observe" | "interruptible" | "critical";
export type CancellationReason = "cancel" | "SIGINT" | "SIGTERM";
export class RunLifecycle {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  reason: CancellationReason | null = null;
  cleanupUnknown = false;
  operationId: string | null = null;
  readonly processes = new Map<string, { runId: string; operationId: string; generation: string; pid: number | null }>();
  cancel(reason: CancellationReason): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.controller.abort(reason);
  }
  assertAdmission(): void {
    if (this.cleanupUnknown) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "process_cleanup_unknown", publicMessage: "Owned process cleanup is unconfirmed.",
      nextAction: "Preserve lock and in-flight evidence; manually reconcile owned processes before another mutation." });
    if (this.reason !== null) throw setupError({
      exitCode: this.reason === "SIGTERM" ? ExitCode.SigTermCleanupConfirmed : ExitCode.SigIntCleanupConfirmed,
      code: "cancel_requested", publicMessage: "Cancellation requested at a safe admission boundary.",
      nextAction: "Inspect the durable checkpoint before explicitly resuming." });
  }
}
export const executionScope = new AsyncLocalStorage<RunLifecycle>();
export const TERM_GRACE_MS = 10_000;
export const KILL_SETTLE_MS = 2_000;
export const GROUP_POLL_MS = 25;
