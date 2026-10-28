import { performance } from "node:perf_hooks";
import { setupError } from "./errors";
import { ExitCode } from "./types";

/** Internal monotonic budget. Each await is fenced again; a late completion grants no authority. */
export class AttemptDeadline {
  readonly expires: number;
  constructor(readonly budgetMs: number, private readonly now: () => number = () => performance.now(), readonly signal?: AbortSignal) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw Error("Invalid internal deadline");
    this.expires = now() + budgetMs;
  }
  remaining(): number { return Math.max(0, Math.floor(this.expires - this.now())); }
  assert(): void {
    if (this.remaining() <= 0 || this.signal?.aborted) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "emergency_deadline_or_cancel", publicMessage: "Emergency attempt deadline/cancellation reached; remaining cleanup is unconfirmed.",
      nextAction: "Keep PAUSED and evidence; manually inspect and reconcile remaining resources. Do not automatically repeat stop." });
  }
  async wait<T>(start: () => Promise<T>): Promise<T> {
    this.assert();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([start(), new Promise<never>((_, reject) => {
        const fail = () => { try { this.assert(); } catch (e) { reject(e); } };
        // A real timer expiry must refuse even if an injected monotonic clock has not advanced.
        timer = setTimeout(() => reject(setupError({ exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "emergency_deadline_or_cancel", publicMessage: "Emergency boundary did not complete within the attempt budget.",
          nextAction: "Preserve PAUSED and manually reconcile unknown outcomes; do not retry automatically." })), this.remaining());
        abort = fail; this.signal?.addEventListener("abort", fail, { once: true });
      })]);
      this.assert(); return value;
    } finally { if (timer) clearTimeout(timer); if (abort) this.signal?.removeEventListener("abort", abort); }
  }
}
