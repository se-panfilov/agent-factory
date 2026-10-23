import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { type HttpGetOptions, type HttpResponse } from "../../src/adapters/http";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { requestCancel } from "../../src/core/lock";
import { createPreflightStage, type PreflightProbe } from "../../src/stages/preflight";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageOperation } from "../../src/core/types";
import { setupError } from "../../src/core/errors";

class FakeProcessAdapter implements ProcessAdapter {
  constructor(
    private readonly processPid: number,
    private readonly bootIdValue: string,
    private readonly processStart: number,
    private readonly processUid = 1000,
    private readonly processUser = "factory"
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
    return this.processPid;
  }

  uid(): number {
    return this.processUid;
  }

  username(): string {
    return this.processUser;
  }

  async bootId(): Promise<string> {
    return this.bootIdValue;
  }

  async machineIdHash(): Promise<string> {
    return "f".repeat(64);
  }

  async processStartTicks(pid: number): Promise<number | null> {
    if (pid === this.processPid) {
      return this.processStart;
    }
    return null;
  }

  isPidAlive(pid: number): boolean {
    return pid === this.processPid;
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

function makeConfig(root: string, selectedStages: SetupConfig["selected_stages"]): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "3a1169f5-4ff9-4359-a6b2-0b4b06e36df0",
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
    selected_stages: selectedStages,
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
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function makeS00(): StageModule {
  return {
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
}

function makeNoopStage(id: "S01" | "S02" | "S12", dependencies: Array<"S00" | "S01" | "S02">): StageModule {
  return {
    id,
    dependencies,
    supportedProfiles: ["supervised", "service"],
    optional: id === "S12",
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: id,
        status: id === "S12" ? "skipped" : "verified",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: id,
        optional: id === "S12",
        requiredCapabilities: [],
        operations: [],
        requiredGates: []
      };
    },
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
}

test("A01 subprocess lifecycle preserves approvals across process boundaries and cwd changes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-subprocess-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effects", "effect.txt");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const scriptPath = path.join(root, "worker.js");
  const distRoot = path.resolve(__dirname, "../..");
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const { SetupEngine } = require(${JSON.stringify(path.join(distRoot, "src/core/engine.js"))});
const { createRegistry } = require(${JSON.stringify(path.join(distRoot, "src/core/plan.js"))});
const { ExitCode } = require(${JSON.stringify(path.join(distRoot, "src/core/types.js"))});
const { setupError } = require(${JSON.stringify(path.join(distRoot, "src/core/errors.js"))});

class FakeProcessAdapter {
  constructor(pid, bootId, startTicks) {
    this.pidValue = pid;
    this.bootIdValue = bootId;
    this.startTicks = startTicks;
  }
  async runCommand() { return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }; }
  pid() { return this.pidValue; }
  uid() { return 1000; }
  username() { return "factory"; }
  async bootId() { return this.bootIdValue; }
  async machineIdHash() { return "f".repeat(64); }
  async processStartTicks(pid) { return pid === this.pidValue ? this.startTicks : null; }
  isPidAlive(pid) { return pid === this.pidValue; }
}
class FakeHttpAdapter {
  async get() { return { statusCode: 200, headers: {}, body: Buffer.from("") }; }
}

function registry(effectPath) {
  const s00 = {
    id: "S00",
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() { return { stageId: "S00", status: "verified", checks: { bootstrap_receipt_present: true }, versions: {}, observedAt: new Date().toISOString() }; },
    plan() { return { stageId: "S00", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] }; },
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
  const s01 = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      const exists = fs.existsSync(effectPath);
      return { stageId: "S01", status: exists ? "verified" : "planned", checks: { effect_present: exists }, versions: {}, observedAt: new Date().toISOString() };
    },
    plan(_d, observed) {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: [],
        operations: observed.status === "verified" ? [] : [{
          id: "s01-write-effect",
          stageId: "S01",
          kind: "mutate",
          resourceId: "effect",
          risk: "low",
          gateIds: ["s01-manual-gate"],
          preconditions: ["effect_absent"],
          sideEffects: ["write effect file"],
          timeoutSec: 30,
          retryable: false
        }],
        requiredGates: observed.status === "verified" ? [] : ["s01-manual-gate"]
      };
    },
    async apply() {
      if (!fs.existsSync(effectPath)) {
        fs.mkdirSync(path.dirname(effectPath), { recursive: true });
        fs.writeFileSync(effectPath, "1\\n", "utf8");
      }
      return [{ operationId: "s01-write-effect", stageId: "S01", resourceId: "effect", observedAt: new Date().toISOString(), checks: { written: true }, versions: {}, artifacts: [effectPath] }];
    },
    async verify() {
      if (!fs.existsSync(effectPath)) {
        throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "effect_missing", publicMessage: "missing", nextAction: "re-run", stage: "S01" });
      }
      return [{ operationId: "s01-verify-effect", stageId: "S01", resourceId: "effect", observedAt: new Date().toISOString(), checks: { present: true }, versions: {}, artifacts: [effectPath] }];
    },
    async recover() { return this.verify(); }
  };
  return createRegistry([s00, s01]);
}

async function main() {
  const mode = process.argv[2];
  const configPath = process.argv[3];
  const effectPath = process.argv[4];
  const engine = new SetupEngine(
    {
      processAdapter: new FakeProcessAdapter(process.pid, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 1000 + process.pid),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T08:00:00.000Z") }
    },
    registry(effectPath)
  );
  let result;
  if (mode === "plan") {
    result = await engine.run("plan", { configPath, stageId: "S01" });
  } else if (mode === "approve") {
    const planPath = path.join(path.dirname(path.dirname(configPath)), "state", "plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    result = await engine.run("gate-approve", { configPath, gateId: "s01-manual-gate", planHash: plan.plan_hash });
  } else if (mode === "apply") {
    result = await engine.run("apply", { configPath, planPath: path.join(path.dirname(path.dirname(configPath)), "state", "plan.json"), nonInteractive: true });
  } else if (mode === "verify") {
    result = await engine.run("verify", { configPath });
  } else if (mode === "resume") {
    result = await engine.run("resume", { configPath, nonInteractive: true });
  } else {
    throw new Error("unknown mode");
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(2);
});
`;
  await fs.promises.writeFile(scriptPath, script, "utf8");

  const run = (mode: string): { exitCode: number; envelope: { plan_hash?: string | null } } => {
    const cwd = path.join(root, `cwd-${mode}`);
    fs.mkdirSync(cwd, { recursive: true });
    const result = spawnSync(process.execPath, [scriptPath, mode, configPath, effectPath], {
      cwd,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { exitCode: number; envelope: { plan_hash?: string | null } };
  };

  assert.equal(run("plan").exitCode, ExitCode.Success);
  assert.equal(run("approve").exitCode, ExitCode.Success);
  assert.equal(run("apply").exitCode, ExitCode.Success);
  assert.equal(run("verify").exitCode, ExitCode.Success);
  assert.equal(run("resume").exitCode, ExitCode.Success);
  const effect = await fs.promises.readFile(effectPath, "utf8");
  assert.equal(effect.trim(), "1");
});

test("A03 verify does not report success for unsupported host observation", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-verify-unsupported-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);

  const probe: PreflightProbe = {
    async readOnlyHostReport() {
      return {
        osRelease: "unsupported",
        arch: "amd64",
        uid: 0,
        username: "root",
        hasSystemd: false,
        cgroupVersion: "v1",
        freeDiskBytes: 1,
        totalDiskBytes: 1,
        freeInodes: 1,
        cpuCount: 1,
        totalMemBytes: 1
      };
    }
  };
  const registry = createRegistry([makeS00(), createPreflightStage(probe)]);
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1101, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 100),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    registry
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));

  const result = await engine.run("verify", { configPath });
  assert.equal(result.exitCode, ExitCode.UnsupportedHostOrMissingPrivileges, JSON.stringify(result.envelope));
  assert.equal(result.envelope.overall_status, "blocked");
});

test("A05 expired gate cannot be approved and stays expired in persisted state", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-gate-expired-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effects", "gate.txt");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);

  const stage: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: fs.existsSync(effectPath) ? "verified" : "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: [],
        operations: [
          {
            id: "s01-gated-op",
            stageId: "S01",
            kind: "mutate",
            resourceId: "gated",
            risk: "low",
            gateIds: ["s01-gate"],
            preconditions: [],
            sideEffects: ["write marker"],
            timeoutSec: 10,
            retryable: false
          }
        ],
        requiredGates: ["s01-gate"]
      };
    },
    async apply() {
      await fs.promises.mkdir(path.dirname(effectPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(effectPath, "ok\n", "utf8");
      return [];
    },
    async verify() {
      return [];
    },
    async recover(_ctx: StageContext, _operation: StageOperation) {
      return [];
    }
  };
  const registry = createRegistry([makeS00(), stage]);
  const planner = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1201, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 100),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    registry
  );
  const plan = await planner.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const planJson = JSON.parse(await fs.promises.readFile(path.join(config.paths.setup_state_dir, "plan.json"), "utf8")) as { plan_hash: string };

  const approver = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1202, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 101),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:31:00.000Z") }
    },
    registry
  );
  const approve = await approver.run("gate-approve", { configPath, gateId: "s01-gate", planHash: planJson.plan_hash });
  assert.equal(approve.exitCode, ExitCode.ManualActionRequired, JSON.stringify(approve.envelope));
  const persisted = JSON.parse(await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8")) as { pending_gates: Array<{ id: string; status: string }> };
  assert.equal(persisted.pending_gates.some((item) => item.id === "s01-gate" && item.status === "expired"), true);
});

test("A06 stage-only required gate is persisted even without operations", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-stage-only-gate-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);

  const stage: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: ["stage-only-approval"]
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
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1301, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 200),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    createRegistry([makeS00(), stage])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const persisted = JSON.parse(await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8")) as { pending_gates: Array<{ id: string; operation_id: string }> };
  assert.equal(persisted.pending_gates.some((item) => item.id === "stage-only-approval" && item.operation_id === "stage:S01"), true);
});

test("A09 corrupted state remains recovery-required across repeated loads", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-state-corrupt-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{invalid-json", "utf8");

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1401, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 300),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const first = await engine.run("status", { configPath });
  assert.equal(first.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(first.envelope));
  assert.equal(first.envelope.error?.code, "state_corrupt");

  const second = await engine.run("status", { configPath });
  assert.equal(second.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(second.envelope));
  assert.equal(second.envelope.error?.code, "state_corrupt");
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), false);
});

test("A04 optional disabled/skipped stays successful and does not become verified", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-optional-skipped-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S12"]);
  await writeConfig(configPath, config);

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
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return { stageId: "S01", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
    },
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
  const s12: StageModule = {
    id: "S12",
    dependencies: ["S01"],
    supportedProfiles: ["supervised", "service"],
    optional: true,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S12",
        status: "skipped",
        checks: { optional_enabled: false },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: "S12",
        optional: true,
        requiredCapabilities: [],
        operations: [],
        requiredGates: []
      };
    },
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1501, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 400),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    createRegistry([makeS00(), s01, s12])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S12" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const apply = await engine.run("apply", { configPath, planPath: path.join(config.paths.setup_state_dir, "plan.json"), nonInteractive: true });
  assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));
  assert.equal(apply.envelope.stages.some((item) => item.id === "S12" && item.status === "skipped"), true);
});

test("A13 cancel requested in stage A stops before stage B mutation", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-cancel-before-next-stage-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectA = path.join(root, "effects", "a.txt");
  const effectB = path.join(root, "effects", "b.txt");
  const config = makeConfig(root, ["S02"]);
  await writeConfig(configPath, config);

  const s01: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: fs.existsSync(effectA) ? "verified" : "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: [],
        operations: [{
          id: "s01-op",
          stageId: "S01",
          kind: "mutate",
          resourceId: "a",
          risk: "low",
          gateIds: [],
          preconditions: [],
          sideEffects: ["write A and request cancel"],
          timeoutSec: 10,
          retryable: false
        }],
        requiredGates: []
      };
    },
    async apply(ctx: StageContext) {
      await fs.promises.mkdir(path.dirname(effectA), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(effectA, "a\n", "utf8");
      await requestCancel(new NodeFilesystemAdapter(), ctx.config);
      return [{
        operationId: "s01-op",
        stageId: "S01",
        resourceId: "a",
        observedAt: new Date().toISOString(),
        checks: { written: true },
        versions: {},
        artifacts: [effectA]
      }];
    },
    async verify() { return []; },
    async recover() { return []; }
  };
  const s02: StageModule = {
    id: "S02",
    dependencies: ["S01"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S02",
        status: fs.existsSync(effectB) ? "verified" : "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: "S02",
        optional: false,
        requiredCapabilities: [],
        operations: [{
          id: "s02-op",
          stageId: "S02",
          kind: "mutate",
          resourceId: "b",
          risk: "low",
          gateIds: [],
          preconditions: [],
          sideEffects: ["write B"],
          timeoutSec: 10,
          retryable: false
        }],
        requiredGates: []
      };
    },
    async apply() {
      await fs.promises.mkdir(path.dirname(effectB), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(effectB, "b\n", "utf8");
      return [{
        operationId: "s02-op",
        stageId: "S02",
        resourceId: "b",
        observedAt: new Date().toISOString(),
        checks: { written: true },
        versions: {},
        artifacts: [effectB]
      }];
    },
    async verify() { return []; },
    async recover() { return []; }
  };
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1601, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 500),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    createRegistry([makeS00(), s01, s02])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S02" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const apply = await engine.run("apply", {
    configPath,
    planPath: path.join(config.paths.setup_state_dir, "plan.json"),
    nonInteractive: true
  });
  assert.equal(apply.exitCode, ExitCode.SigIntCleanupConfirmed, JSON.stringify(apply.envelope));
  assert.equal(fs.existsSync(effectA), true);
  assert.equal(fs.existsSync(effectB), false);
});

test("A14 update and restore public entrypoints stay explicitly blocked", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-public-blockers-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new FakeProcessAdapter(1701, "f324dcd7-4035-4430-ab39-ce31f9e396bf", 600),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T10:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));

  const updatePlan = await engine.run("update-plan", { configPath });
  assert.equal(updatePlan.exitCode, ExitCode.BlockedByMissingCapabilityOrEvidence, JSON.stringify(updatePlan.envelope));
  assert.equal(updatePlan.envelope.manual_actions.some((action) => action.includes("generic")), false);

  const updateApply = await engine.run("update-apply", { configPath });
  assert.equal(updateApply.exitCode, ExitCode.BlockedByMissingCapabilityOrEvidence, JSON.stringify(updateApply.envelope));
  assert.equal(updateApply.envelope.manual_actions.some((action) => action.includes("generic")), false);

  const restore = await engine.run("restore", { configPath });
  assert.equal(restore.exitCode, ExitCode.BlockedByMissingCapabilityOrEvidence, JSON.stringify(restore.envelope));
});

test("A15 CLI parse errors return sanitized JSON envelope with exit 2", () => {
  const distRoot = path.resolve(__dirname, "../..");
  const cliPath = path.join(distRoot, "src/cli.js");
  const cases: Array<{ args: string[]; expectedMessage: string }> = [
    {
      args: ["unknown-command"],
      expectedMessage: "Unknown command 'unknown-command'."
    },
    {
      args: ["plan", "--config", "/tmp/a", "--config", "/tmp/b"],
      expectedMessage: "Duplicate option '--config'."
    },
    {
      args: ["plan", "--config"],
      expectedMessage: "Missing value for '--config'."
    },
    {
      args: ["smoke", "--config", "/tmp/a", "--provider", "broken", "--fixture", "toy"],
      expectedMessage: "smoke requires --provider fake|live."
    }
  ];

  for (const item of cases) {
    const result = spawnSync(process.execPath, [cliPath, ...item.args], {
      encoding: "utf8"
    });
    assert.equal(result.status, ExitCode.CliOrSchemaError, `${item.args.join(" ")}\n${result.stderr}`);
    const envelope = JSON.parse(result.stdout) as {
      overall_status: string;
      error: { code: string; public_message: string };
    };
    assert.equal(envelope.overall_status, "failed");
    assert.equal(envelope.error.code, "cli_parse_error");
    assert.equal(envelope.error.public_message, item.expectedMessage);
    assert.equal(result.stdout.includes("Error:"), false);
  }
});
