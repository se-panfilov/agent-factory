import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult } from "../../src/adapters/process";
import { type HttpGetOptions, type HttpResponse } from "../../src/adapters/http";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageOperation } from "../../src/core/types";
import { setupError } from "../../src/core/errors";

class FakeProcessAdapter {
  constructor(
    private readonly currentPid: number,
    private readonly currentBoot: string,
    private readonly currentStartTicks: number
  ) {}

  async runCommand(_options: CommandOptions): Promise<CommandResult> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1
    };
  }
  pid(): number {
    return this.currentPid;
  }
  uid(): number {
    return 1000;
  }
  username(): string {
    return "factory";
  }
  async bootId(): Promise<string> {
    return this.currentBoot;
  }
  async machineIdHash(): Promise<string> {
    return "1".repeat(64);
  }
  async processStartTicks(pid: number): Promise<number | null> {
    if (pid === this.currentPid) {
      return this.currentStartTicks;
    }
    return null;
  }
  isPidAlive(pid: number): boolean {
    return pid === this.currentPid;
  }
}

class FakeHttpAdapter {
  async get(_options: HttpGetOptions): Promise<HttpResponse> {
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from("")
    };
  }
}

function makeConfig(root: string): SetupConfig {
  const stateDir = path.join(root, "state");
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "0f71966d-ef6f-4976-97cb-eb34cb139204",
    profile: "supervised",
    host: {
      os: "ubuntu-24.04",
      arch: "amd64",
      expected_user: "factory"
    },
    paths: {
      setup_state_dir: stateDir,
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
    selected_stages: ["S01"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(root, "auth")
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

function buildRegistry(effectPath: string): StageModule[] {
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
      return {
        stageId: "S00",
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

  const s01: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-readonly"],
    async observe() {
      const exists = fs.existsSync(effectPath);
      return {
        stageId: "S01",
        status: exists ? "verified" : "planned",
        checks: { effect_present: exists },
        versions: { runner: "fixture" },
        observedAt: new Date().toISOString()
      };
    },
    plan(_desired, observed) {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: ["runner-readonly"],
        operations: observed.status === "verified"
          ? []
          : [
              {
                id: "s01-create-effect",
                stageId: "S01",
                kind: "mutate",
                resourceId: "fixture-effect",
                risk: "low",
                gateIds: [],
                preconditions: ["effect_absent"],
                sideEffects: ["write effect file"],
                timeoutSec: 10,
                retryable: false
              }
            ],
        requiredGates: []
      };
    },
    async apply() {
      await fs.promises.mkdir(path.dirname(effectPath), { recursive: true });
      await fs.promises.writeFile(effectPath, "ok\n", "utf8");
      return [
        {
          operationId: "s01-create-effect",
          stageId: "S01",
          resourceId: "fixture-effect",
          observedAt: new Date().toISOString(),
          checks: { written: true },
          versions: { runner: "fixture" },
          artifacts: [effectPath]
        }
      ];
    },
    async verify() {
      if (!fs.existsSync(effectPath)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "effect_missing",
          publicMessage: "Effect file is missing.",
          nextAction: "Run plan/apply again after inspection.",
          stage: "S01"
        });
      }
      return [
        {
          operationId: "s01-verify-effect",
          stageId: "S01",
          resourceId: "fixture-effect",
          observedAt: new Date().toISOString(),
          checks: { present: true },
          versions: { runner: "fixture" },
          artifacts: [effectPath]
        }
      ];
    },
    async recover(_ctx: StageContext, _interruptedOperation: StageOperation) {
      return this.verify({
        installationId: "fixture",
        contractVersion: "1.0.0",
        profile: "supervised",
        desiredHash: "fixture",
        planHash: "fixture"
      });
    }
  };

  return [s00, s01];
}

test("plan/apply/resume flow writes intent+receipt and remains idempotent", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p02-core-success-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effects", "s01.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter: new FakeProcessAdapter(3210, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 777),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-21T20:00:00Z") }
    },
    createRegistry(buildRegistry(effectPath))
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const planPath = path.join(config.paths.setup_state_dir, "plan.json");

  const apply = await engine.run("apply", { configPath, planPath, nonInteractive: true });
  assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));
  assert.equal(fs.existsSync(effectPath), true);

  const eventsPath = path.join(config.paths.setup_state_dir, "events.jsonl");
  const events = await fs.promises.readFile(eventsPath, "utf8");
  assert.match(events, /"code":"intent"/);
  assert.match(events, /"code":"receipt"/);

  const resume = await engine.run("resume", { configPath, nonInteractive: true });
  assert.equal(resume.exitCode, ExitCode.Success, JSON.stringify(resume.envelope));
});

test("apply returns exit 7 on duplicate invocation lock", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p02-core-lock-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effects", "s01.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  await fs.promises.mkdir(lockDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify(
      {
        boot_id: "f324dcd7-4035-4430-ab39-ce31f9e396bf",
        pid: 6000,
        process_start_ticks: 888,
        nonce: "nonce",
        installation_id: config.installation_id,
        created_at: "2026-10-21T20:00:00Z"
      },
      null,
      2
    ),
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(6000, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 888),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-21T20:00:00Z") }
    },
    createRegistry(buildRegistry(effectPath))
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const result = await engine.run("apply", {
    configPath,
    planPath: path.join(config.paths.setup_state_dir, "plan.json"),
    nonInteractive: true
  });
  assert.equal(result.exitCode, ExitCode.LockOwnedByAnotherInstaller);
});

test("recover --lock-only quarantines stale lock and stale plan is rejected", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p02-core-recover-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effects", "s01.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  await fs.promises.mkdir(lockDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify(
      {
        boot_id: "7fd14fd8-b3f2-41a1-a4bc-49f06df7fd11",
        pid: 9999,
        process_start_ticks: 1,
        nonce: "nonce",
        installation_id: config.installation_id,
        created_at: "2026-10-21T20:00:00Z"
      },
      null,
      2
    ),
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1234, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 555),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-21T20:00:00Z") }
    },
    createRegistry(buildRegistry(effectPath))
  );
  const recovered = await engine.run("recover", { configPath, lockOnly: true });
  assert.equal(recovered.exitCode, ExitCode.Success, JSON.stringify(recovered.envelope));
  const lockEntries = await fs.promises.readdir(config.paths.setup_state_dir);
  assert.equal(lockEntries.some((name) => name.startsWith("lock.quarantine-")), true);

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));

  const configChanged = makeConfig(root);
  configChanged.optional_features.platforms = true;
  await writeConfig(configPath, configChanged);

  const apply = await engine.run("apply", {
    configPath,
    planPath: path.join(config.paths.setup_state_dir, "plan.json"),
    nonInteractive: true
  });
  assert.equal(apply.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(apply.envelope));
});
