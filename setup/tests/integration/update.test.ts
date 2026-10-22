import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { type SetupConfig, type StageContext, type StageObservation } from "../../src/core/types";
import { createBackup } from "../../src/operations/backup";
import { createUpdateStage } from "../../src/stages/update";

class FakeProcessAdapter implements ProcessAdapter {
  public readonly commands: string[] = [];
  private readonly failuresByAction = new Map<string, number>();

  constructor(failAction: string | null = null, failCount = 1) {
    if (failAction !== null) {
      this.failuresByAction.set(failAction, failCount);
    }
  }

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    const action = options.args[0] ?? "";
    this.commands.push(`${options.binary} ${options.args.join(" ")}`.trim());
    const remainingFailures = this.failuresByAction.get(action) ?? 0;
    if (remainingFailures > 0) {
      this.failuresByAction.set(action, remainingFailures - 1);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `${action} failed`,
        timedOut: false,
        durationMs: 1
      };
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1
    };
  }

  pid(): number {
    return 1;
  }

  uid(): number {
    return 1000;
  }

  username(): string {
    return "factory";
  }

  async bootId(): Promise<string> {
    return "boot-id";
  }

  async machineIdHash(): Promise<string> {
    return "a".repeat(64);
  }

  async processStartTicks(_pid: number): Promise<number | null> {
    return 1;
  }

  isPidAlive(_pid: number): boolean {
    return true;
  }
}

function makeConfig(root: string): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "7e46f4ee-c8f7-4062-9c1d-d2377547fcf4",
    profile: "supervised",
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
    selected_stages: ["S14"],
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
    desiredHash: "d".repeat(64),
    planHash: "e".repeat(64),
    config
  };
}

function observed(): StageObservation {
  return {
    stageId: "S14",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: new Date().toISOString()
  };
}

async function createReleases(config: SetupConfig): Promise<{ oldRelease: string; newRelease: string }> {
  const releasesRoot = path.join(config.paths.application_dir, "releases");
  const oldRelease = path.join(releasesRoot, "app-old");
  const newRelease = path.join(releasesRoot, "app-new");
  await fs.promises.mkdir(oldRelease, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(newRelease, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(oldRelease, "version.txt"), "old\n", "utf8");
  await fs.promises.writeFile(path.join(newRelease, "version.txt"), "new\n", "utf8");
  const currentPath = path.join(config.paths.application_dir, "current");
  await fs.promises.mkdir(path.dirname(currentPath), { recursive: true, mode: 0o700 });
  await fs.promises.symlink(oldRelease, currentPath);
  return { oldRelease, newRelease };
}

async function writeUpdateManifest(config: SetupConfig, backupId: string, newReleaseDir: string, overrides?: Partial<Record<string, unknown>>): Promise<void> {
  const payload: Record<string, unknown> = {
    schema_version: 1,
    stage: "S14",
    backup_id: backupId,
    installer_release: {
      version: "0.0.1",
      state_schema: 1
    },
    app_release: {
      release_id: "app-2026-10-22",
      version: "2.0.0",
      commit_sha: "c".repeat(40),
      release_dir: newReleaseDir,
      immutable: true
    },
    compatibility: {
      min_supported_state_schema: 1,
      max_supported_state_schema: 1,
      old_binary_rollback_compatible: true,
      allow_restore_from_backup: true
    },
    approvals: {
      release_trust: true,
      policy_diff_approved: true,
      permissions_diff_approved: true,
      migration_approved: true
    },
    commands: {
      pause: ["/usr/bin/fake-runner", "pause"],
      drain: ["/usr/bin/fake-runner", "drain"],
      offline_smoke: ["/usr/bin/fake-runner", "offline_smoke"],
      migrate: ["/usr/bin/fake-runner", "migrate"],
      restart_paused: ["/usr/bin/fake-runner", "restart_paused"]
    },
    updates: {
      os: "none",
      docker: "none",
      model: "none"
    }
  };
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      payload[key] = value;
    }
  }
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s14-update-manifest.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

async function setupBackup(config: SetupConfig): Promise<string> {
  await fs.promises.mkdir(config.paths.application_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "PAUSED"), "existing\n", "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "live-smoke.json"), JSON.stringify({
    unknown_usage: true,
    usage: { daily_consumed: 1 }
  }), "utf8");
  const backup = await createBackup(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(),
      now: () => new Date("2026-10-22T16:00:00.000Z")
    },
    config
  );
  return backup.backupId;
}

test("S14 apply performs staged update, keeps PAUSED, and is idempotent on repeated apply", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p14-update-success-"));
  const config = makeConfig(root);
  const { newRelease } = await createReleases(config);
  const backupId = await setupBackup(config);
  await writeUpdateManifest(config, backupId, newRelease);

  const processAdapter = new FakeProcessAdapter();
  const stage = createUpdateStage(new NodeFilesystemAdapter(), processAdapter);
  const plan = stage.plan(config, observed());
  const receipts = await stage.apply(makeCtx(config), plan);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.checks.s14_paused_preserved, true);
  assert.equal(receipts[0]?.checks.s14_switched_current, true);
  const currentTarget = await fs.promises.readlink(path.join(config.paths.application_dir, "current"), "utf8");
  assert.equal(path.resolve(path.join(config.paths.application_dir), currentTarget), newRelease);
  assert.equal(await fs.promises.access(path.join(config.paths.application_state_dir, "PAUSED")).then(() => true).catch(() => false), true);

  const receipts2 = await stage.apply(makeCtx(config), plan);
  assert.equal(receipts2[0]?.checks.s14_reconciled_without_mutations, true);
  const migrateCalls = processAdapter.commands.filter((entry) => entry.endsWith(" migrate"));
  assert.equal(migrateCalls.length, 1);
});

test("S14 crash fixture reconciles switched current without receipt before re-running migrations", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p14-update-crash-"));
  const config = makeConfig(root);
  const { oldRelease, newRelease } = await createReleases(config);
  const backupId = await setupBackup(config);
  await writeUpdateManifest(config, backupId, newRelease);

  await fs.promises.rm(path.join(config.paths.application_dir, "current"), { force: true });
  await fs.promises.symlink(newRelease, path.join(config.paths.application_dir, "current"));
  assert.equal(await fs.promises.access(path.join(config.paths.setup_state_dir, "s14-update-receipt.json")).then(() => true).catch(() => false), false);

  const processAdapter = new FakeProcessAdapter();
  const stage = createUpdateStage(new NodeFilesystemAdapter(), processAdapter);
  const plan = stage.plan(config, observed());
  const receipts = await stage.apply(makeCtx(config), plan);
  assert.equal(receipts[0]?.checks.s14_reconciled_without_mutations, true);
  const currentTarget = await fs.promises.readlink(path.join(config.paths.application_dir, "current"), "utf8");
  assert.equal(path.resolve(path.join(config.paths.application_dir), currentTarget), newRelease);
  assert.equal(oldRelease !== newRelease, true);
  assert.equal(processAdapter.commands.length, 0);
});

test("S14 rollback fixture restores previous current target when post-switch restart fails", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p14-update-rollback-"));
  const config = makeConfig(root);
  const { oldRelease, newRelease } = await createReleases(config);
  const backupId = await setupBackup(config);
  await writeUpdateManifest(config, backupId, newRelease);

  const processAdapter = new FakeProcessAdapter("restart_paused");
  const stage = createUpdateStage(new NodeFilesystemAdapter(), processAdapter);
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s14_update_rolled_back"
  );
  const currentTarget = await fs.promises.readlink(path.join(config.paths.application_dir, "current"), "utf8");
  assert.equal(path.resolve(path.join(config.paths.application_dir), currentTarget), oldRelease);
  assert.equal(await fs.promises.access(path.join(config.paths.application_state_dir, "PAUSED")).then(() => true).catch(() => false), true);
});

test("S14 drift fixture fails when receipt target differs from current symlink", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p14-update-drift-"));
  const config = makeConfig(root);
  const { oldRelease, newRelease } = await createReleases(config);
  const backupId = await setupBackup(config);
  await writeUpdateManifest(config, backupId, newRelease);

  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s14-update-receipt.json"),
    `${JSON.stringify({
      schema_version: 1,
      stage: "S14",
      installation_id: config.installation_id,
      backup_id: backupId,
      app_release_id: "app-2026-10-22",
      app_commit_sha: "c".repeat(40),
      previous_current_target: oldRelease,
      current_target: newRelease,
      migration_applied: true,
      paused_preserved: true,
      observed_at: "2026-10-22T16:00:00.000Z",
      applied_at: "2026-10-22T16:01:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rm(path.join(config.paths.application_dir, "current"), { force: true });
  await fs.promises.symlink(oldRelease, path.join(config.paths.application_dir, "current"));

  const stage = createUpdateStage(new NodeFilesystemAdapter(), new FakeProcessAdapter());
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s14_receipt_current_drift"
  );
});

test("S14 denies apply when policy/permissions diff approvals are revoked", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p14-update-approval-"));
  const config = makeConfig(root);
  const { newRelease } = await createReleases(config);
  const backupId = await setupBackup(config);
  await writeUpdateManifest(config, backupId, newRelease, {
    approvals: {
      release_trust: true,
      policy_diff_approved: false,
      permissions_diff_approved: false,
      migration_approved: true
    }
  });

  const stage = createUpdateStage(new NodeFilesystemAdapter(), new FakeProcessAdapter());
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s14_diff_approval_required"
  );
});
