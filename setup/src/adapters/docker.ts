import type { CommandResult } from "./process";
import { commandSucceeded } from "./process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { type FilesystemAdapter } from "./filesystem";
import { type ProcessAdapter } from "./process";
import { ExitCode, type StageContext } from "../core/types";
import { setupError } from "../core/errors";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const DOCKER_REQUIRED_PACKAGES = [
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-buildx-plugin",
  "docker-compose-plugin"
] as const;

const DOCKER_CONFLICT_PACKAGES = [
  "docker.io",
  "docker-doc",
  "podman-docker",
  "containerd",
  "runc"
] as const;

const DOCKER_OFFICIAL_REPO_MARKER = "download.docker.com/linux/ubuntu";

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

export interface DockerPackageObservation {
  name: string;
  installedVersion: string | null;
  candidateVersion: string | null;
  officialRepoVisible: boolean;
}

export interface DockerDaemonConfigObservation {
  path: string;
  exists: boolean;
  isSymlink: boolean;
  validJson: boolean;
  contentHash: string;
  ownedLogHash: string;
  hosts: string[];
  current: Record<string, unknown> | null;
}

export interface DockerRuntimeObservation {
  sudoAvailable: boolean;
  packages: DockerPackageObservation[];
  conflictPackagesInstalled: string[];
  dockerInstalled: boolean;
  managedByInstaller: boolean;
  daemonReachable: boolean;
  daemonAccess?: "available" | "permission_denied" | "unavailable" | "malformed";
  clientVersion: string | null;
  serverVersion: string | null;
  apiCompatible: boolean;
  currentContext: string | null;
  contextHost: string | null;
  localContext: boolean;
  rootlessMode: boolean;
  firewallBackend: "iptables" | "nftables" | "unknown";
  daemonConfig: DockerDaemonConfigObservation;
  dockerSocket: {
    exists: boolean;
    inspectionVerified?: boolean;
    mode: string;
    worldWritable: boolean;
    uid: number | null;
    gid: number | null;
  };
  tcpApi: {
    configured: boolean;
    inspectionVerified?: boolean;
    listening: boolean;
  };
  workloads: {
    inspection?: "verified" | "unavailable" | "malformed";
    foreignContainerCount: number;
    foreignContainerIds: string[];
    publicPublishedPortCount: number;
  };
  resources: {
    cpuCount: number;
    memoryBytes: number;
    cgroupVersion: string;
    pidsLimitSupported: boolean;
  };
  dockerGroup: {
    exists: boolean;
    currentUserInGroup: boolean;
    /** Account database membership, distinct from this running process group set. */
    accountUserInGroup?: boolean;
  };
  reloginRequired: boolean;
}

export interface DockerPackagePin {
  name: string;
  version: string;
}

export interface DockerFixtureProbeResult {
  fixtureRef: string;
  containerName: string;
  cleanupOk: boolean;
  cleanupDetails: string;
  readOnlyRootFs: boolean;
  noNewPrivileges: boolean;
  capDropAll: boolean;
  pidsLimit: number | null;
  memoryBytes: number | null;
  cpuQuotaCpus: string | null;
  cgroupApplied: boolean;
  labelsPresent: boolean;
}

export interface DockerAdapter {
  observe(ctx: StageContext): Promise<DockerRuntimeObservation>;
  installPinnedPackages(pins: DockerPackagePin[]): Promise<void>;
  mergeOwnedDaemonLogConfig(
    logConfig: { logDriver: string; logOpts: Record<string, string> }
  ): Promise<{ changed: boolean; resultingHash: string }>;
  validateDaemonConfig(): Promise<void>;
  restartDaemon(): Promise<void>;
  ensureDockerGroupMembership(ctx: StageContext): Promise<{ changed: boolean }>;
  runPinnedResourceProbe(ctx: StageContext, operationId: string, fixtureRef: string): Promise<DockerFixtureProbeResult>;
  markManagedInstallation(ctx: StageContext): Promise<void>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseVersionMajorMinor(version: string): { major: number; minor: number } | null {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }
  return { major, minor };
}

function versionsCompatible(clientVersion: string | null, serverVersion: string | null): boolean {
  if (clientVersion === null || serverVersion === null) {
    return false;
  }
  const client = parseVersionMajorMinor(clientVersion);
  const server = parseVersionMajorMinor(serverVersion);
  if (client === null || server === null) {
    return false;
  }
  return client.major === server.major && Math.abs(client.minor - server.minor) <= 1;
}

function assertPackageName(name: string): void {
  if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s04_package_name_invalid",
      publicMessage: `Unsafe docker package name: ${name}`,
      nextAction: "Use reviewed docker package names from installer allowlist.",
      stage: "S04"
    });
  }
}

function assertVersion(version: string): void {
  if (!/^[A-Za-z0-9.+:~_-]+$/.test(version)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s04_package_version_invalid",
      publicMessage: `Unsafe docker package pin: ${version}`,
      nextAction: "Regenerate plan and use trusted pinned versions only.",
      stage: "S04"
    });
  }
}

function parseDpkgStatus(output: string, packageNames: string[]): Map<string, string | null> {
  const byPackage = new Map<string, string | null>();
  for (const pkg of packageNames) {
    byPackage.set(pkg, null);
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

function parsePolicyBlocks(
  output: string,
  packageNames: string[]
): Map<string, { candidateVersion: string | null; officialRepoVisible: boolean }> {
  const byPackage = new Map<string, { candidateVersion: string | null; officialRepoVisible: boolean }>();
  for (const pkg of packageNames) {
    byPackage.set(pkg, { candidateVersion: null, officialRepoVisible: false });
  }

  let current: string | null = null;
  for (const line of output.split("\n")) {
    const packageHeader = line.match(/^([a-z0-9][a-z0-9+.-]*):$/i);
    if (packageHeader?.[1] !== undefined) {
      current = packageHeader[1];
      continue;
    }
    if (current === null || !byPackage.has(current)) {
      continue;
    }
    const currentRecord = byPackage.get(current) ?? { candidateVersion: null, officialRepoVisible: false };
    const candidateMatch = line.match(/^\s*Candidate:\s+(\S+)/);
    if (candidateMatch?.[1] !== undefined) {
      byPackage.set(current, {
        ...currentRecord,
        candidateVersion: candidateMatch[1] === "(none)" ? null : candidateMatch[1]
      });
    }
    if (line.includes(DOCKER_OFFICIAL_REPO_MARKER)) {
      byPackage.set(current, {
        ...currentRecord,
        officialRepoVisible: true
      });
    }
  }
  return byPackage;
}

function inspectPorts(ports: string): { valid: boolean; public: boolean } {
  let published = false;
  const range = (value: string) => value.split("-").every(port => /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
  for (const token of ports.split(",").map(value => value.trim()).filter(Boolean)) {
    const exposed = /^(\d+(?:-\d+)?)\/(tcp|udp|sctp)$/.exec(token);
    if (exposed !== null) { if (!range(exposed[1]!)) return { valid: false, public: false }; continue; }
    const mapping = /^([0-9a-fA-F:.]+|\[[0-9a-fA-F:]+\]):(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(tcp|udp|sctp)$/.exec(token);
    if (mapping === null || !range(mapping[2]!) || !range(mapping[3]!)) return { valid: false, public: false };
    if (!["127.0.0.1", "[::1]", "::1"].includes(mapping[1]!)) published = true;
  }
  return { valid: true, public: published };
}

function sanitizeEvidence(value: string): string {
  return value.trim().slice(0, 512);
}

export class NodeDockerAdapter implements DockerAdapter {
  private readonly allowMutations: boolean;

  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly fsAdapter: FilesystemAdapter
  ) {
    this.allowMutations = process.env.FACTORY_SETUP_ALLOW_S04_MUTATIONS === "1";
  }

  private async run(binary: string, args: string[], timeoutMs = OBSERVE_TIMEOUT_MS): Promise<CommandResult> {
    try {
      return await this.processAdapter.runCommand({
        policy: binary === "/usr/bin/sudo" || ["build", "run", "rm", "pull"].includes(args[0] ?? "") ? "critical" : "observe",
        binary,
        args,
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES
      });
    } catch (error) {
      if (error instanceof Error && error.name === "SetupError") throw error;
      return {
        durationMs: 0,
        exitCode: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : "command failed",
        timedOut: false
      };
    }
  }

  private async runSudo(args: string[], timeoutMs = MUTATION_TIMEOUT_MS): Promise<CommandResult> {
    return this.run("/usr/bin/sudo", ["-n", ...args], timeoutMs);
  }

  private requireMutationsEnabled(): void {
    if (!this.allowMutations) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s04_mutations_disabled",
        publicMessage: "S04 mutations are disabled in this environment.",
        nextAction: "Run S04 only on a disposable Ubuntu host and set FACTORY_SETUP_ALLOW_S04_MUTATIONS=1.",
        stage: "S04"
      });
    }
  }

  private manualStateDir(ctx: StageContext): string {
    return path.join(
      os.homedir(),
      ".local",
      "state",
      "agent-factory-setup",
      "manual",
      ctx.installationId,
      "s04"
    );
  }

  private async readMarker(ctx: StageContext, markerName: string): Promise<boolean> {
    const marker = path.join(this.manualStateDir(ctx), markerName);
    if (!(await this.fsAdapter.exists(marker))) {
      return false;
    }
    const value = (await this.fsAdapter.readText(marker)).trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "ok";
  }

  private async writeMarker(ctx: StageContext, markerName: string, value: string): Promise<void> {
    const marker = path.join(this.manualStateDir(ctx), markerName);
    await this.fsAdapter.writeText(marker, `${value}\n`, 0o600);
  }

  private async readDockerDaemonConfig(): Promise<DockerDaemonConfigObservation> {
    const daemonPath = "/etc/docker/daemon.json";
    const exists = await this.fsAdapter.exists(daemonPath);
    if (!exists) {
      return {
        path: daemonPath,
        exists: false,
        isSymlink: false,
        validJson: true,
        contentHash: hashString(""),
        ownedLogHash: hashObject({ "log-driver": null, "log-opts": {} }),
        hosts: [],
        current: {}
      };
    }

    const stat = await this.fsAdapter.lstat(daemonPath);
    const isSymlink = stat.isSymbolicLink();
    if (isSymlink) {
      return {
        path: daemonPath,
        exists: true,
        isSymlink: true,
        validJson: false,
        contentHash: hashString("symlink"),
        ownedLogHash: hashObject({ "log-driver": null, "log-opts": {} }),
        hosts: [],
        current: null
      };
    }

    const raw = await this.fsAdapter.readText(daemonPath);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const hostsValue = parsed.hosts;
      const hosts = Array.isArray(hostsValue)
        ? hostsValue.filter((item): item is string => typeof item === "string")
        : [];
      const owned = {
        "log-driver": parsed["log-driver"] ?? null,
        "log-opts": typeof parsed["log-opts"] === "object" && parsed["log-opts"] !== null ? parsed["log-opts"] : {}
      };
      return {
        path: daemonPath,
        exists: true,
        isSymlink: false,
        validJson: true,
        contentHash: hashString(raw),
        ownedLogHash: hashObject(owned),
        hosts,
        current: parsed
      };
    } catch {
      return {
        path: daemonPath,
        exists: true,
        isSymlink: false,
        validJson: false,
        contentHash: hashString(raw),
        ownedLogHash: hashObject({ "log-driver": null, "log-opts": {} }),
        hosts: [],
        current: null
      };
    }
  }

  async observe(ctx: StageContext): Promise<DockerRuntimeObservation> {
    const dockerPackages = [...DOCKER_REQUIRED_PACKAGES];
    const conflictPackages = [...DOCKER_CONFLICT_PACKAGES];
    const allPackages = [...dockerPackages, ...conflictPackages];

    const sudoCheck = await this.run("/usr/bin/sudo", ["-n", "/usr/bin/true"]);
    const sudoAvailable = commandSucceeded(sudoCheck);

    const policyResult = await this.run("/usr/bin/apt-cache", ["policy", ...allPackages]);
    const policy = parsePolicyBlocks(policyResult.stdout, allPackages);
    const installedResult = await this.run(
      "/usr/bin/dpkg-query",
      ["-W", "-f=${Package}\\t${Version}\\t${Status}\\n", ...allPackages]
    );
    const installed = parseDpkgStatus(installedResult.stdout, allPackages);

    const packageObservations: DockerPackageObservation[] = dockerPackages.map((name) => ({
      name,
      installedVersion: installed.get(name) ?? null,
      candidateVersion: policy.get(name)?.candidateVersion ?? null,
      officialRepoVisible: policy.get(name)?.officialRepoVisible ?? false
    }));
    const conflictPackagesInstalled = conflictPackages.filter((name) => (installed.get(name) ?? null) !== null);
    const dockerInstalled = packageObservations.some((pkg) => pkg.installedVersion !== null);

    const daemonConfig = await this.readDockerDaemonConfig();
    const managedByInstaller = await this.readMarker(ctx, "managed-installation");

    const contextShow = await this.run("/usr/bin/docker", ["context", "show"]);
    const currentContext = commandSucceeded(contextShow) ? contextShow.stdout.trim() : null;
    const contextInspect = currentContext === null
      ? null
      : await this.run("/usr/bin/docker", ["context", "inspect", currentContext, "--format", "{{json .Endpoints.docker.Host}}"]);

    let contextHost: string | null = null;
    if (contextInspect !== null && commandSucceeded(contextInspect) && contextInspect.stdout.trim().length > 0) {
      try {
        contextHost = JSON.parse(contextInspect.stdout.trim()) as string;
      } catch {
        contextHost = contextInspect.stdout.trim();
      }
    }
    const localContext = contextHost === "unix:///var/run/docker.sock" || (!dockerInstalled && currentContext === null);

    const versionResult = await this.run("/usr/bin/docker", ["version", "--format", "{{json .}}"]);
    let clientVersion: string | null = null;
    let serverVersion: string | null = null;
    if (commandSucceeded(versionResult) && versionResult.stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(versionResult.stdout) as {
          Client?: { Version?: string };
          Server?: { Version?: string };
        };
        clientVersion = typeof parsed?.Client?.Version === "string" ? parsed.Client.Version : null;
        serverVersion = typeof parsed?.Server?.Version === "string" ? parsed.Server.Version : null;
      } catch {
        clientVersion = null;
        serverVersion = null;
      }
    }

    const infoResult = await this.run("/usr/bin/docker", ["info", "--format", "{{json .}}"]);
    let daemonAccess: NonNullable<DockerRuntimeObservation["daemonAccess"]> = /permission denied/i.test(infoResult.stderr + versionResult.stderr) ? "permission_denied" : "unavailable";
    let daemonReachable = false;
    let rootlessMode = false;
    let firewallBackend: DockerRuntimeObservation["firewallBackend"] = "unknown";
    let cpuCount = 0;
    let memoryBytes = 0;
    let cgroupVersion = "unknown";
    let pidsLimitSupported = false;
    if (commandSucceeded(infoResult) && infoResult.stdout.trim().length > 0) {
      try {
        const info: unknown = JSON.parse(infoResult.stdout);
        if (typeof info !== "object" || info === null || Array.isArray(info) || !("NCPU" in info) || !("MemTotal" in info)
          || typeof info.NCPU !== "number" || !Number.isFinite(info.NCPU) || info.NCPU <= 0 || typeof info.MemTotal !== "number" || !Number.isFinite(info.MemTotal) || info.MemTotal <= 0
          || !("SecurityOptions" in info) || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.every(value => typeof value === "string")) throw Error("malformed info");
        const data = info as Record<string, unknown>;
        daemonReachable = true; daemonAccess = clientVersion !== null && serverVersion !== null ? "available" : "malformed";
        const securityOptions = Array.isArray(data.SecurityOptions) ? data.SecurityOptions as string[] : [];
        rootlessMode = securityOptions.some((option) => option.toLowerCase().includes("rootless"));
        const backend = typeof data.FirewallBackend === "string" ? data.FirewallBackend.toLowerCase() : "unknown";
        firewallBackend = backend === "iptables" || backend === "nftables" ? backend : "unknown";
        cpuCount = typeof data.NCPU === "number" ? data.NCPU : 0;
        memoryBytes = typeof data.MemTotal === "number" ? data.MemTotal : 0;
        cgroupVersion = typeof data.CgroupVersion === "string" ? data.CgroupVersion : "unknown";
        pidsLimitSupported = data.PidsLimit === true;
      } catch {
        daemonReachable = false; daemonAccess = "malformed";
      }
    }

    const psResult = await this.run("/usr/bin/docker", ["ps", "-a", "--format", "{{json .}}"]);
    const foreignContainerIds: string[] = [];
    let publicPublishedPortCount = 0;
    let workloadInspection: NonNullable<DockerRuntimeObservation["workloads"]["inspection"]> = "unavailable";
    if (commandSucceeded(psResult)) {
      workloadInspection = "verified";
      for (const line of psResult.stdout.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { ID?: string; Labels?: string; Ports?: string };
          if (typeof parsed?.ID !== "string" || parsed.ID.length === 0 || typeof parsed.Labels !== "string" || typeof parsed.Ports !== "string") throw Error("malformed workload");
          const labels = parsed.Labels;
          const owned = labels.split(",").includes(`com.agent-factory.installation_id=${ctx.installationId}`);
          if (!owned && parsed.ID !== undefined) {
            foreignContainerIds.push(parsed.ID);
          }
          const ports = inspectPorts(parsed.Ports);
          if (!ports.valid) throw Error("malformed port inventory");
          if (ports.public) publicPublishedPortCount += 1;
        } catch {
          workloadInspection = "malformed";
        }
      }
    }

    if (!daemonReachable || daemonAccess === "malformed") workloadInspection = daemonAccess === "malformed" ? "malformed" : "unavailable";

    let socketInspectionVerified = true;
    let socketExists = false;
    let socketMode = "0000";
    let socketUid: number | null = null;
    let socketGid: number | null = null;
    let socketWorldWritable = false;
    try {
      const sockStat = await this.fsAdapter.stat("/var/run/docker.sock");
      const mode = Number(sockStat.mode);
      socketExists = true;
      socketMode = (mode & 0o777).toString(8).padStart(4, "0");
      socketUid = Number(sockStat.uid);
      socketGid = Number(sockStat.gid);
      socketWorldWritable = (mode & 0o002) !== 0;
    } catch (error) {
      socketInspectionVerified = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    }

    const ssResult = await this.run("/usr/bin/ss", ["-lnt"]);
    const tcpListening = commandSucceeded(ssResult)
      && (ssResult.stdout.includes(":2375") || ssResult.stdout.includes(":2376"));
    const tcpConfigured = daemonConfig.hosts.some((host) => host.startsWith("tcp://"));

    const groupsResult = await this.run("/usr/bin/id", ["-nG"]);
    const accountGroups = await this.run("/usr/bin/id", ["-nG", this.processAdapter.username()]);
    const currentGroups = commandSucceeded(groupsResult)
      ? groupsResult.stdout.trim().split(/\s+/).filter((item) => item.length > 0)
      : [];
    const dockerGroupExists = commandSucceeded((await this.run("/usr/bin/getent", ["group", "docker"])));
    const currentUserInGroup = currentGroups.includes("docker");
    const reloginMarker = await this.readMarker(ctx, "docker-group-updated");
    const reloginRequired = reloginMarker && !currentUserInGroup;

    return {
      sudoAvailable,
      packages: packageObservations,
      conflictPackagesInstalled,
      dockerInstalled,
      managedByInstaller,
      daemonReachable,
      daemonAccess,
      clientVersion,
      serverVersion,
      apiCompatible: versionsCompatible(clientVersion, serverVersion),
      currentContext,
      contextHost,
      localContext,
      rootlessMode,
      firewallBackend,
      daemonConfig,
      dockerSocket: {
        exists: socketExists,
        inspectionVerified: socketInspectionVerified,
        mode: socketMode,
        worldWritable: socketWorldWritable,
        uid: socketUid,
        gid: socketGid
      },
      tcpApi: {
        configured: tcpConfigured,
        inspectionVerified: commandSucceeded(ssResult),
        listening: tcpListening
      },
      workloads: {
        inspection: workloadInspection,
        foreignContainerCount: workloadInspection === "verified" ? foreignContainerIds.length : -1,
        foreignContainerIds,
        publicPublishedPortCount: workloadInspection === "verified" ? publicPublishedPortCount : -1
      },
      resources: {
        cpuCount,
        memoryBytes,
        cgroupVersion,
        pidsLimitSupported
      },
      dockerGroup: {
        exists: dockerGroupExists,
        accountUserInGroup: commandSucceeded(accountGroups) && accountGroups.stdout.trim().split(/\s+/).includes("docker"),
        currentUserInGroup: currentUserInGroup
      },
      reloginRequired
    };
  }

  async installPinnedPackages(pins: DockerPackagePin[]): Promise<void> {
    this.requireMutationsEnabled();
    for (const pin of pins) {
      assertPackageName(pin.name);
      assertVersion(pin.version);
    }
    const args = pins.map((pin) => `${pin.name}=${pin.version}`);
    const result = await this.runSudo(
      ["/usr/bin/apt-get", "install", "--yes", "--no-install-recommends", ...APT_STRICT_OPTIONS, ...args]
    );
    if (result.timedOut) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s04_apt_lock_timeout",
        publicMessage: "Timed out waiting for apt/dpkg lock while installing Docker packages.",
        nextAction: "Wait for host package operations to finish and rerun apply.",
        stage: "S04"
      });
    }
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_docker_package_install_failed",
        publicMessage: "Docker package installation failed.",
        nextAction: "Inspect apt output, fix host package state, then rerun plan/apply.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(result.stderr)
      });
    }
  }

  async mergeOwnedDaemonLogConfig(
    logConfig: { logDriver: string; logOpts: Record<string, string> }
  ): Promise<{ changed: boolean; resultingHash: string }> {
    this.requireMutationsEnabled();
    const daemon = await this.readDockerDaemonConfig();
    if (daemon.isSymlink) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s04_daemon_config_symlink",
        publicMessage: "Refusing to modify symlinked Docker daemon config path.",
        nextAction: "Replace /etc/docker/daemon.json symlink with a regular file under owner review.",
        stage: "S04"
      });
    }
    if (!daemon.validJson || daemon.current === null) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s04_daemon_config_invalid_json",
        publicMessage: "Docker daemon config is not valid JSON.",
        nextAction: "Fix /etc/docker/daemon.json syntax and rerun S04.",
        stage: "S04"
      });
    }

    const merged: Record<string, unknown> = { ...daemon.current };
    merged["log-driver"] = logConfig.logDriver;
    merged["log-opts"] = { ...logConfig.logOpts };
    const changed = stableStringify(daemon.current) !== stableStringify(merged);
    if (!changed) {
      return { changed: false, resultingHash: hashObject(merged) };
    }

    const tempFile = path.join("/tmp", `agent-factory-s04-daemon-${Date.now()}.json`);
    const mergedText = `${JSON.stringify(merged, null, 2)}\n`;
    await this.fsAdapter.writeText(tempFile, mergedText, 0o600);
    const install = await this.runSudo([
      "/usr/bin/install",
      "-o",
      "root",
      "-g",
      "root",
      "-m",
      "0644",
      tempFile,
      daemon.path
    ]);
    await this.fsAdapter.remove(tempFile, { force: true });
    if (!commandSucceeded(install)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_daemon_config_write_failed",
        publicMessage: "Failed to write merged Docker daemon config.",
        nextAction: "Inspect sudo install permissions and filesystem space, then retry.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(install.stderr)
      });
    }

    return {
      changed: true,
      resultingHash: hashObject(merged)
    };
  }

  async validateDaemonConfig(): Promise<void> {
    this.requireMutationsEnabled();
    const result = await this.runSudo([
      "/usr/bin/dockerd",
      "--validate",
      "--config-file",
      "/etc/docker/daemon.json"
    ]);
    if (!commandSucceeded(result)) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s04_daemon_config_validate_failed",
        publicMessage: "Docker daemon config validation failed; restart is blocked.",
        nextAction: "Fix /etc/docker/daemon.json and rerun S04 plan/apply.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(result.stderr)
      });
    }
  }

  async restartDaemon(): Promise<void> {
    this.requireMutationsEnabled();
    const restart = await this.runSudo(["/usr/bin/systemctl", "restart", "docker"]);
    if (!commandSucceeded(restart)) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s04_daemon_restart_failed",
        publicMessage: "Docker daemon restart failed.",
        nextAction: "Inspect systemd/docker logs and reconcile daemon health before retrying S04.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(restart.stderr)
      });
    }
    const active = await this.runSudo(["/usr/bin/systemctl", "is-active", "--quiet", "docker"]);
    if (!commandSucceeded(active)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_daemon_inactive_after_restart",
        publicMessage: "Docker daemon is not active after restart.",
        nextAction: "Inspect docker.service and recover daemon health before resume.",
        stage: "S04"
      });
    }
  }

  async ensureDockerGroupMembership(ctx: StageContext): Promise<{ changed: boolean }> {
    this.requireMutationsEnabled();
    const username = this.processAdapter.username();
    const currentGroups = await this.run("/usr/bin/id", ["-nG", username]);
    const alreadyMember = commandSucceeded(currentGroups)
      && currentGroups.stdout.trim().split(/\s+/).includes("docker");
    if (alreadyMember) {
      return { changed: false };
    }
    const addResult = await this.runSudo(["/usr/sbin/usermod", "-aG", "docker", username]);
    if (!commandSucceeded(addResult)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_group_membership_update_failed",
        publicMessage: "Failed to add user to docker group.",
        nextAction: "Inspect group policy and rerun S04 after resolving privileges.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(addResult.stderr)
      });
    }
    await this.writeMarker(ctx, "docker-group-updated", "true");
    return { changed: true };
  }

  async runPinnedResourceProbe(ctx: StageContext, operationId: string, fixtureRef: string): Promise<DockerFixtureProbeResult> {
    this.requireMutationsEnabled();
    const containerName = `af-s04-${ctx.installationId.slice(0, 8)}-${operationId.slice(-6)}`;
    const labelInstallation = `com.agent-factory.installation_id=${ctx.installationId}`;
    const labelOperation = `com.agent-factory.operation_id=${operationId}`;

    const pull = await this.run("/usr/bin/docker", ["pull", fixtureRef], MUTATION_TIMEOUT_MS);
    if (!commandSucceeded(pull)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_fixture_pull_failed",
        publicMessage: "Failed to pull pinned S04 fixture image.",
        nextAction: "Verify network/repository access and retry S04 apply.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(pull.stderr)
      });
    }

    const runResult = await this.run(
      "/usr/bin/docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--label",
        labelInstallation,
        "--label",
        labelOperation,
        "--read-only",
        "--cpus",
        "1",
        "--memory",
        "256m",
        "--pids-limit",
        "64",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        fixtureRef,
        "sleep",
        "15"
      ],
      MUTATION_TIMEOUT_MS
    );
    if (!commandSucceeded(runResult)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_fixture_run_failed",
        publicMessage: "Pinned S04 fixture container run failed.",
        nextAction: "Inspect daemon health and cgroup support before retrying S04.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(runResult.stderr)
      });
    }

    const inspect = await this.run(
      "/usr/bin/docker",
      ["inspect", containerName, "--format", "{{json .}}"],
      OBSERVE_TIMEOUT_MS
    );
    const cleanup = await this.run("/usr/bin/docker", ["rm", "-f", containerName], OBSERVE_TIMEOUT_MS);
    if (!commandSucceeded(cleanup)) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s04_fixture_cleanup_failed",
        publicMessage: "S04 fixture cleanup failed; refusing further mutation flow.",
        nextAction: "Remove fixture container manually and rerun recover/verify.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(cleanup.stderr)
      });
    }
    if (!commandSucceeded(inspect)) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s04_fixture_inspect_failed",
        publicMessage: "Failed to inspect S04 fixture container.",
        nextAction: "Inspect Docker daemon stability and rerun S04.",
        stage: "S04",
        evidenceRef: sanitizeEvidence(inspect.stderr)
      });
    }

    const parsed = JSON.parse(inspect.stdout) as {
      HostConfig?: {
        ReadonlyRootfs?: boolean;
        CapDrop?: string[];
        SecurityOpt?: string[];
        PidsLimit?: number;
        NanoCpus?: number;
        Memory?: number;
      };
      State?: {
        Running?: boolean;
      };
      Config?: {
        Labels?: Record<string, string>;
      };
    };
    const labels = parsed.Config?.Labels ?? {};
    const hostConfig = parsed.HostConfig ?? {};
    const noNewPrivileges = (hostConfig.SecurityOpt ?? []).some((item) => item === "no-new-privileges");

    return {
      fixtureRef,
      containerName,
      cleanupOk: true,
      cleanupDetails: "container removed",
      readOnlyRootFs: hostConfig.ReadonlyRootfs === true,
      noNewPrivileges,
      capDropAll: (hostConfig.CapDrop ?? []).includes("ALL"),
      pidsLimit: typeof hostConfig.PidsLimit === "number" ? hostConfig.PidsLimit : null,
      memoryBytes: typeof hostConfig.Memory === "number" ? hostConfig.Memory : null,
      cpuQuotaCpus: typeof hostConfig.NanoCpus === "number" ? String(hostConfig.NanoCpus / 1_000_000_000) : null,
      cgroupApplied: parsed.State?.Running === true,
      labelsPresent:
        labels["com.agent-factory.installation_id"] === ctx.installationId
        && labels["com.agent-factory.operation_id"] === operationId
    };
  }

  async markManagedInstallation(ctx: StageContext): Promise<void> {
    await this.writeMarker(ctx, "managed-installation", "true");
  }
}

export function createNodeDockerAdapter(processAdapter: ProcessAdapter, fsAdapter: FilesystemAdapter): DockerAdapter {
  return new NodeDockerAdapter(processAdapter, fsAdapter);
}
