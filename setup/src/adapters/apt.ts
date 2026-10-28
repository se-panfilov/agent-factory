import type { CommandResult } from "./process";
import { commandSucceeded } from "./process";
import { type FilesystemAdapter } from "./filesystem";
import { type ProcessAdapter } from "./process";
import { ExitCode } from "../core/types";
import { setupError } from "../core/errors";

export interface AptPackagePin {
  name: string;
  version: string;
}

export interface AptPackageObservation {
  name: string;
  installedVersion: string | null;
  candidateVersion: string | null;
}

export interface AptSystemObservation {
  metadataFresh: boolean;
  metadataUpdatedAt: string | null;
  sudoAvailable: boolean;
  dpkgAuditClean: boolean;
  dpkgAuditOutput: string;
  rebootRequired: boolean;
  packages: AptPackageObservation[];
}

export interface AptAdapter {
  observe(packages: string[]): Promise<AptSystemObservation>;
  refreshMetadata(): Promise<void>;
  simulateInstall(pins: AptPackagePin[]): Promise<void>;
  installPinned(pins: AptPackagePin[]): Promise<void>;
}

const APT_LOCK_TIMEOUT_SECONDS = 120;
const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const METADATA_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

const APT_STRICT_OPTIONS = [
  "-o",
  "DPkg::Lock::Timeout=120",
  "-o",
  "Acquire::AllowInsecureRepositories=false",
  "-o",
  "Acquire::AllowDowngradeToInsecureRepositories=false",
  "-o",
  "APT::Get::AllowUnauthenticated=false",
  "-o",
  "Dpkg::Use-Pty=0"
] as const;

function assertPackageName(name: string): void {
  if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "apt_package_name_invalid",
      publicMessage: `Unsafe package name: ${name}`,
      nextAction: "Use approved package names from installer allowlist.",
      stage: "S02"
    });
  }
}

function assertVersion(version: string): void {
  if (!/^[A-Za-z0-9.+:~_-]+$/.test(version)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "apt_package_version_invalid",
      publicMessage: `Unsafe package version pin: ${version}`,
      nextAction: "Regenerate the plan with trusted apt metadata and approved pins.",
      stage: "S02"
    });
  }
}

export function parseAptPolicy(output: string): Map<string, string | null> {
  const lines = output.split("\n");
  const byPackage = new Map<string, string | null>();
  let currentPackage: string | null = null;

  for (const line of lines) {
    const packageMatch = line.match(/^([a-z0-9][a-z0-9+.-]*):$/i);
    if (packageMatch?.[1] !== undefined) {
      currentPackage = packageMatch[1];
      if (!byPackage.has(currentPackage)) {
        byPackage.set(currentPackage, null);
      }
      continue;
    }
    if (currentPackage === null) {
      continue;
    }
    const candidateMatch = line.match(/^\s*Candidate:\s+(\S+)/);
    if (candidateMatch?.[1] !== undefined) {
      byPackage.set(currentPackage, candidateMatch[1] === "(none)" ? null : candidateMatch[1]);
    }
  }
  return byPackage;
}

function parseDpkgStatus(output: string, packageNames: string[]): Map<string, string | null> {
  const byPackage = new Map<string, string | null>();
  for (const packageName of packageNames) {
    byPackage.set(packageName, null);
  }

  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const [name, version, status] = line.split("\t");
    if (name === undefined || version === undefined || status === undefined) {
      continue;
    }
    if (!status.startsWith("install ok installed")) {
      continue;
    }
    if (byPackage.has(name)) {
      byPackage.set(name, version);
    }
  }
  return byPackage;
}

function trimOutput(value: string): string {
  return value.trim().slice(0, 8192);
}

export class NodeAptAdapter implements AptAdapter {
  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly fsAdapter: FilesystemAdapter,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async run(binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.processAdapter.runCommand({
      policy: binary === "/usr/bin/sudo" ? "critical" : "observe",
      binary,
      args,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
  }

  private async runSudoApt(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.run("/usr/bin/sudo", ["-n", "/usr/bin/apt-get", ...args], timeoutMs);
  }

  private async readMetadataUpdatedAt(): Promise<Date | null> {
    const stampPath = "/var/lib/apt/periodic/update-success-stamp";
    try {
      const stampStat = await this.fsAdapter.stat(stampPath);
      return stampStat.mtime;
    } catch {
      // Fall back to apt lists metadata.
    }

    let names: string[] = [];
    try {
      names = await this.fsAdapter.readdir("/var/lib/apt/lists");
    } catch {
      return null;
    }

    let latestTime: Date | null = null;
    for (const name of names) {
      if (name.endsWith(".gpg") || name.endsWith("InRelease") || name.endsWith("Packages")) {
        try {
          const stat = await this.fsAdapter.stat(`/var/lib/apt/lists/${name}`);
          if (latestTime === null || stat.mtime.getTime() > latestTime.getTime()) {
            latestTime = stat.mtime;
          }
        } catch {
          continue;
        }
      }
    }
    return latestTime;
  }

  private async ensureSudoAvailable(): Promise<void> {
    const result = await this.run("/usr/bin/sudo", ["-n", "/usr/bin/true"], OBSERVE_TIMEOUT_MS);
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
        code: "sudo_unavailable",
        publicMessage: "Passwordless sudo for reviewed apt operations is unavailable.",
        nextAction: "Grant scoped sudo access for apt operations and retry.",
        stage: "S02",
        evidenceRef: trimOutput(result.stderr) || "sudo -n /usr/bin/true"
      });
    }
  }

  async observe(packageNames: string[]): Promise<AptSystemObservation> {
    for (const name of packageNames) {
      assertPackageName(name);
    }

    const sudoCheck = await this.run("/usr/bin/sudo", ["-n", "/usr/bin/true"], OBSERVE_TIMEOUT_MS);
    const sudoAvailable = commandSucceeded(sudoCheck);

    const metadataUpdatedAt = await this.readMetadataUpdatedAt();
    const metadataFresh = metadataUpdatedAt !== null
      && this.now().getTime() - metadataUpdatedAt.getTime() <= METADATA_FRESHNESS_WINDOW_MS;

    const policy = await this.run("/usr/bin/apt-cache", ["policy", ...packageNames], OBSERVE_TIMEOUT_MS);
    if (policy.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "apt_policy_timeout",
        publicMessage: "Timed out while reading apt package candidates.",
        nextAction: "Retry after reducing system load.",
        stage: "S02"
      });
    }

    const candidates = parseAptPolicy(policy.stdout);
    const dpkgStatus = await this.run(
      "/usr/bin/dpkg-query",
      ["-W", "-f=${Package}\\t${Version}\\t${Status}\\n", ...packageNames],
      OBSERVE_TIMEOUT_MS
    );

    if (dpkgStatus.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "dpkg_query_timeout",
        publicMessage: "Timed out while reading installed package versions.",
        nextAction: "Retry after reducing system load.",
        stage: "S02"
      });
    }

    const installed = parseDpkgStatus(dpkgStatus.stdout, packageNames);
    const audit = await this.run("/usr/bin/dpkg", ["--audit"], OBSERVE_TIMEOUT_MS);
    if (audit.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "dpkg_audit_timeout",
        publicMessage: "Timed out while running dpkg audit.",
        nextAction: "Retry after reducing system load.",
        stage: "S02"
      });
    }

    const rebootRequired = await this.fsAdapter.exists("/var/run/reboot-required");

    const packages: AptPackageObservation[] = packageNames.map((name) => ({
      name,
      installedVersion: installed.get(name) ?? null,
      candidateVersion: candidates.get(name) ?? null
    }));

    return {
      metadataFresh,
      metadataUpdatedAt: metadataUpdatedAt?.toISOString() ?? null,
      sudoAvailable,
      dpkgAuditClean: audit.stdout.trim().length === 0,
      dpkgAuditOutput: audit.stdout.trim(),
      rebootRequired,
      packages
    };
  }

  async refreshMetadata(): Promise<void> {
    await this.ensureSudoAvailable();
    const result = await this.runSudoApt(["update", ...APT_STRICT_OPTIONS], MUTATION_TIMEOUT_MS);
    if (result.timedOut) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "apt_lock_wait_timeout",
        publicMessage: `Timed out waiting for apt/dpkg lock after ${APT_LOCK_TIMEOUT_SECONDS} seconds.`,
        nextAction: "Wait for other apt/dpkg activity to finish, then retry apply.",
        stage: "S02"
      });
    }
    if (!commandSucceeded(result)) {
      const stderr = trimOutput(result.stderr);
      if (stderr.includes("NO_PUBKEY") || stderr.includes("InRelease is not signed") || stderr.includes("not signed")) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "apt_unsigned_metadata",
          publicMessage: "Refusing apt update due to unsigned or untrusted repository metadata.",
          nextAction: "Fix apt repository trust and retry.",
          stage: "S02",
          evidenceRef: stderr
        });
      }
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "apt_update_failed",
        publicMessage: "apt update failed.",
        nextAction: "Inspect apt output and repository availability, then retry.",
        stage: "S02",
        evidenceRef: stderr
      });
    }
  }

  async simulateInstall(pins: AptPackagePin[]): Promise<void> {
    await this.ensureSudoAvailable();
    for (const pin of pins) {
      assertPackageName(pin.name);
      assertVersion(pin.version);
    }

    const pinArgs = pins.map((pin) => `${pin.name}=${pin.version}`);
    const result = await this.runSudoApt(
      ["-s", "install", "--no-install-recommends", ...APT_STRICT_OPTIONS, ...pinArgs],
      MUTATION_TIMEOUT_MS
    );

    if (result.timedOut) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "apt_lock_wait_timeout",
        publicMessage: `Timed out waiting for apt/dpkg lock after ${APT_LOCK_TIMEOUT_SECONDS} seconds.`,
        nextAction: "Wait for other apt/dpkg activity to finish, then retry apply.",
        stage: "S02"
      });
    }
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "apt_simulation_failed",
        publicMessage: "apt simulation failed for planned package pins.",
        nextAction: "Run plan again and review apt package availability and pin versions.",
        stage: "S02",
        evidenceRef: trimOutput(result.stderr)
      });
    }
  }

  async installPinned(pins: AptPackagePin[]): Promise<void> {
    await this.ensureSudoAvailable();
    for (const pin of pins) {
      assertPackageName(pin.name);
      assertVersion(pin.version);
    }

    const pinArgs = pins.map((pin) => `${pin.name}=${pin.version}`);
    const result = await this.runSudoApt(
      ["install", "--yes", "--no-install-recommends", ...APT_STRICT_OPTIONS, ...pinArgs],
      MUTATION_TIMEOUT_MS
    );
    if (result.timedOut) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "apt_lock_wait_timeout",
        publicMessage: `Timed out waiting for apt/dpkg lock after ${APT_LOCK_TIMEOUT_SECONDS} seconds.`,
        nextAction: "Wait for other apt/dpkg activity to finish, then retry apply.",
        stage: "S02"
      });
    }
    if (!commandSucceeded(result)) {
      const stderr = trimOutput(result.stderr);
      if (stderr.includes("dpkg was interrupted")) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "dpkg_interrupted_manual_repair",
          publicMessage: "dpkg reports interrupted package state; auto-repair is refused.",
          nextAction: "Run 'sudo dpkg --audit' and, if needed, 'sudo dpkg --configure -a', then rerun plan/apply.",
          stage: "S02",
          evidenceRef: stderr
        });
      }
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "apt_install_failed",
        publicMessage: "apt install failed.",
        nextAction: "Inspect apt output and repair manually before retrying.",
        stage: "S02",
        evidenceRef: stderr
      });
    }
  }
}
