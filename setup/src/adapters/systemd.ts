import { commandSucceeded, commandFinished } from "./process";
import path from "node:path";
import { type FilesystemAdapter } from "./filesystem";
import { type ProcessAdapter } from "./process";
import { setupError } from "../core/errors";
import { ExitCode } from "../core/types";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface UnitState {
  exists: boolean;
  fragmentPath: string | null;
  enabled: boolean;
  active: boolean;
}

export interface AppCommandInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface AppCommandResult extends Partial<import("./process").CommandResult> {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SystemdAdapter {
  inspectUnit(unitName: string): Promise<UnitState>;
  verifyUnitFile(unitPath: string): Promise<void>;
  installUnit(sourcePath: string, targetPath: string): Promise<void>;
  daemonReload(): Promise<void>;
  enableUnit(unitName: string): Promise<void>;
  startUnit(unitName: string): Promise<void>;
  stopUnit(unitName: string): Promise<void>;
  ensureDirectory(targetPath: string, owner: string, group: string, mode: string): Promise<void>;
  syncRelease(sourcePath: string, targetPath: string): Promise<void>;
  runAppCommand(input: AppCommandInput): Promise<AppCommandResult>;
  backupFile(sourcePath: string, backupPath: string): Promise<void>;
  restoreFile(backupPath: string, targetPath: string): Promise<void>;
  pathExists(targetPath: string): Promise<boolean>;
}

function parseSystemctlShow(stdout: string): UnitState {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  const loadState = values.get("LoadState") ?? "not-found";
  const unitFileState = values.get("UnitFileState") ?? "disabled";
  const activeState = values.get("ActiveState") ?? "inactive";
  const fragmentPath = values.get("FragmentPath");
  const exists = loadState === "loaded" && fragmentPath !== undefined && fragmentPath.length > 0;
  return {
    exists,
    fragmentPath: exists ? fragmentPath ?? null : null,
    enabled: unitFileState === "enabled",
    active: activeState === "active"
  };
}

export class NodeSystemdAdapter implements SystemdAdapter {
  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly fsAdapter: FilesystemAdapter
  ) {}

  private async run(
    binary: string,
    args: string[],
    timeoutMs: number,
    env?: Record<string, string>
  ): Promise<AppCommandResult> {
    return this.processAdapter.runCommand(env === undefined ? { policy: binary === "/usr/bin/sudo" ? "critical" : "observe",
      binary,
      args,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    } : { policy: binary === "/usr/bin/sudo" ? "critical" : "observe",
      binary,
      args,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      env
    });
  }

  private async runSudo(args: string[], operationCode: string, publicMessage: string): Promise<void> {
    const result = await this.run("/usr/bin/sudo", args, MUTATION_TIMEOUT_MS);
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: operationCode,
        publicMessage,
        nextAction: "Review sudo/systemd permissions and rerun S10 with a fresh plan.",
        stage: "S10",
        evidenceRef: result.stderr.slice(0, 512)
      });
    }
  }

  async inspectUnit(unitName: string): Promise<UnitState> {
    const result = await this.run(
      "/usr/bin/systemctl",
      ["show", unitName, "--property", "LoadState,UnitFileState,ActiveState,FragmentPath", "--no-pager"],
      OBSERVE_TIMEOUT_MS
    );
    if (!commandFinished(result) || (!commandSucceeded(result) && !result.stdout.includes("LoadState=not-found"))) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s10_systemctl_show_failed",
        publicMessage: `Unable to observe unit '${unitName}'.`,
        nextAction: "Check systemd availability and unit permissions on this host.",
        stage: "S10",
        evidenceRef: result.stderr.slice(0, 512)
      });
    }
    return parseSystemctlShow(result.stdout);
  }

  async verifyUnitFile(unitPath: string): Promise<void> {
    const result = await this.run("/usr/bin/systemd-analyze", ["verify", unitPath], OBSERVE_TIMEOUT_MS);
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s10_unit_verify_failed",
        publicMessage: "systemd-analyze verify failed for rendered service unit.",
        nextAction: "Fix service template/paths and regenerate S10 plan.",
        stage: "S10",
        evidenceRef: result.stderr.slice(0, 512)
      });
    }
  }

  async installUnit(sourcePath: string, targetPath: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/install", "-D", "-m", "0644", sourcePath, targetPath],
      "s10_install_unit_failed",
      "Failed to install systemd unit."
    );
  }

  async daemonReload(): Promise<void> {
    await this.runSudo(
      ["/usr/bin/systemctl", "daemon-reload"],
      "s10_daemon_reload_failed",
      "systemctl daemon-reload failed."
    );
  }

  async enableUnit(unitName: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/systemctl", "enable", unitName],
      "s10_enable_failed",
      "Failed to enable service unit."
    );
  }

  async startUnit(unitName: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/systemctl", "start", unitName],
      "s10_start_failed",
      "Failed to start service unit."
    );
  }

  async stopUnit(unitName: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/systemctl", "stop", unitName],
      "s10_stop_failed",
      "Failed to stop service unit during rollback."
    );
  }

  async ensureDirectory(targetPath: string, owner: string, group: string, mode: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/install", "-d", "-m", mode, "-o", owner, "-g", group, targetPath],
      "s10_directory_prepare_failed",
      `Failed to prepare service directory '${targetPath}'.`
    );
  }

  async syncRelease(sourcePath: string, targetPath: string): Promise<void> {
    if (!(await this.pathExists(targetPath))) {
      await this.runSudo(
        ["/usr/bin/install", "-d", "-m", "0755", path.dirname(targetPath)],
        "s10_release_parent_prepare_failed",
        "Failed to prepare /opt release parent directory."
      );
      await this.runSudo(
        ["/usr/bin/cp", "-a", sourcePath, targetPath],
        "s10_release_sync_failed",
        "Failed to copy release into versioned /opt path."
      );
    }
  }

  async runAppCommand(input: AppCommandInput): Promise<AppCommandResult> {
    const [binary, ...args] = input.argv;
    if (binary === undefined || !binary.startsWith("/")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s10_untrusted_app_command",
        publicMessage: "Application command binary must resolve to an absolute trusted path.",
        nextAction: "Fix deployment-manifest commands and rerun S10.",
        stage: "S10"
      });
    }
    return this.run(binary, args, input.timeoutMs, input.env);
  }

  async backupFile(sourcePath: string, backupPath: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/install", "-d", "-m", "0700", path.dirname(backupPath)],
      "s10_backup_dir_prepare_failed",
      "Failed to prepare backup directory."
    );
    await this.runSudo(
      ["/usr/bin/cp", "-a", sourcePath, backupPath],
      "s10_backup_create_failed",
      "Failed to create paired SQLite backup before migration."
    );
  }

  async restoreFile(backupPath: string, targetPath: string): Promise<void> {
    await this.runSudo(
      ["/usr/bin/cp", "-a", backupPath, targetPath],
      "s10_backup_restore_failed",
      "Failed to restore paired backup during rollback."
    );
  }

  async pathExists(targetPath: string): Promise<boolean> {
    return this.fsAdapter.exists(targetPath);
  }
}

export function createNodeSystemdAdapter(
  processAdapter: ProcessAdapter,
  fsAdapter: FilesystemAdapter
): SystemdAdapter {
  return new NodeSystemdAdapter(processAdapter, fsAdapter);
}
