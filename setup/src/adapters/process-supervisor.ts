import { setupError } from "../core/errors";
import { ExitCode } from "../core/types";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { commandEnvironment } from "./process-policy";
import { executionScope, TERM_GRACE_MS, KILL_SETTLE_MS, GROUP_POLL_MS, GROUP_OBSERVATION_MS } from "./process-lifecycle";
import type { CommandOptions, CommandResult } from "./process";

export type GroupFact = "alive" | "dead" | "unknown";
/** Only observes the group minted by this spawn; never selects signal targets from a census. */
async function groupFact(pgid: number, signal: AbortSignal): Promise<GroupFact> {
  try { process.kill(-pgid, 0); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
  if (process.platform !== "linux") return "alive";
  // Linux keeps unreaped zombies in a process group. Zombies cannot execute or hold pipes.
  // A bounded, read-only procfs census distinguishes them; any incomplete observation is unknown.
  try {
    const entries = (await readdir("/proc")).filter(x => /^\d+$/.test(x));
    if (entries.length > 65536) return "unknown";
    let live = false, unknown = false;
    for (let offset = 0; offset < entries.length; offset += 64) {
      if (signal.aborted) return "unknown";
      await Promise.all(entries.slice(offset, offset + 64).map(async pid => {
        try {
          const raw = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
          if (raw.length > 16384) { unknown = true; return; }
          const end = raw.lastIndexOf(")"), fields = raw.slice(end + 2).trim().split(/\s+/);
          if (end < 2 || !/^\d+$/.test(fields[2] ?? "")) { unknown = true; return; }
          if (Number(fields[2]) === pgid && !["Z", "X"].includes(fields[0]!)) live = true;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ESRCH") unknown = true; }
      }));
    }
    return live ? "alive" : unknown ? "unknown" : "dead";
  } catch { return "unknown"; }
}
function safeText(bytes: Buffer): string {
  // fatal decode drops only a trailing partial codepoint, never manufactures machine-output bytes.
  for (let cut = 0; cut <= Math.min(3, bytes.length); cut++) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - cut)); } catch { /* try trailing boundary */ }
  }
  return "";
}
function redact(text: string): string {
  return text.replace(/Bearer\s+[^\s]*/gi, "[REDACTED]")
    .replace(/-----BEGIN [\s\S]*/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]*/g, "[REDACTED]")
    .replace(/\b(?:token|secret|password)\s*[:=]\s*[^\s]*/gi, "[REDACTED]");
}
function fit(text: string, budget: number): string { return safeText(Buffer.from(text).subarray(0, budget)); }

export interface SupervisorFacts {
  /** Internal deterministic observer. A mismatched lease never authorizes a signal. */
  observe(pgid: number, generation: string): Promise<{ generation: string; status: GroupFact }>;
}

/** A single owner and a single serial transition loop own every timer and signal. */
export async function supervise(options: CommandOptions, facts?: SupervisorFacts): Promise<CommandResult> {
  const env = commandEnvironment(options);
  const started = performance.now(), scope = executionScope.getStore();
  if (scope?.cleanupUnknown) scope.assertAdmission();
  const signal = options.signal && scope
    ? AbortSignal.any([options.signal, scope.controller.signal])
    : options.signal ?? scope?.controller.signal;
  const owner = { runId: scope?.id ?? randomUUID(), operationId: options.operationId ?? scope?.operationId ?? randomUUID(), generation: randomUUID(), pid: null as number | null };
  if (process.platform === "win32") throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "process_groups_unsupported", publicMessage: "Owned POSIX process group supervision is unavailable.",
    nextAction: "Use a qualified POSIX host; do not downgrade cleanup guarantees." });
  let reason: NonNullable<CommandResult["terminationReason"]> | null = null;
  let phase: "registered" | "running" | "term" | "kill" | "settled" = "registered";
  let cleanup: "confirmed" | "unknown" = "confirmed";
  let spawnError: string | null = null, code: number | null = null, actualSignal: NodeJS.Signals | null = null;
  let exitedAt = 0;
  let closed = false, exited = false, groupAbsent = false, transitionAt = 0;
  let retained = 0, seen = 0, overflow = false;
  // Fixed capacity avoids per-chunk metadata growth for adversarial one-byte writes.
  const buffers = { stdout: { bytes: Buffer.alloc(options.maxOutputBytes), length: 0 },
    stderr: { bytes: Buffer.alloc(options.maxOutputBytes), length: 0 } };
  const wakeups = new Set<() => void>();
  const wake = () => { for (const f of [...wakeups]) f(); };
  const abort = () => { reason ??= "cancel"; wake(); };
  signal?.addEventListener("abort", abort);
  const base = (): CommandResult => {
    const marker = overflow ? "\n[truncated]" : "";
    let outputInvalid = false;
    if (!overflow) for (const stream of [buffers.stdout, buffers.stderr]) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(stream.bytes.subarray(0, stream.length)); } catch { outputInvalid = true; }
    }
    const budget = options.maxOutputBytes;
    const markerBytes = Math.min(Buffer.byteLength(marker), budget);
    let left = budget - markerBytes;
    let stdout = fit(redact(safeText(buffers.stdout.bytes.subarray(0, buffers.stdout.length))), left);
    left -= Buffer.byteLength(stdout);
    const stderr = fit(redact(safeText(buffers.stderr.bytes.subarray(0, buffers.stderr.length))), left);
    stdout += fit(marker, markerBytes);
    return { exitCode: code, signal: actualSignal, stdout, stderr, durationMs: performance.now() - started,
      timedOut: reason === "timeout", outputInvalid, outputLimitExceeded: overflow, cancelled: reason === "cancel",
      terminationReason: reason, cleanup, spawned: owner.pid !== null, spawnError, owner, observedBytes: seen };
  };
  if (signal?.aborted) {
    signal.removeEventListener("abort", abort);
    reason = "cancel";
    return base();
  }
  scope?.processes.set(owner.generation, owner);
  const child = spawn(options.binary, options.args, { detached: true, shell: false, cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"], env });
  // spawn() supplies the group leader identity before any asynchronous cancellation callback.
  owner.pid = child.pid ?? null;
  phase = "running";
  const chunk = (stream: "stdout" | "stderr", data: Buffer) => {
    seen = Math.min(Number.MAX_SAFE_INTEGER, seen + data.length);
    const take = Math.min(data.length, Math.max(0, options.maxOutputBytes - retained));
    if (take) {
      data.copy(buffers[stream].bytes, buffers[stream].length, 0, take);
      buffers[stream].length += take; retained += take;
    }
    if (seen > options.maxOutputBytes) { overflow = true; reason ??= "output_limit"; wake(); }
  };
  const out = (b: Buffer) => chunk("stdout", b), err = (b: Buffer) => chunk("stderr", b);
  const onError = (e: NodeJS.ErrnoException) => { spawnError = ["ENOENT", "EACCES", "EPERM"].includes(e.code ?? "") ? e.code! : "child_error"; reason ??= "error"; wake(); };
  const onExit = (c: number | null, s: NodeJS.Signals | null) => { code = c; actualSignal = s; exited = true; exitedAt = performance.now(); wake(); };
  const onClose = () => { closed = true; wake(); };
  child.stdout.on("data", out); child.stderr.on("data", err);
  child.on("error", onError); child.on("exit", onExit); child.on("close", onClose);
  const pause = async (ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); wakeups.delete(done); resolve(); };
    const timer = setTimeout(done, ms); wakeups.add(done);
  });
  const observeGroup = async (): Promise<GroupFact> => {
    if (owner.pid === null || groupAbsent) return "dead";
    const observer = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = facts ? facts.observe(owner.pid, owner.generation)
        : groupFact(owner.pid, observer.signal).then(status => ({ generation: owner.generation, status }));
      const fact = await Promise.race([observed, new Promise<{ generation: string; status: GroupFact }>(resolve => {
        timer = setTimeout(() => { observer.abort(); resolve({ generation: owner.generation, status: "unknown" }); }, GROUP_OBSERVATION_MS);
      })]);
      return fact.generation === owner.generation ? fact.status : "unknown";
    } catch { return "unknown"; }
    finally { if (timer) clearTimeout(timer); observer.abort(); }
  };
  const ownSignal = async (sig: NodeJS.Signals) => {
    if (owner.pid === null || groupAbsent) return;
    // This lease is minted only by detached spawn; never reacquired after observed group death.
    const fact = await observeGroup();
    if (fact === "dead") { groupAbsent = true; return; }
    if (fact === "unknown") { cleanup = "unknown"; return; }
    try { process.kill(-owner.pid, sig); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") groupAbsent = true; else cleanup = "unknown"; }
  };
  try {
    for (;;) {
      if (signal?.aborted) reason ??= "cancel";
      const elapsed = performance.now() - started;
      if (elapsed >= options.timeoutMs) reason ??= "timeout";
      if (exited && performance.now() - exitedAt >= 100 && !reason && !closed) reason = "descendant";
      if (closed && owner.pid === null) break; // Proven spawn failure: no signal target ever existed.
      if (closed || phase !== "running") {
        const fact = await observeGroup();
        if (fact === "dead") groupAbsent = true;
        if (closed && groupAbsent) break;
        if (closed && !reason) reason = "descendant";
      }
      if (reason && phase === "running") {
        phase = "term"; transitionAt = performance.now(); await ownSignal("SIGTERM");
      }
      if (phase === "term" && performance.now() - transitionAt >= TERM_GRACE_MS) {
        phase = "kill"; transitionAt = performance.now(); await ownSignal("SIGKILL");
      }
      if (phase === "kill" && performance.now() - transitionAt >= KILL_SETTLE_MS) { cleanup = "unknown"; break; }
      await pause(Math.max(1, Math.min(GROUP_POLL_MS, phase === "running" ? options.timeoutMs - elapsed : GROUP_POLL_MS)));
    }
  } finally {
    phase = "settled";
    signal?.removeEventListener("abort", abort);
    for (const f of [...wakeups]) f();
    child.stdout.off("data", out); child.stderr.off("data", err);
    child.off("error", onError); child.off("exit", onExit); child.off("close", onClose);
    if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); cleanup = "unknown"; }
    if (cleanup === "unknown" && scope) scope.cleanupUnknown = true;
    if (cleanup === "confirmed") scope?.processes.delete(owner.generation);
  }
  return base();
}
