import path from "node:path";
import { promises as fs } from "node:fs";
import { type ProcessAdapter } from "../adapters/process";
import { type SetupConfig } from "../core/types";

const HEALTH_HISTORY_FILE = "s11-health-history.json";
const HEALTH_WINDOW_MS = 5 * 60 * 1000;

interface HealthSample {
  at: string;
  ram_available_percent: number;
}

export interface HealthSnapshot {
  observedAt: string;
  serviceHealthy: boolean;
  dockerHealthy: boolean;
  diskFreePercent: number;
  ramAvailablePercent: number;
  ram5mHealthy: boolean;
  externalHeartbeatConfigured: boolean;
  externalHeartbeatReachable: boolean;
  degradedReasons: string[];
}

export interface HealthDeps {
  processAdapter: ProcessAdapter;
  now(): Date;
}

function historyPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, HEALTH_HISTORY_FILE);
}

async function runCommand(processAdapter: ProcessAdapter, binary: string, args: string[]): Promise<string | null> {
  const result = await processAdapter.runCommand({
    binary,
    args,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return null;
  }
  return result.stdout;
}

function parseDiskFreePercent(dfOutput: string | null): number | null {
  if (dfOutput === null) {
    return null;
  }
  const lines = dfOutput.trim().split("\n");
  const line = lines.at(-1);
  if (line === undefined) {
    return null;
  }
  const columns = line.trim().split(/\s+/);
  const usedPercentRaw = columns[4];
  if (usedPercentRaw === undefined) {
    return null;
  }
  const usedPercent = Number.parseFloat(usedPercentRaw.replace("%", ""));
  if (!Number.isFinite(usedPercent)) {
    return null;
  }
  return Math.max(0, 100 - usedPercent);
}

function parseRamAvailablePercent(freeOutput: string | null): number | null {
  if (freeOutput === null) {
    return null;
  }
  const lines = freeOutput.trim().split("\n");
  const memLine = lines.find((entry) => entry.startsWith("Mem:"));
  if (memLine === undefined) {
    return null;
  }
  const columns = memLine.trim().split(/\s+/);
  const total = Number.parseFloat(columns[1] ?? "");
  const available = Number.parseFloat(columns[6] ?? "");
  if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) {
    return null;
  }
  return (available * 100) / total;
}

async function loadHistory(config: SetupConfig): Promise<HealthSample[]> {
  try {
    const payload = JSON.parse(await fs.readFile(historyPath(config), "utf8"));
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload
      .filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.at === "string" && typeof entry.ram_available_percent === "number")
      .map((entry) => ({
        at: entry.at as string,
        ram_available_percent: entry.ram_available_percent as number
      }));
  } catch {
    return [];
  }
}

async function saveHistory(config: SetupConfig, samples: HealthSample[]): Promise<void> {
  await fs.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(historyPath(config), `${JSON.stringify(samples, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export async function collectHealth(deps: HealthDeps, config: SetupConfig): Promise<HealthSnapshot> {
  const observedAt = deps.now().toISOString();
  const diskFreePercent = parseDiskFreePercent(await runCommand(deps.processAdapter, "/bin/df", ["-P", "/"]));
  const ramAvailablePercent = parseRamAvailablePercent(await runCommand(deps.processAdapter, "/usr/bin/free", []));
  const serviceStatus = await deps.processAdapter.runCommand({
    binary: "/usr/bin/systemctl",
    args: ["is-active", "agent-factory.service", "--quiet"],
    timeoutMs: 10_000,
    maxOutputBytes: 32 * 1024
  });
  const dockerStatus = await deps.processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: ["info", "--format", "{{.ServerVersion}}"],
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024
  });

  const history = await loadHistory(config);
  const withCurrent = history.concat({
    at: observedAt,
    ram_available_percent: ramAvailablePercent ?? 0
  });
  const since = deps.now().getTime() - HEALTH_WINDOW_MS;
  const windowed = withCurrent.filter((entry) => new Date(entry.at).getTime() >= since);
  await saveHistory(config, windowed);
  const ram5m = average(windowed.map((entry) => entry.ram_available_percent));
  const ram5mHealthy = ram5m >= 10;

  const externalHealthRef = path.join(config.paths.setup_state_dir, "s11-external-heartbeat.json");
  let externalHeartbeatConfigured = false;
  let externalHeartbeatReachable = false;
  try {
    const payload = JSON.parse(await fs.readFile(externalHealthRef, "utf8")) as Record<string, unknown>;
    externalHeartbeatConfigured = typeof payload.secret_ref === "string" && payload.secret_ref.length > 0;
    externalHeartbeatReachable = Boolean(payload.last_ok === true);
  } catch {
    externalHeartbeatConfigured = false;
    externalHeartbeatReachable = false;
  }

  const degradedReasons: string[] = [];
  if ((diskFreePercent ?? 0) < 15) {
    degradedReasons.push("disk_free_below_15_percent");
  }
  if ((ramAvailablePercent ?? 0) < 10) {
    degradedReasons.push("ram_available_below_10_percent");
  }
  if (!ram5mHealthy) {
    degradedReasons.push("ram_5m_average_below_10_percent");
  }
  if (serviceStatus.exitCode !== 0) {
    degradedReasons.push("service_inactive");
  }
  if (dockerStatus.exitCode !== 0) {
    degradedReasons.push("docker_unhealthy");
  }
  if (externalHeartbeatConfigured && !externalHeartbeatReachable) {
    degradedReasons.push("external_heartbeat_unreachable");
  }

  return {
    observedAt,
    serviceHealthy: serviceStatus.exitCode === 0,
    dockerHealthy: dockerStatus.exitCode === 0,
    diskFreePercent: diskFreePercent ?? 0,
    ramAvailablePercent: ramAvailablePercent ?? 0,
    ram5mHealthy,
    externalHeartbeatConfigured,
    externalHeartbeatReachable,
    degradedReasons
  };
}
