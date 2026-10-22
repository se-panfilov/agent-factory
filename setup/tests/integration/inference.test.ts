import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { ExitCode, type SetupConfig, type StagePlan } from "../../src/core/types";
import { createInferenceStage, runInferenceDisable, type InferenceAdapter } from "../../src/stages/inference";

class FakeProcessAdapter implements ProcessAdapter {
  public commands: Array<{ binary: string; args: string[] }> = [];

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    this.commands.push({ binary: options.binary, args: options.args });
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

class FakeInferenceAdapter implements InferenceAdapter {
  constructor(
    private runtime: { dockerAvailable: boolean; running: boolean; publicPortsDetected: boolean },
    private resources: { ramAvailableBytes: number; diskAvailableBytes: number; diskAvailableInodes: number }
  ) {}

  staged = 0;
  stopped = 0;

  async observeRuntime(): Promise<{ dockerAvailable: boolean; running: boolean; publicPortsDetected: boolean }> {
    return this.runtime;
  }

  async observeResources(): Promise<{ ramAvailableBytes: number; diskAvailableBytes: number; diskAvailableInodes: number }> {
    return this.resources;
  }

  async stageModelAndStartServing(): Promise<void> {
    this.staged += 1;
    this.runtime = { ...this.runtime, running: true, publicPortsDetected: false };
  }

  async stopServing(): Promise<{ stopped: boolean }> {
    this.stopped += 1;
    this.runtime = { ...this.runtime, running: false };
    return { stopped: true };
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
    selected_stages: ["S12"],
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
      inference: true,
      platforms: false
    }
  };
}

async function writePins(config: SetupConfig): Promise<void> {
  const payload = {
    schema_version: 1,
    image: {
      ref: `docker.io/ollama/ollama@sha256:${"c".repeat(64)}`,
      digest: `sha256:${"c".repeat(64)}`,
      arch: "amd64"
    },
    model: {
      id: "qwen2.5-coder:7b-instruct-q4_K_M",
      digest: `sha256:${"d".repeat(64)}`,
      size_bytes: 6 * 1024 * 1024 * 1024,
      license: "apache-2.0",
      num_ctx: 8192
    },
    resources: {
      min_ram_bytes: 16 * 1024 * 1024 * 1024,
      min_disk_bytes: 10 * 1024 * 1024 * 1024,
      min_disk_inodes: 1024
    },
    runtime: {
      service_name: "agent-factory-ollama",
      volume_name: "agent-factory-ollama-models",
      model_dir: "/root/.ollama",
      health_endpoint: "http://127.0.0.1:11434",
      compose_relative_path: "compose/inference.yaml"
    }
  };
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s12-inference-pins.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

async function writeS08Evidence(config: SetupConfig): Promise<void> {
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s08-live-smoke.json"),
    `${JSON.stringify({
      schema_version: 1,
      provider: "live",
      fixture: "toy",
      status: "needs_review",
      source_sha: "f".repeat(40),
      consumed_count: 1,
      unknown_usage: false,
      observed_at: "2026-10-22T12:00:00.000Z",
      run_id: "run-1",
      terminal_events: ["runner.started", "runner.needs_review"]
    }, null, 2)}\n`,
    "utf8"
  );
}

function applyPlan(): StagePlan {
  return {
    stageId: "S12",
    optional: true,
    requiredCapabilities: [],
    operations: [
      {
        id: "s12-op",
        stageId: "S12",
        kind: "mutate",
        resourceId: "s12-ollama-private-serving",
        risk: "high",
        gateIds: ["s12-inference-apply-approved"],
        preconditions: [],
        sideEffects: [],
        timeoutSec: 1800,
        retryable: false
      }
    ],
    requiredGates: ["s12-inference-apply-approved"]
  };
}

test("S12 apply/verify writes private inference artifacts and keeps routing blocked without PR13-17 evidence", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p12-inference-success-"));
  const config = makeConfig(root);
  await writePins(config);
  await writeS08Evidence(config);

  const fakeAdapter = new FakeInferenceAdapter(
    { dockerAvailable: true, running: false, publicPortsDetected: false },
    {
      ramAvailableBytes: 18 * 1024 * 1024 * 1024,
      diskAvailableBytes: 20 * 1024 * 1024 * 1024,
      diskAvailableInodes: 10_000
    }
  );
  const stage = createInferenceStage(new NodeFilesystemAdapter(), new FakeProcessAdapter(), fakeAdapter);
  const observed = await stage.observe({
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "h",
    planHash: "p"
  });
  const planned = stage.plan(config, observed);
  const receipts = await stage.apply({
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "h",
    planHash: "p"
  }, applyPlan());
  assert.equal(receipts.length, 1);
  assert.equal(fakeAdapter.staged, 1);

  const health = JSON.parse(await fs.promises.readFile(path.join(config.paths.setup_state_dir, "s12-inference-health.json"), "utf8")) as { routing_enabled: boolean };
  assert.equal(health.routing_enabled, false);
  assert.equal(planned.optional, true);

  const verifyReceipts = await stage.verify({
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "h",
    planHash: "p"
  });
  assert.equal(verifyReceipts.length, 1);
});

test("S12 apply fails with exit 10 on insufficient RAM for default profile", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p12-inference-ram-"));
  const config = makeConfig(root);
  await writePins(config);
  await writeS08Evidence(config);

  const fakeAdapter = new FakeInferenceAdapter(
    { dockerAvailable: true, running: false, publicPortsDetected: false },
    {
      ramAvailableBytes: 8 * 1024 * 1024 * 1024,
      diskAvailableBytes: 20 * 1024 * 1024 * 1024,
      diskAvailableInodes: 20_000
    }
  );
  const stage = createInferenceStage(new NodeFilesystemAdapter(), new FakeProcessAdapter(), fakeAdapter);
  const observed = await stage.observe({
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "h",
    planHash: "p"
  });
  stage.plan(config, observed);

  await assert.rejects(
    async () => stage.apply({
      installationId: config.installation_id,
      contractVersion: "1.0.0",
      profile: config.profile,
      desiredHash: "h",
      planHash: "p"
    }, applyPlan()),
    (error) => error instanceof Error && "exitCode" in error && (error as { exitCode?: number }).exitCode === ExitCode.OptionalRequestedStageFailed
  );
});

test("S12 disable is idempotent and preserves model volume state", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p12-inference-disable-"));
  const config = makeConfig(root);
  await writePins(config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s12-inference-state.json"),
    `${JSON.stringify({
      schema_version: 1,
      enabled: true,
      disabled: false,
      compose_path: path.join(config.paths.setup_state_dir, "compose", "inference.yaml"),
      service_name: "agent-factory-ollama",
      volume_name: "agent-factory-ollama-models",
      updated_at: "2026-10-22T10:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const fakeAdapter = new FakeInferenceAdapter(
    { dockerAvailable: true, running: true, publicPortsDetected: false },
    { ramAvailableBytes: 18, diskAvailableBytes: 18, diskAvailableInodes: 18 }
  );
  const processAdapter = new FakeProcessAdapter();
  const first = await runInferenceDisable(new NodeFilesystemAdapter(), processAdapter, config, fakeAdapter);
  assert.equal(first.stopped, true);
  assert.equal(first.alreadyDisabled, false);
  assert.equal(fakeAdapter.stopped, 1);

  const second = await runInferenceDisable(new NodeFilesystemAdapter(), processAdapter, config, fakeAdapter);
  assert.equal(second.alreadyDisabled, true);
  assert.equal(fakeAdapter.stopped, 1);
});

test("S12 verify fails when health model digest drifts", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p12-inference-drift-"));
  const config = makeConfig(root);
  await writePins(config);
  await writeS08Evidence(config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s12-inference-health.json"),
    `${JSON.stringify({
      schema_version: 1,
      observed_at: "2026-10-22T10:00:00.000Z",
      model_id: "qwen2.5-coder:7b-instruct-q4_K_M",
      model_digest: `sha256:${"e".repeat(64)}`,
      model_size_bytes: 6 * 1024 * 1024 * 1024,
      model_license: "apache-2.0",
      model_num_ctx: 8192,
      image_ref: `docker.io/ollama/ollama@sha256:${"c".repeat(64)}`,
      image_digest: `sha256:${"c".repeat(64)}`,
      isolation_proof_ref: path.join(config.paths.setup_state_dir, "s08-live-smoke.json"),
      no_public_ports: true,
      health_ok: true,
      routing_enabled: false
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s12-inference-state.json"),
    `${JSON.stringify({
      schema_version: 1,
      enabled: true,
      disabled: false,
      compose_path: path.join(config.paths.setup_state_dir, "compose", "inference.yaml"),
      service_name: "agent-factory-ollama",
      volume_name: "agent-factory-ollama-models",
      updated_at: "2026-10-22T10:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const stage = createInferenceStage(
    new NodeFilesystemAdapter(),
    new FakeProcessAdapter(),
    new FakeInferenceAdapter(
      { dockerAvailable: true, running: true, publicPortsDetected: false },
      { ramAvailableBytes: 18, diskAvailableBytes: 18, diskAvailableInodes: 18 }
    )
  );
  stage.plan(config, {
    stageId: "S12",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: "2026-10-22T10:00:00.000Z"
  });

  await assert.rejects(
    async () => stage.verify({
      installationId: config.installation_id,
      contractVersion: "1.0.0",
      profile: config.profile,
      desiredHash: "h",
      planHash: "p"
    }),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s12_model_identity_drifted"
  );
});
