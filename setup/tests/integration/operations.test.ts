import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { createBackup, verifyBackup } from "../../src/operations/backup";
import { restoreBackup } from "../../src/operations/restore";
import { emergencyCancel } from "../../src/operations/emergency";
import { ExitCode, type SetupConfig } from "../../src/core/types";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";

class FakeProcessAdapter implements ProcessAdapter {
  constructor(private readonly mode: "ok" | "sqlite_busy" | "sqlite_enospc" = "ok") {}

  stoppedContainerIds: string[] = [];

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    if (options.binary === "/usr/bin/sqlite3") {
      if (this.mode === "sqlite_busy") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "database is busy",
          timedOut: false,
          durationMs: 1
        };
      }
      if (this.mode === "sqlite_enospc") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "no space left on device",
          timedOut: false,
          durationMs: 1
        };
      }
      const backupArg = options.args.find((entry) => entry.startsWith(".backup "));
      if (backupArg !== undefined) {
        const source = options.args[0] ?? "";
        const target = backupArg.replace(".backup ", "");
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.promises.copyFile(source, target);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false, durationMs: 1 };
    }
    if (options.binary === "/bin/df") {
      return {
        exitCode: 0,
        stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 50 50 50% /\n",
        stderr: "",
        timedOut: false,
        durationMs: 1
      };
    }
    if (options.binary === "/usr/bin/free") {
      return {
        exitCode: 0,
        stdout: "              total        used        free      shared  buff/cache   available\nMem:        1000000      100000      200000       10000      700000      200000\n",
        stderr: "",
        timedOut: false,
        durationMs: 1
      };
    }
    if (options.binary === "/usr/bin/systemctl") {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
    }
    if (options.binary === "/usr/bin/docker") {
      if (options.args[0] === "ps") {
        return {
          exitCode: 0,
          stdout: "owned-container\nforeign-container\n",
          stderr: "",
          timedOut: false,
          durationMs: 1
        };
      }
      if (options.args[0] === "inspect") {
        const containerId = options.args.at(-1);
        return {
          exitCode: 0,
          stdout: containerId === "owned-container" ? "11111111-2222-4333-8444-555555555555\n" : "other-installation\n",
          stderr: "",
          timedOut: false,
          durationMs: 1
        };
      }
      if (options.args[0] === "stop") {
        const id = options.args[1] ?? "";
        this.stoppedContainerIds.push(id);
        return { exitCode: 0, stdout: `${id}\n`, stderr: "", timedOut: false, durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
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

  async hostIdentity(): Promise<{ os: "ubuntu-24.04"; arch: "amd64" }> { return { os: "ubuntu-24.04", arch: "amd64" }; }
  async loginSessionId(): Promise<string> { return "injected-test-login"; }
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
    installation_id: "11111111-2222-4333-8444-555555555555",
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
    selected_stages: ["S11"],
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

async function writeManifest(config: SetupConfig): Promise<void> {
  const payload = {
    schema_version: 1,
    application_version: "1.0.0",
    source_commit: config.release.source_commit,
    content_hashes: {
      "dist/index.js": "c".repeat(64)
    },
    node_range: ">=24.0.0 <25",
    capabilities: ["runner-readonly", "app-pause", "app-stop", "app-status", "app-recover"],
    commands: {
      runner_verify: ["node", "dist/verify.js"],
      runner_stop: ["node", "dist/stop.js"],
      app_pause: ["node", "dist/pause.js"],
      app_status: ["node", "dist/status.js"],
      app_recover: ["node", "dist/recover.js"]
    },
    config_schema_version: 1,
    state_schema_version: 1,
    migrations: {
      from: 1,
      to: 2
    },
    security_evidence_refs: ["security/m2-reviewed.json"]
  };
  await fs.promises.mkdir(config.paths.application_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.application_dir, "deployment-manifest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("S11 backup create+verify excludes auth and keeps latest good backup", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p11-backup-"));
  const config = makeConfig(root);
  await writeManifest(config);
  await fs.promises.mkdir(config.paths.application_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(config.paths.application_auth_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "PAUSED"), "1\n", "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "history.log"), "h\n", "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "live-smoke.json"), JSON.stringify({
    status: "needs_review",
    unknown_usage: true,
    usage: { daily_consumed: 2 }
  }), "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_auth_dir, "token.txt"), "TOP_SECRET", "utf8");

  const result = await createBackup(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter("ok"),
      now: () => new Date("2026-10-22T10:00:00.000Z")
    },
    config
  );
  const verified = await verifyBackup(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter("ok"),
      now: () => new Date("2026-10-22T10:00:10.000Z")
    },
    config,
    result.backupId
  );

  const backupContents = await fs.promises.readdir(path.join(result.backupPath, "payload", "state"));
  assert.equal(backupContents.includes("history.log"), true);
  assert.equal(await fs.promises.access(path.join(result.backupPath, "payload", "auth")).then(() => true).catch(() => false), false);
  const entries = (await fs.promises.readFile(verified.manifestPath, "utf8"));
  assert.equal(entries.includes("token.txt"), false);
});

test("S11 restore keeps PAUSED and unknown usage in target state", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p11-restore-"));
  const config = makeConfig(root);
  await writeManifest(config);
  await fs.promises.mkdir(config.paths.application_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "PAUSED"), "1\n", "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "live-smoke.json"), JSON.stringify({
    status: "needs_review",
    unknown_usage: true,
    usage: { daily_consumed: 3 }
  }), "utf8");

  const backup = await createBackup(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter("ok"),
      now: () => new Date("2026-10-22T11:00:00.000Z")
    },
    config
  );

  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "PAUSED"), "", "utf8");
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "live-smoke.json"), JSON.stringify({
    status: "ok",
    unknown_usage: false,
    usage: { daily_consumed: 1 }
  }), "utf8");

  const restore = await restoreBackup(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter("ok"),
      now: () => new Date("2026-10-22T11:10:00.000Z")
    },
    config,
    backup.backupId
  );
  const restoredLiveSmoke = JSON.parse(await fs.promises.readFile(path.join(config.paths.application_state_dir, "live-smoke.json"), "utf8")) as {
    unknown_usage: boolean;
    usage: { daily_consumed: number };
  };

  assert.equal(await fs.promises.access(path.join(config.paths.application_state_dir, "PAUSED")).then(() => true).catch(() => false), true);
  assert.equal(restoredLiveSmoke.unknown_usage, true);
  assert.equal(restoredLiveSmoke.usage.daily_consumed, 3);
  assert.equal(await fs.promises.access(backup.backupPath).then(() => true).catch(() => false), true);
  assert.equal(restore.restoredPaths.includes(config.paths.application_state_dir), true);
});

test("S11 sqlite busy/enospc does not delete previous good backup", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p11-busy-"));
  const config = makeConfig(root);
  await writeManifest(config);
  await fs.promises.mkdir(config.paths.application_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.application_state_dir, "PAUSED"), "1\n", "utf8");

  const serviceDbPath = path.join(root, "service", "factory.sqlite3");
  await fs.promises.mkdir(path.dirname(serviceDbPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(serviceDbPath, "db", "utf8");
  process.env.FACTORY_SERVICE_DB_PATH = serviceDbPath;

  try {
    const first = await createBackup(
      {
        fsAdapter: new NodeFilesystemAdapter(),
        processAdapter: new FakeProcessAdapter("ok"),
        now: () => new Date("2026-10-22T12:00:00.000Z")
      },
      config
    );
    await assert.rejects(
      async () => createBackup(
        {
          fsAdapter: new NodeFilesystemAdapter(),
          processAdapter: new FakeProcessAdapter("sqlite_busy"),
          now: () => new Date("2026-10-22T12:10:00.000Z")
        },
        config
      ),
      (error) => (
        error instanceof Error
        && "exitCode" in error
        && ((error as { exitCode?: number }).exitCode === ExitCode.OperationOrVerificationFailed)
      )
    );
    const backupsRoot = path.join(config.paths.setup_state_dir, "backups", "s11");
    const backups = (await fs.promises.readdir(backupsRoot)).filter((entry) => !entry.startsWith(".tmp-"));
    assert.equal(backups.includes(first.backupId), true);
    assert.equal(backups.length, 1);
  } finally {
    delete process.env.FACTORY_SERVICE_DB_PATH;
  }
});

test("S11 emergency cancel ignores lock and stops only owned resources", async () => {
  const { trustedEmergencyFixture } = await import("../helpers/r3-protocol");
  const q = await trustedEmergencyFixture();
  await q.inventory();
  await fs.promises.mkdir(path.join(q.x.config.paths.setup_state_dir, "lock"), { mode: 0o700 });
  const result = await emergencyCancel({ processAdapter: q.proc, fsAdapter: q.x.f }, q.x.config);
  assert.deepEqual([...q.stopped], ["a".repeat(12)]);
  assert.deepEqual(result.skippedForeignContainers, ["b".repeat(12)]);
  assert.equal(await fs.promises.access(path.join(q.x.config.paths.setup_state_dir, "cancel-request.json")).then(() => true).catch(() => false), false);
});
