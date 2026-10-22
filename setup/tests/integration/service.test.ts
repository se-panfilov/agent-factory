import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { createServiceStage } from "../../src/stages/service";
import { ExitCode, type SetupConfig, type StageContext, type StageObservation } from "../../src/core/types";
import { type AppCommandInput, type AppCommandResult, type SystemdAdapter, type UnitState } from "../../src/adapters/systemd";

function makeConfig(root: string): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "d62f3cdb-b525-4170-8509-1f0be4ef4051",
    profile: "service",
    host: {
      os: "ubuntu-24.04",
      arch: "amd64",
      expected_user: "factory"
    },
    paths: {
      setup_state_dir: path.join(root, "state"),
      setup_cache_dir: path.join(root, "cache"),
      setup_bin_dir: path.join(root, "bin"),
      setup_node_dir: path.join(root, "node"),
      application_dir: path.join(root, "app"),
      application_state_dir: path.join(root, "app", "state"),
      application_auth_dir: path.join(root, "app", "auth"),
      application_work_dir: path.join(root, "app", "work")
    },
    release: {
      archive_path: path.join(root, "release.tar.xz"),
      sha256: "a".repeat(64),
      source_commit: "b".repeat(40)
    },
    version_lock_path: path.join(root, "versions.lock.json"),
    selected_stages: ["S10"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(root, "app", "auth")
    },
    github: {
      repository_allowlist: ["se-panfilov/agent-factory"]
    },
    optional_features: {
      inference: false,
      platforms: false
    }
  };
}

function makeCtx(config: SetupConfig): StageContext {
  return {
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "c".repeat(64),
    planHash: "d".repeat(64),
    config
  };
}

function placeholderObserved(): StageObservation {
  return {
    stageId: "S10",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: new Date().toISOString()
  };
}

async function writeManifest(config: SetupConfig, overrides?: Partial<Record<string, unknown>>): Promise<void> {
  const payload = {
    schema_version: 1,
    application_version: "1.0.0",
    source_commit: config.release.source_commit,
    content_hashes: {
      "dist/index.js": "c".repeat(64)
    },
    node_range: ">=24.0.0 <25",
    capabilities: [
      "runner-readonly",
      "app-recover",
      "app-serve",
      "app-pause",
      "app-stop",
      "app-migrate",
      "app-status"
    ],
    commands: {
      runner_verify: ["node", "dist/runner/verify.js"],
      runner_stop: ["node", "dist/runner/stop.js"],
      app_recover: ["node", "dist/cli.js", "recover"],
      app_serve: ["node", "dist/cli.js", "serve"],
      app_pause: ["node", "dist/cli.js", "pause"],
      app_migrate: ["node", "dist/cli.js", "migrate"],
      app_status: ["node", "dist/cli.js", "status"]
    },
    config_schema_version: 1,
    state_schema_version: 1,
    migrations: {
      from: 1,
      to: 2
    },
    security_evidence_refs: ["security/m2-reviewed.json"]
  } as Record<string, unknown>;
  const merged = {
    ...payload,
    ...overrides
  };
  await fs.promises.mkdir(config.paths.application_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.application_dir, "deployment-manifest.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8"
  );
}

async function writeM2Evidence(config: SetupConfig, overrides?: Partial<Record<string, unknown>>): Promise<void> {
  const payload = {
    schema_version: 1,
    status: "verified",
    guide_prs: ["PR8", "PR9", "PR11"],
    evidence_refs: ["security/m2-reviewed.json"],
    provenance: "owner-reviewed"
  };
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "m2-security-evidence.json"),
    `${JSON.stringify({ ...payload, ...overrides }, null, 2)}\n`,
    "utf8"
  );
}

async function writeS09Evidence(config: SetupConfig): Promise<void> {
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s09-baseline-evidence.json"),
    `${JSON.stringify({
      ci_result: "pass",
      ci_status: "success",
      provenance: "owner-reviewed"
    }, null, 2)}\n`,
    "utf8"
  );
}

class FakeSystemdAdapter implements SystemdAdapter {
  constructor(private readonly options?: { migrationFails?: boolean; hasDb?: boolean; statusPaused?: boolean }) {}

  unit: UnitState = {
    exists: false,
    fragmentPath: null,
    enabled: false,
    active: false
  };
  releasePaths = new Set<string>();
  knownPaths = new Set<string>();
  calls: string[] = [];
  backupCreated = false;
  backupRestored = false;

  async inspectUnit(_unitName: string): Promise<UnitState> {
    return { ...this.unit };
  }

  async verifyUnitFile(_unitPath: string): Promise<void> {
    this.calls.push("verify-unit");
  }

  async installUnit(_sourcePath: string, _targetPath: string): Promise<void> {
    this.calls.push("install-unit");
    this.unit.exists = true;
    this.unit.fragmentPath = "/etc/systemd/system/agent-factory.service";
  }

  async daemonReload(): Promise<void> {
    this.calls.push("daemon-reload");
  }

  async enableUnit(_unitName: string): Promise<void> {
    this.calls.push("enable-unit");
    this.unit.enabled = true;
  }

  async startUnit(_unitName: string): Promise<void> {
    this.calls.push("start-unit");
    this.unit.active = true;
  }

  async stopUnit(_unitName: string): Promise<void> {
    this.calls.push("stop-unit");
    this.unit.active = false;
  }

  async ensureDirectory(targetPath: string): Promise<void> {
    this.calls.push(`mkdir:${targetPath}`);
    this.knownPaths.add(targetPath);
  }

  async syncRelease(_sourcePath: string, targetPath: string): Promise<void> {
    this.calls.push("sync-release");
    this.releasePaths.add(targetPath);
    this.knownPaths.add(targetPath);
  }

  async runAppCommand(input: AppCommandInput): Promise<AppCommandResult> {
    const command = input.argv.join(" ");
    this.calls.push(`app:${command}`);
    if (command.includes("migrate") && this.options?.migrationFails) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "migration failed",
        timedOut: false
      };
    }
    if (command.includes("status")) {
      return {
        exitCode: 0,
        stdout: this.options?.statusPaused === false ? "{\"paused\":false}" : "{\"paused\":true}",
        stderr: "",
        timedOut: false
      };
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false
    };
  }

  async backupFile(sourcePath: string, _backupPath: string): Promise<void> {
    this.calls.push(`backup:${sourcePath}`);
    this.backupCreated = true;
  }

  async restoreFile(_backupPath: string, _targetPath: string): Promise<void> {
    this.calls.push("restore-backup");
    this.backupRestored = true;
  }

  async pathExists(targetPath: string): Promise<boolean> {
    if (targetPath.endsWith("factory.sqlite3")) {
      return this.options?.hasDb ?? false;
    }
    return this.knownPaths.has(targetPath) || this.releasePaths.has(targetPath);
  }
}

test("S10 plans gated service deployment and applies with paused startup", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p10-service-"));
  const config = makeConfig(root);
  await writeManifest(config);
  await writeM2Evidence(config);
  await writeS09Evidence(config);

  const adapter = new FakeSystemdAdapter({ hasDb: true });
  const stage = createServiceStage(new NodeFilesystemAdapter(), adapter);
  const plan = stage.plan(config, placeholderObserved());
  const receipts = await stage.apply(makeCtx(config), plan);

  assert.deepEqual(plan.requiredGates, ["s10-db-migration-approved", "s10-service-enable-approved"]);
  assert.equal(receipts.length, 1);
  assert.equal(adapter.backupCreated, true);
  assert.equal(adapter.calls.includes("enable-unit"), true);
  assert.equal(adapter.calls.includes("start-unit"), true);
  assert.equal(adapter.calls.some((entry) => entry.includes("FACTORY_START_PAUSED")), false);
});

test("S10 returns blocked capability_missing when service commands/capabilities are absent", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p10-capability-"));
  const config = makeConfig(root);
  await writeManifest(config, {
    capabilities: ["runner-readonly"],
    commands: {
      runner_verify: ["node", "dist/runner/verify.js"],
      runner_stop: ["node", "dist/runner/stop.js"]
    }
  });
  await writeM2Evidence(config);
  await writeS09Evidence(config);

  const adapter = new FakeSystemdAdapter();
  const stage = createServiceStage(new NodeFilesystemAdapter(), adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "capability_missing"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );
});

test("S10 blocks without verified M2 evidence and rolls back on migration failure", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p10-m2-"));
  const config = makeConfig(root);
  await writeManifest(config);
  await writeS09Evidence(config);

  const blockedAdapter = new FakeSystemdAdapter();
  const blockedStage = createServiceStage(new NodeFilesystemAdapter(), blockedAdapter);
  const blockedPlan = blockedStage.plan(config, placeholderObserved());
  await assert.rejects(
    async () => blockedStage.apply(makeCtx(config), blockedPlan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "capability_missing"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );

  await writeM2Evidence(config);
  const failingAdapter = new FakeSystemdAdapter({ hasDb: true, migrationFails: true });
  const failingStage = createServiceStage(new NodeFilesystemAdapter(), failingAdapter);
  const failingPlan = failingStage.plan(config, placeholderObserved());
  await assert.rejects(async () => failingStage.apply(makeCtx(config), failingPlan));
  assert.equal(failingAdapter.backupCreated, true);
  assert.equal(failingAdapter.backupRestored, true);
  assert.equal(failingAdapter.calls.includes("stop-unit"), true);
});
