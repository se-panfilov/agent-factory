import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { ExitCode, type SetupConfig, type StageContext, type StageModule } from "../../src/core/types";
import { createAuthStage } from "../../src/stages/auth";
import { createVerificationStage } from "../../src/stages/verification";

interface FakeFlags {
  leakSecret?: boolean;
  dockerCleanupFails?: boolean;
  authLoginFails?: boolean;
  runnerStatus?: "runner_ready_offline" | "needs_review" | "turn_failed";
}

class FakeProcessAdapter implements ProcessAdapter {
  public dockerRunCount = 0;

  constructor(
    private readonly flags: FakeFlags,
    private readonly sourceSha: string
  ) {}

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    if (options.binary === "/usr/bin/git" && options.args[2] === "rev-parse" && options.args[3] === "HEAD") {
      return this.ok(`${this.sourceSha}\n`);
    }
    if (options.binary === "/usr/bin/docker") {
      if (options.args[0] === "run") {
        this.dockerRunCount += 1;
        if (this.flags.authLoginFails) {
          return this.fail("the input device is not a TTY");
        }
        if (options.args.includes("login")) {
          return this.ok("login ok");
        }
        return this.ok("");
      }
      if (options.args[0] === "create") {
        return this.ok("container-id");
      }
      if (options.args[0] === "inspect") {
        return this.ok('[{"Destination":"/workspace/toy"}]');
      }
      if (options.args[0] === "rm") {
        if (this.flags.dockerCleanupFails) {
          return this.fail("rm failed");
        }
        return this.ok("removed");
      }
      return this.ok("");
    }
    if (options.binary.endsWith("/node")) {
      const outputIndex = options.args.indexOf("--output");
      const outputPath = outputIndex >= 0 ? options.args[outputIndex + 1] : null;
      const providerIndex = options.args.indexOf("--provider");
      const provider = providerIndex >= 0 ? options.args[providerIndex + 1] : "fake";
      if (typeof outputPath === "string") {
        const payload = {
          schema_version: 1,
          provider,
          fixture: "toy",
          task: "scout",
          source_sha: this.sourceSha,
          status: this.flags.runnerStatus ?? (provider === "live" ? "needs_review" : "runner_ready_offline"),
          terminal_events: ["runner.started", "runner.completed"],
          run_id: `${provider}-run-id`,
          usage: { daily_consumed: provider === "live" ? 1 : 0 }
        };
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      }
      const stdout = this.flags.leakSecret ? "SYNTHETIC_SECRET_MARKER\n" : "";
      return this.ok(stdout);
    }
    return this.ok("");
  }

  pid(): number {
    return 42;
  }
  uid(): number {
    return 1000;
  }
  username(): string {
    return "factory";
  }
  async bootId(): Promise<string> {
    return "4d445fab-6491-4d34-8ad3-c4d2d29f140f";
  }
  async machineIdHash(): Promise<string> {
    return "1".repeat(64);
  }
  async processStartTicks(_pid: number): Promise<number | null> {
    return 1;
  }
  isPidAlive(_pid: number): boolean {
    return true;
  }

  private ok(stdout: string): CommandResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      durationMs: 1
    };
  }

  private fail(stderr: string): CommandResult {
    return {
      exitCode: 1,
      stdout: "",
      stderr,
      timedOut: false,
      durationMs: 1
    };
  }
}

function makeConfig(root: string): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "d2fcd753-997f-4034-84dd-c5182471ce08",
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
      application_work_dir: path.join(root, "work")
    },
    release: {
      archive_path: path.join(root, "release.tar.xz"),
      sha256: "a".repeat(64),
      source_commit: "b".repeat(40)
    },
    version_lock_path: path.join(root, "versions.lock.json"),
    selected_stages: ["S07", "S08"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(root, "app", "auth")
    },
    github: {
      repository_allowlist: []
    },
    optional_features: {
      inference: false,
      platforms: false
    }
  };
}

async function writeConfig(configPath: string, config: SetupConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function prepareScenario(flags: FakeFlags = {}): Promise<{
  root: string;
  config: SetupConfig;
  configPath: string;
  engine: SetupEngine;
  processAdapter: FakeProcessAdapter;
}> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p08-verify-auth-"));
  const config = makeConfig(root);
  const configPath = path.join(root, "config", "setup.json");
  await writeConfig(configPath, config);
  await fs.promises.mkdir(path.join(config.paths.application_work_dir, "factory-toy-fixture"), { recursive: true });
  await fs.promises.mkdir(config.paths.application_dir, { recursive: true });
  await fs.promises.mkdir(config.paths.application_auth_dir, { recursive: true });
  await fs.promises.mkdir(path.join(config.paths.setup_node_dir, "bin"), { recursive: true });
  await fs.promises.writeFile(path.join(config.paths.setup_node_dir, "bin", "node"), "#!/bin/sh\n", { mode: 0o700 });
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s06-agent-image.json"),
    `${JSON.stringify({
      schema_version: 1,
      machine_id_hash: "1".repeat(64),
      image_digest: `sha256:${"c".repeat(64)}`,
      image_id: `sha256:${"d".repeat(64)}`,
      build_context_hash: "e".repeat(64),
      codex_version: "0.32.0",
      base_image_digest: `sha256:${"f".repeat(64)}`,
      built_at: "2026-10-22T00:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(config.paths.application_dir, "deployment-manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      application_version: "m0.0.1",
      source_commit: config.release.source_commit,
      content_hashes: { "runner.js": "1".repeat(64) },
      node_range: ">=24.0.0 <25",
      capabilities: ["runner-readonly", "runner-live-smoke"],
      commands: {
        runner_verify: ["node", "runner.js"],
        runner_stop: ["node", "runner.js", "stop"]
      },
      config_schema_version: 1,
      state_schema_version: 1,
      migrations: { from: 1, to: 1 },
      security_evidence_refs: ["docs/security/m0.md"]
    }, null, 2)}\n`,
    "utf8"
  );

  const sourceSha = "e".repeat(40);
  const processAdapter = new FakeProcessAdapter(flags, sourceSha);

  const s00: StageModule = {
    id: "S00",
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S00",
        status: "verified",
        checks: { bootstrap_receipt_present: true },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return { stageId: "S00", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
    },
    async apply() {
      return [];
    },
    async verify() {
      return [];
    },
    async recover() {
      return [];
    }
  };
  const s01: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: "verified",
        checks: { preflight_ok: true },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return { stageId: "S01", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
    },
    async apply() {
      return [];
    },
    async verify() {
      return [];
    },
    async recover() {
      return [];
    }
  };
  const s06: StageModule = {
    id: "S06",
    dependencies: ["S01"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-readonly"],
    async observe() {
      return {
        stageId: "S06",
        status: "verified",
        checks: { s06_ready: true },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return { stageId: "S06", optional: false, requiredCapabilities: ["runner-readonly"], operations: [], requiredGates: [] };
    },
    async apply() {
      return [];
    },
    async verify() {
      return [];
    },
    async recover() {
      return [];
    }
  };
  const registry = createRegistry([
    s00,
    s01,
    s06,
    createVerificationStage(new NodeFilesystemAdapter(), processAdapter),
    createAuthStage(new NodeFilesystemAdapter(), processAdapter)
  ]);
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter,
      httpAdapter: { get: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("") }) },
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-22T10:00:00.000Z") }
    },
    registry
  );

  return { root, config, configPath, engine, processAdapter };
}

function ctx(config: SetupConfig): StageContext {
  return {
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "a".repeat(64),
    planHash: "b".repeat(64),
    config
  };
}

test("S07 applies offline verification with fake provider and no-secret docker boundary", async () => {
  const { config, processAdapter } = await prepareScenario();
  const stage = createVerificationStage(new NodeFilesystemAdapter(), processAdapter);
  const observed = await stage.observe(ctx(config));
  const plan = stage.plan(config, observed);
  const receipts = await stage.apply(ctx(config), plan);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.checks.runner_ready_offline, true);
  const reportPath = path.join(config.paths.setup_state_dir, "s07-offline-verification.json");
  assert.equal(fs.existsSync(reportPath), true);
});

test("S07 fails on synthetic secret marker leak", async () => {
  const { config, processAdapter } = await prepareScenario({ leakSecret: true });
  const stage = createVerificationStage(new NodeFilesystemAdapter(), processAdapter);
  const observed = await stage.observe(ctx(config));
  const plan = stage.plan(config, observed);
  await assert.rejects(
    async () => stage.apply(ctx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s08_secret_leak_detected"
  );
});

test("S07 cleanup failure returns drift/recovery error", async () => {
  const { config, processAdapter } = await prepareScenario({ dockerCleanupFails: true });
  const stage = createVerificationStage(new NodeFilesystemAdapter(), processAdapter);
  const observed = await stage.observe(ctx(config));
  const plan = stage.plan(config, observed);
  await assert.rejects(
    async () => stage.apply(ctx(config), plan),
    (error) =>
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s07_cleanup_failed"
      && (error as { exitCode?: number }).exitCode === ExitCode.DriftOrRecoveryRequired
  );
});

test("auth status reports presence only and never claims quota health", async () => {
  const { configPath, config, engine } = await prepareScenario();
  await fs.promises.writeFile(path.join(config.paths.application_auth_dir, "token.json"), "{\"token\":\"x\"}\n", "utf8");
  const result = await engine.run("auth-status", { configPath });
  assert.equal(result.exitCode, ExitCode.Success, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data?.authenticated, true);
  assert.equal(result.envelope.data?.quota_healthy, "unknown");
});

test("smoke live requires explicit gate approvals and apply/resume do not auto-login", async () => {
  const { configPath, engine, processAdapter } = await prepareScenario();
  const planResult = await engine.run("plan", { configPath, stageId: "S08" });
  assert.equal(planResult.exitCode, ExitCode.Success, JSON.stringify(planResult.envelope));

  const smoke = await engine.run("smoke", { configPath, provider: "live", fixture: "toy" });
  assert.equal(smoke.exitCode, ExitCode.ManualActionRequired, JSON.stringify(smoke.envelope));

  const resume = await engine.run("resume", { configPath, nonInteractive: true });
  assert.equal(resume.exitCode, ExitCode.ManualActionRequired, JSON.stringify(resume.envelope));
  assert.equal(processAdapter.dockerRunCount, 0);
});
