import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type HttpAdapter, type HttpGetOptions, type HttpResponse } from "../../src/adapters/http";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { ExitCode, type JsonEnvelope, type SetupConfig, type StageContext, type StageModule } from "../../src/core/types";
import { createConfigurationStage } from "../../src/stages/configuration";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = `sha256:${"1".repeat(64)}`;

class FakeProcessAdapter implements ProcessAdapter {
  public buildCalls = 0;

  constructor(
    private readonly codexBinaryPath: string,
    private readonly codexVersion: string,
    private readonly expectedDigest: string,
    private readonly machineHash: string,
    private readonly loginHelpOk = true
  ) {}

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    if (options.binary === this.codexBinaryPath) {
      if (options.args[0] === "--version") {
        return this.ok(`${this.codexVersion}\n`);
      }
      if (options.args[0] === "exec" && options.args[1] === "--help") {
        return this.ok("Usage: codex exec\n");
      }
      if (options.args[0] === "login" && options.args[1] === "--help") {
        return this.loginHelpOk ? this.ok("Usage: codex login\n") : this.fail("login help failed");
      }
      return this.fail("unsupported codex args");
    }

    if (options.binary === "/usr/bin/git") {
      return this.ok("");
    }

    if (options.binary === "/usr/bin/docker") {
      if (options.args[0] === "build") {
        this.buildCalls += 1;
        return this.ok("build ok");
      }
      if (
        options.args[0] === "image"
        && options.args[1] === "inspect"
        && options.args[2] === "--format"
        && options.args[3] === "{{join .RepoDigests \",\"}}"
      ) {
        return this.ok(`local/agent@${this.expectedDigest}\n`);
      }
      if (
        options.args[0] === "image"
        && options.args[1] === "inspect"
        && options.args[2] === "--format"
        && options.args[3] === "{{.Id}}"
      ) {
        return this.ok(`${IMAGE_ID}\n`);
      }
      return this.fail(`unsupported docker command: ${options.args.join(" ")}`);
    }

    return this.fail(`unsupported binary: ${options.binary}`);
  }

  pid(): number {
    return 4000;
  }
  uid(): number {
    return 1000;
  }
  username(): string {
    return "factory";
  }
  async bootId(): Promise<string> {
    return "f324dcd7-4035-4430-ab39-ce31f9e396bf";
  }
  async machineIdHash(): Promise<string> {
    return this.machineHash;
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

class TestHttpAdapter implements HttpAdapter {
  async get(_options: HttpGetOptions): Promise<HttpResponse> {
    throw new Error("network access is not expected in this test");
  }
}

function makeConfig(root: string): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "797fa484-91fe-4852-8a57-7d7dd84e2fa3",
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
      application_state_dir: path.join(root, "app-state"),
      application_auth_dir: path.join(root, "app-auth"),
      application_work_dir: path.join(root, "work")
    },
    release: {
      archive_path: path.join(root, "release.tar.xz"),
      sha256: "c".repeat(64),
      source_commit: "d".repeat(40)
    },
    version_lock_path: path.join(root, "versions.lock.json"),
    selected_stages: ["S06"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(root, "app-auth")
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

function ctx(config: SetupConfig): StageContext {
  return {
    installationId: "797fa484-91fe-4852-8a57-7d7dd84e2fa3",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "e".repeat(64),
    planHash: "f".repeat(64),
    config
  };
}

async function writeVersionLock(config: SetupConfig, codexVersion = "0.32.0"): Promise<void> {
  const lock = {
    schema_version: 1,
    contract_version: "1.0.0",
    installer: {
      version: "0.0.1"
    },
    node: {
      version: "24.19.0",
      source_url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
      sha256: "1".repeat(64)
    },
    npm: {
      version: "11.0.0"
    },
    docker: {
      ce: "5:28.3.0-1~ubuntu.24.04~noble",
      cli: "5:28.3.0-1~ubuntu.24.04~noble",
      containerd: "1.7.27-1",
      buildx: "0.20.1-1~ubuntu.24.04~noble",
      compose: "2.36.2-1~ubuntu.24.04~noble"
    },
    tailscale: {
      version: "1.82.5"
    },
    codex: {
      package: "@openai/codex",
      version: codexVersion,
      integrity: "sha512-example"
    },
    images: {
      base_image_platform_digest: DIGEST_A,
      agent_image_digest: DIGEST_B
    },
    sources: {
      trusted_fingerprints: ["test"],
      official_urls: ["https://nodejs.org/dist/v24.19.0/"]
    },
    qualification: {
      report_refs: ["setup/docs/qualification/P15-amd64.md"]
    }
  };
  await fs.promises.mkdir(path.dirname(config.version_lock_path), { recursive: true });
  await fs.promises.writeFile(config.version_lock_path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function prepareRoot(): Promise<{ root: string; config: SetupConfig; codexPath: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p07-config-images-"));
  const config = makeConfig(root);
  const codexPath = path.join(config.paths.setup_bin_dir, "codex");
  await fs.promises.mkdir(config.paths.setup_bin_dir, { recursive: true });
  await fs.promises.writeFile(codexPath, "#!/bin/sh\necho codex\n", { mode: 0o700 });
  await fs.promises.mkdir(config.paths.application_dir, { recursive: true });
  await fs.promises.mkdir(config.paths.application_work_dir, { recursive: true });
  await writeVersionLock(config);
  return { root, config, codexPath };
}

async function writeConfig(configPath: string, config: SetupConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function makeNoopDependencyStage(id: "S05"): StageModule {
  return {
    id,
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: id,
        status: "verified",
        checks: { noop: true },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: id,
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: []
      };
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
}

async function approveRequiredGates(
  engine: SetupEngine,
  configPath: string,
  planResult: { envelope: JsonEnvelope; exitCode: number }
): Promise<void> {
  assert.equal(typeof planResult.envelope.plan_hash, "string");
  const approvals = Array.isArray(planResult.envelope.data?.required_approvals)
    ? planResult.envelope.data.required_approvals as Array<{ id: string }>
    : [];
  for (const approval of approvals) {
    const approve = await engine.run("gate-approve", {
      configPath,
      gateId: approval.id,
      planHash: planResult.envelope.plan_hash as string
    });
    assert.equal(approve.exitCode, ExitCode.Success, JSON.stringify(approve.envelope));
  }
}

test("S06 applies canonical config/image and is idempotent on second run", async () => {
  const { config, codexPath } = await prepareRoot();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
  const stage = createConfigurationStage(new NodeFilesystemAdapter(), processAdapter);

  const observed = await stage.observe(ctx(config));
  const plan = stage.plan(config, observed);
  const receipt = await stage.apply(ctx(config), plan);
  assert.equal(receipt.length, 1);
  assert.equal(processAdapter.buildCalls, 1);
  const imageStatePath = path.join(config.paths.setup_state_dir, "s06-agent-image.json");
  const imageState = JSON.parse(await fs.promises.readFile(imageStatePath, "utf8")) as { codex_version?: unknown };
  assert.equal(imageState.codex_version, "0.32.0");

  const authMode = (await fs.promises.stat(config.paths.application_auth_dir)).mode & 0o777;
  const stateMode = (await fs.promises.stat(config.paths.application_state_dir)).mode & 0o777;
  const policyMode = (await fs.promises.stat(path.join(config.paths.application_dir, "policy-level1.json"))).mode & 0o777;
  assert.equal(authMode, 0o700);
  assert.equal(stateMode, 0o700);
  assert.equal(policyMode, 0o600);

  await stage.apply(ctx(config), plan);
  assert.equal(processAdapter.buildCalls, 1);
  const after = await stage.observe(ctx(config));
  assert.equal(after.status, "verified", JSON.stringify(after.checks));
});

test("S06 writes .proposed and blocks when user modified policy", async () => {
  const { config, codexPath } = await prepareRoot();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
  const stage = createConfigurationStage(new NodeFilesystemAdapter(), processAdapter);
  const policyPath = path.join(config.paths.application_dir, "policy-level1.json");
  await fs.promises.writeFile(
    policyPath,
    `${JSON.stringify({
      schema_version: 1,
      profile: "supervised",
      network_mode: "cloud-only",
      resource_profile: "standard",
      limits: {
        daily_budget: "daily3",
        run_timeout_sec: 300
      },
      providers: [{ id: "codex-cloud", package: "@openai/codex", enabled: true }],
      roles: { scout: { provider: "codex-cloud", max_parallelism: 1 } }
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const plan = stage.plan(config, await stage.observe(ctx(config)));
  await assert.rejects(
    async () => stage.apply(ctx(config), plan),
    (error) => error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s06_policy_modified_requires_gate"
      && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
  );
  assert.equal(fs.existsSync(`${policyPath}.proposed`), true);
  assert.equal(fs.existsSync(`${policyPath}.proposed.diff`), true);
});

test("K08 real S06 verified lifecycle executes fresh no-op apply/status/resume", async () => {
  const { root, config, codexPath } = await prepareRoot();
  const configPath = path.join(root, "config", "setup.json");
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "1".repeat(64));
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new TestHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:00:00.000Z") }
    },
    createRegistry([makeNoopDependencyStage("S05"), createConfigurationStage(fsAdapter, processAdapter)])
  );

  const plan1 = await engine.run("plan", { configPath, stageId: "S06" });
  assert.equal(plan1.exitCode, ExitCode.Success, JSON.stringify(plan1.envelope));
  await approveRequiredGates(engine, configPath, plan1);
  const apply1 = await engine.run("apply", {
    configPath,
    planPath: plan1.envelope.data?.plan_path as string,
    nonInteractive: true
  });
  assert.equal(apply1.exitCode, ExitCode.Success, JSON.stringify(apply1.envelope));
  assert.equal(processAdapter.buildCalls, 1);

  const status1 = await engine.run("status", { configPath });
  assert.equal(status1.exitCode, ExitCode.Success, JSON.stringify(status1.envelope));
  const resume1 = await engine.run("resume", { configPath });
  assert.equal(resume1.exitCode, ExitCode.Success, JSON.stringify(resume1.envelope));

  const plan2 = await engine.run("plan", { configPath, stageId: "S06" });
  assert.equal(plan2.exitCode, ExitCode.Success, JSON.stringify(plan2.envelope));
  await approveRequiredGates(engine, configPath, plan2);
  const plan2File = plan2.envelope.data?.plan_path as string;
  const plan2Json = JSON.parse(await fs.promises.readFile(plan2File, "utf8")) as {
    stages: Array<{ stage_id: string; operations: unknown[] }>;
  };
  const s06Plan = plan2Json.stages.find((entry) => entry.stage_id === "S06");
  assert.ok(s06Plan !== undefined);
  assert.equal(s06Plan.operations.length, 0);

  const apply2 = await engine.run("apply", {
    configPath,
    planPath: plan2File,
    nonInteractive: true
  });
  assert.equal(apply2.exitCode, ExitCode.Success, JSON.stringify(apply2.envelope));
  assert.equal(processAdapter.buildCalls, 1);

  const status2 = await engine.run("status", { configPath });
  assert.equal(status2.exitCode, ExitCode.Success, JSON.stringify(status2.envelope));
  const resume2 = await engine.run("resume", { configPath });
  assert.equal(resume2.exitCode, ExitCode.Success, JSON.stringify(resume2.envelope));
});

test("S06 fails closed on unknown policy fields", async () => {
  const { config, codexPath } = await prepareRoot();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
  const stage = createConfigurationStage(new NodeFilesystemAdapter(), processAdapter);
  const policyPath = path.join(config.paths.application_dir, "policy-level1.json");
  await fs.promises.writeFile(
    policyPath,
    `${JSON.stringify({
      schema_version: 1,
      profile: "supervised",
      network_mode: "cloud-only",
      resource_profile: "daily3",
      limits: {
        daily_budget: "daily3",
        run_timeout_sec: 300
      },
      providers: [{ id: "codex-cloud", package: "@openai/codex", enabled: true }],
      roles: { scout: { provider: "codex-cloud", max_parallelism: 1 } },
      extra_field: true
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const plan = stage.plan(config, await stage.observe(ctx(config)));
  await assert.rejects(
    async () => stage.apply(ctx(config), plan),
    (error) => error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s06_policy_unknown_fields"
  );
});

test("S06 treats image state from another machine as invalid and rebuilds", async () => {
  const { config, codexPath } = await prepareRoot();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-local");
  const stage = createConfigurationStage(new NodeFilesystemAdapter(), processAdapter);
  const imageStatePath = path.join(config.paths.setup_state_dir, "s06-agent-image.json");
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
  await fs.promises.writeFile(
    imageStatePath,
    `${JSON.stringify({
      schema_version: 1,
      machine_id_hash: "machine-remote",
      image_digest: DIGEST_B,
      image_id: IMAGE_ID,
      build_context_hash: "bad-hash",
      codex_version: "0.32.0",
      base_image_digest: DIGEST_A,
      built_at: "2026-10-22T00:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const plan = stage.plan(config, await stage.observe(ctx(config)));
  await stage.apply(ctx(config), plan);
  assert.equal(processAdapter.buildCalls, 1);
});

test("S06 blocks when codex login help probe fails", async () => {
  const { config, codexPath } = await prepareRoot();
  const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A", false);
  const stage = createConfigurationStage(new NodeFilesystemAdapter(), processAdapter);
  const plan = stage.plan(config, await stage.observe(ctx(config)));
  await assert.rejects(
    async () => stage.apply(ctx(config), plan),
    (error) => error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s06_codex_probe_failed"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
  );
});
