import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { ExitCode } from "../core/types";
import { setupError } from "../core/errors";

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(?:token|secret|password)\s*[:=]\s*[^\s]+/gi
];

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandOptions {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  operationId?: string;
}

export interface ProcessAdapter {
  runCommand(options: CommandOptions): Promise<CommandResult>;
  pid(): number;
  uid(): number;
  username(): string;
  bootId(): Promise<string>;
  machineIdHash(): Promise<string>;
  processStartTicks(pid: number): Promise<number | null>;
  isPidAlive(pid: number): boolean;
}

function sanitize(content: string): string {
  let sanitized = content;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

function trimToBytes(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return content;
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[truncated]`;
}

export class NodeProcessAdapter implements ProcessAdapter {
  async runCommand(options: CommandOptions): Promise<CommandResult> {
    const startedAt = Date.now();
    const operationId = options.operationId ?? randomUUID();
    if (!options.binary.startsWith("/")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "process_untrusted_binary",
        publicMessage: `Refusing to execute non-absolute binary path: ${options.binary}`,
        nextAction: "Use a trusted absolute path from reviewed release locks.",
        operationId
      });
    }

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(options.binary, options.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          ...options.env
        }
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, options.timeoutMs);

      const onChunk = (kind: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        const value = chunk.toString("utf8");
        if (kind === "stdout") {
          stdout += value;
        } else {
          stderr += value;
        }
        if (outputBytes > options.maxOutputBytes) {
          child.kill("SIGTERM");
        }
      };

      child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        resolve({
          exitCode: code ?? 1,
          stdout: trimToBytes(sanitize(stdout), options.maxOutputBytes),
          stderr: trimToBytes(sanitize(stderr), options.maxOutputBytes),
          timedOut,
          durationMs
        });
      });
    });
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

  async bootId(): Promise<string> {
    try {
      const content = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
      return content.trim();
    } catch {
      return "unknown-boot-id";
    }
  }

  async machineIdHash(): Promise<string> {
    let machineId = "unknown-machine-id";
    try {
      machineId = (await readFile("/etc/machine-id", "utf8")).trim();
    } catch {
      // keep default fallback value
    }
    return createHash("sha256").update(machineId).digest("hex");
  }

  async processStartTicks(pid: number): Promise<number | null> {
    try {
      const statContent = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = statContent.trim().split(" ");
      const startTicks = Number.parseInt(fields[21] ?? "", 10);
      return Number.isFinite(startTicks) ? startTicks : null;
    } catch {
      return null;
    }
  }

  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
