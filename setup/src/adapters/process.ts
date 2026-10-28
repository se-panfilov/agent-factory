import { createHash } from "node:crypto";
import { supervise } from "./process-supervisor";
import type { ExecutionPolicy } from "./process-lifecycle";
import os from "node:os";
import { readFile, open } from "node:fs/promises";
import { ExitCode } from "../core/types";
import { setupError } from "../core/errors";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  outputLimitExceeded?: boolean;
  outputInvalid?: boolean;
  signal?: NodeJS.Signals | null;
  cancelled?: boolean;
  terminationReason?: "cancel" | "timeout" | "output_limit" | "descendant" | "error" | null;
  cleanup?: "confirmed" | "unknown";
  spawned?: boolean;
  spawnError?: string | null;
  observedBytes?: number;
  owner?: { runId: string; operationId: string; generation: string; pid: number | null };
}

export interface CommandOptions {
  policy: ExecutionPolicy;
  signal?: AbortSignal;
  binary: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  operationId?: string;
  cwd?: string;
}

export interface ProcessAdapter {
  hostIdentity(): Promise<{ os: string; arch: string }>;
  loginSessionId(): Promise<string>;
  runCommand(options: CommandOptions): Promise<CommandResult>;
  pid(): number;
  uid(): number;
  username(): string;
  bootId(): Promise<string>;
  machineIdHash(): Promise<string>;
  processStartTicks(pid: number): Promise<number | null>;
  isPidAlive(pid: number): boolean;
  nodeRuntime?(): Promise<{ executable: string; version: string; binarySha256: string }>;
  pidLiveness?(pid: number): "alive" | "dead" | "unknown";
}

export function commandFinished(result: Pick<CommandResult, "exitCode" | "timedOut"> & Partial<CommandResult>): boolean {
  return !result.timedOut && !result.outputInvalid && !result.outputLimitExceeded && !result.cancelled
    && !result.terminationReason && result.cleanup !== "unknown";
}

export function commandSucceeded(result: Pick<CommandResult, "exitCode" | "timedOut"> & Partial<CommandResult>): boolean {
  return result.exitCode === 0 && commandFinished(result);
}

export function parseSupportedHost(release: string, platform: string, architecture: string): { os: "ubuntu-24.04"; arch: "amd64" | "arm64" } {
  const fields = new Map<string, string>();
  for (const line of release.split("\n")) {
    if (!/^(ID|VERSION_ID)=/.test(line)) continue;
    const match = line.match(/^(ID|VERSION_ID)=(?:"([^"\\]*)"|([A-Za-z0-9._-]+))$/);
    if (!match || fields.has(match[1]!)) throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "context_host_unsupported", publicMessage: "OS release identity is malformed or ambiguous.", nextAction: "Restore OS-owned release identity and revalidate." });
    fields.set(match[1]!, match[2] ?? match[3]!);
  }
  const arch = architecture === "x64" ? "amd64" : architecture === "arm64" ? "arm64" : null;
  if (platform !== "linux" || fields.get("ID") !== "ubuntu" || fields.get("VERSION_ID") !== "24.04" || !arch) {
    throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges, code: "context_host_unsupported",
      publicMessage: "Trusted context requires Ubuntu 24.04 and a supported native architecture.", nextAction: "Use a qualified host; do not override host identity with configuration." });
  }
  return { os: "ubuntu-24.04", arch };
}

export class NodeProcessAdapter implements ProcessAdapter {
  async runCommand(options: CommandOptions): Promise<CommandResult> {
    return supervise(options);
  }

  async nodeRuntime(): Promise<{ executable: string; version: string; binarySha256: string }> {
    // The kernel reference identifies the running executable, even if its pathname was replaced.
    if (process.platform !== "linux") throw Error("Running executable identity requires Linux procfs");
    const handle = await open("/proc/self/exe", "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw Error("Unsupported runtime identity");
      const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      for (;;) {
        const r = await handle.read(buffer, 0, buffer.length, null);
        if (!r.bytesRead) break;
        total += r.bytesRead;
        if (total > 256 * 1024 * 1024) throw Error("Runtime identity exceeded bound");
        digest.update(buffer.subarray(0, r.bytesRead));
      }
      if (total !== stat.size) throw Error("Runtime changed during identity read");
      return { executable: process.execPath, version: process.versions.node, binarySha256: digest.digest("hex") };
    } finally { await handle.close(); }
  }

  pid(): number {
    return process.pid;
  }

  uid(): number {
    return typeof process.getuid === "function" ? process.getuid() : -1;
  }

  username(): string {
    return os.userInfo().username;
  }

  async hostIdentity(): Promise<{ os: "ubuntu-24.04"; arch: "amd64" | "arm64" }> {
    const release = await this.identityText("/etc/os-release", 16384);
    return parseSupportedHost(release, process.platform, process.arch);
  }

  /** Linux audit login identity survives CLI process changes, but changes with a PAM login. */
  async loginSessionId(): Promise<string> {
    const session = (await this.identityText("/proc/self/sessionid", 64)).trim();
    const loginUid = (await this.identityText("/proc/self/loginuid", 64)).trim();
    if (!/^(0|[1-9]\d*)$/.test(session) || !/^(0|[1-9]\d*)$/.test(loginUid) || !Number.isSafeInteger(Number(session)) || Number(session) >= 4294967295
      || Number(loginUid) !== this.uid()) {
      throw setupError({ exitCode: ExitCode.ManualActionRequired, code: "context_login_session_unavailable",
        publicMessage: "A verified owner audit login session is required.", nextAction: "Log in as the configured owner through a PAM/audit-enabled login, then generate and review a fresh plan." });
    }
    return `linux-audit:${this.uid()}:${session}`;
  }

  protected async identityText(file: string, limit: number): Promise<string> {
    try {
      const handle = await open(file, "r");
      try {
        const bytes = Buffer.alloc(limit + 1); const result = await handle.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead > limit) throw Error("oversized identity");
        return bytes.subarray(0, result.bytesRead).toString("utf8");
      } finally { await handle.close(); }
    } catch {
      throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges, code: "context_identity_unavailable",
        publicMessage: "OS identity cannot be read safely.", nextAction: "Restore access to OS identity files and revalidate the owner session." });
    }
  }

  async bootId(): Promise<string> {
    const boot = (await this.identityText("/proc/sys/kernel/random/boot_id", 64)).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(boot)) throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "host_boot_id_unavailable", publicMessage: "Boot identity is invalid.", nextAction: "Restore the OS boot identity before review." });
    return boot;
  }

  async machineIdHash(): Promise<string> {
    const machine = (await this.identityText("/etc/machine-id", 64)).trim();
    if (!/^[0-9a-f]{32}$/.test(machine) || /^0+$/.test(machine)) throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "host_machine_id_unavailable", publicMessage: "Machine identity is missing or invalid.", nextAction: "Restore a unique OS machine identity; do not create a plan with an unknown identity." });
    return createHash("sha256").update(machine).digest("hex");
  }

  async processStartTicks(pid: number): Promise<number | null> {
    try {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
      const statContent = await this.identityText(`/proc/${pid}/stat`, 16384);
      return parseProcStartTicks(statContent, pid);
    } catch {
      return null;
    }
  }

  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Legacy boolean callers must never interpret permission/unknown as dead.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  pidLiveness(pid: number): "alive" | "dead" | "unknown" {
    return probePidLiveness(pid, process.kill);
  }
}

/** comm can contain whitespace and parentheses. Fields after its final ')' begin at field 3. */
export function parseProcStartTicks(raw: string, pid: number): number | null {
  if (raw.length > 16384 || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const end = raw.lastIndexOf(")");
  if (!raw.startsWith(`${pid} (`) || end < 0) return null;
  const fields = raw.slice(end + 1).trim().split(/\s+/);
  const ticks = fields[19];
  if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !ticks || !/^(0|[1-9]\d*)$/.test(ticks)) return null;
  const value = Number(ticks);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function probePidLiveness(pid: number, signal: (pid: number, signal: 0) => unknown): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return "unknown";
  try { signal(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
