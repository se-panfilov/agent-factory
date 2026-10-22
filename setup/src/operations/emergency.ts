import path from "node:path";
import { promises as fs } from "node:fs";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";

export interface EmergencyDeps {
  processAdapter: ProcessAdapter;
}

interface EmergencyInventory {
  schema_version: 1;
  installation_id: string;
  owned_container_labels: string[];
  service_unit: string | null;
}

export interface EmergencyResult {
  pausedMarkerPath: string;
  stoppedContainers: string[];
  skippedForeignContainers: string[];
}

function inventoryPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "s11-emergency-inventory.json");
}

async function loadInventory(config: SetupConfig): Promise<EmergencyInventory | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(inventoryPath(config), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Partial<EmergencyInventory>;
    if (candidate.schema_version !== 1 || candidate.installation_id !== config.installation_id) {
      return null;
    }
    return {
      schema_version: 1,
      installation_id: config.installation_id,
      owned_container_labels: Array.isArray(candidate.owned_container_labels)
        ? candidate.owned_container_labels.filter((entry) => typeof entry === "string")
        : [],
      service_unit: typeof candidate.service_unit === "string" ? candidate.service_unit : null
    };
  } catch {
    return null;
  }
}

async function readManifest(config: SetupConfig): Promise<Record<string, unknown> | null> {
  const target = path.join(config.paths.application_dir, "deployment-manifest.json");
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stopCommandFromManifest(manifest: Record<string, unknown> | null): string[] | null {
  if (manifest === null) {
    return null;
  }
  const commands = manifest.commands;
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
    return null;
  }
  const record = commands as Record<string, unknown>;
  const candidates = [
    record.app_stop,
    record.app_stop_all,
    record.runner_stop
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every((entry) => typeof entry === "string")) {
      return candidate as string[];
    }
  }
  return null;
}

async function runCommand(
  processAdapter: ProcessAdapter,
  binary: string,
  args: string[],
  code: string,
  message: string
): Promise<{ stdout: string; stderr: string }> {
  const result = await processAdapter.runCommand({
    binary,
    args,
    timeoutMs: 20_000,
    maxOutputBytes: 128 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code,
      publicMessage: message,
      nextAction: "Use provider console/manual stop runbook and keep application paused.",
      stage: "S11",
      evidenceRef: result.stderr.slice(0, 256)
    });
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function isOwnedContainer(
  processAdapter: ProcessAdapter,
  containerId: string,
  installationId: string
): Promise<boolean> {
  const result = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: ["inspect", "--format", "{{index .Config.Labels \"agent-factory.installation_id\"}}", containerId],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return false;
  }
  return result.stdout.trim() === installationId;
}

export async function emergencyCancel(
  deps: EmergencyDeps,
  config: SetupConfig
): Promise<EmergencyResult> {
  const manifest = await readManifest(config);
  const stopArgv = stopCommandFromManifest(manifest);
  if (stopArgv === null) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "Emergency cancellation is blocked: app stop capability is missing.",
      nextAction: "Run manual emergency stop from SSH/provider console and create PAUSED marker manually.",
      stage: "S11",
      evidenceRef: path.join(config.paths.application_dir, "deployment-manifest.json")
    });
  }

  const pausedPath = path.join(config.paths.application_state_dir, "PAUSED");
  await fs.mkdir(path.dirname(pausedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(pausedPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });

  const [binaryRaw, ...argsRaw] = stopArgv;
  const binary = binaryRaw === "node"
    ? path.join(config.paths.setup_node_dir, "bin", "node")
    : binaryRaw?.startsWith("/") ? binaryRaw : path.join(config.paths.application_dir, binaryRaw ?? "");
  if (binary === undefined || binary.length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "Emergency cancellation is blocked: stop command is malformed.",
      nextAction: "Fix manifest stop command and rerun cancel --emergency.",
      stage: "S11"
    });
  }
  await runCommand(
    deps.processAdapter,
    binary,
    argsRaw,
    "s11_emergency_stop_failed",
    "Emergency stop command failed."
  );

  const inventory = await loadInventory(config);
  const stoppedContainers: string[] = [];
  const skippedForeignContainers: string[] = [];
  if (inventory !== null && inventory.owned_container_labels.length > 0) {
    for (const label of inventory.owned_container_labels) {
      const list = await runCommand(
        deps.processAdapter,
        "/usr/bin/docker",
        ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"],
        "s11_emergency_docker_list_failed",
        "Docker was unreachable during emergency cancellation."
      );
      const ids = list.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const id of ids) {
        if (!(await isOwnedContainer(deps.processAdapter, id, config.installation_id))) {
          skippedForeignContainers.push(id);
          continue;
        }
        await runCommand(
          deps.processAdapter,
          "/usr/bin/docker",
          ["stop", id],
          "s11_emergency_docker_stop_failed",
          "Failed to stop owned docker resource during emergency cancellation."
        );
        stoppedContainers.push(id);
      }
    }
  }

  return {
    pausedMarkerPath: pausedPath,
    stoppedContainers,
    skippedForeignContainers
  };
}
