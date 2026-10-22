import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { ExitCode, type SetupConfig } from "./types";
import { setupError } from "./errors";
import { validateContractSchema } from "./validators";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashConfig(config: SetupConfig): string {
  return sha256Hex(stableStringify(config));
}

export function resolveConfigPath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

export async function loadConfig(fsAdapter: FilesystemAdapter, configPath: string): Promise<SetupConfig> {
  const resolvedPath = resolveConfigPath(configPath);
  let raw: string;
  try {
    raw = await fsAdapter.readText(resolvedPath);
  } catch {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "config_missing",
      publicMessage: `Config file not found: ${resolvedPath}`,
      nextAction: "Run 'factory-setup init --config PATH --profile supervised|service' first."
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "config_invalid_json",
      publicMessage: `Config file is not valid JSON: ${resolvedPath}`,
      nextAction: "Fix config JSON and retry."
    });
  }

  const validation = validateContractSchema("config", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "config_schema_error",
      publicMessage: `Config validation failed: ${validation.errors.join("; ")}`,
      nextAction: "Fix config to match FACTORY-SETUP-CONTRACT 1.0.0."
    });
  }

  return parsed as SetupConfig;
}

export async function initConfig(
  fsAdapter: FilesystemAdapter,
  configPath: string,
  profile: "supervised" | "service",
  expectedUser: string
): Promise<SetupConfig> {
  const resolvedPath = resolveConfigPath(configPath);
  if (await fsAdapter.exists(resolvedPath)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "config_exists",
      publicMessage: `Refusing to overwrite existing config: ${resolvedPath}`,
      nextAction: "Remove the file manually if re-initialization is intended."
    });
  }

  const home = os.homedir();
  const config: SetupConfig = {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: randomUUID(),
    profile,
    host: {
      os: "ubuntu-24.04",
      arch: process.arch === "arm64" ? "arm64" : "amd64",
      expected_user: expectedUser
    },
    paths: {
      setup_state_dir: path.join(home, ".local", "state", "agent-factory-setup"),
      setup_cache_dir: path.join(home, ".local", "share", "agent-factory-setup", "releases"),
      setup_bin_dir: path.join(home, ".local", "bin"),
      setup_node_dir: path.join(home, ".local", "share", "agent-factory-setup", "node", "24.19.0"),
      application_dir: path.join(home, "work", "agent-factory"),
      application_state_dir: path.join(home, "work", "agent-factory", "state"),
      application_auth_dir: path.join(home, "work", "agent-factory", "auth"),
      application_work_dir: path.join(home, "work", "factory-toy")
    },
    release: {
      archive_path: path.join(home, "releases", "factory-setup-release.tar.xz"),
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      source_commit: "0000000000000000000000000000000000000000"
    },
    version_lock_path: path.join(home, "releases", "versions.lock.json"),
    selected_stages: ["S01", "S02", "S03", "S04", "S05", "S06", "S07"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(home, "work", "agent-factory", "auth")
    },
    github: {
      repository_allowlist: []
    },
    optional_features: {
      inference: false,
      platforms: false
    },
    operations: {
      backup_path: path.join(home, ".local", "state", "agent-factory-setup", "backups", "s11"),
      retention_days: 14
    }
  };

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await fsAdapter.writeText(resolvedPath, serialized, 0o600);
  await fsAdapter.fsyncFile(resolvedPath);
  await fsAdapter.fsyncDir(path.dirname(resolvedPath));
  return config;
}
