const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const mode = process.argv[2];
if (mode !== "baseline" && mode !== "fixed") {
  process.stderr.write("Usage: node probe-r11-matrix.cjs <baseline|fixed>\n");
  process.exit(2);
}

const repoRoot = process.cwd();
const modulePath = (...segments) => path.join(repoRoot, ...segments);

const { SetupEngine } = require(modulePath("setup", "dist", "src", "core", "engine.js"));
const { createRegistry } = require(modulePath("setup", "dist", "src", "core", "plan.js"));
const { NodeFilesystemAdapter } = require(modulePath("setup", "dist", "src", "adapters", "filesystem.js"));
const { initState, saveState, appendEvent } = require(modulePath("setup", "dist", "src", "core", "state.js"));
const { createPreflightStage } = require(modulePath("setup", "dist", "src", "stages", "preflight.js"));
const { createSystemStage } = require(modulePath("setup", "dist", "src", "stages", "system.js"));

class ProcessAdapter {
  constructor(pid = 3001) {
    this._pid = pid;
  }
  async runCommand() {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
  }
  pid() { return this._pid; }
  uid() { return 1000; }
  username() { return "factory"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "1".repeat(64); }
  async processStartTicks() { return 100; }
  isPidAlive(pid) { return pid === this._pid; }
}

class HttpAdapter {
  async get() {
    return { statusCode: 200, headers: {}, body: Buffer.from("") };
  }
}

class FaultFilesystemAdapter {
  constructor(rules = []) {
    this.delegate = new NodeFilesystemAdapter();
    this.rules = rules;
    this.callCounts = new Map();
    this.triggered = 0;
  }

  setRules(rules) {
    this.rules = rules;
    this.callCounts.clear();
    this.triggered = 0;
  }

  getTriggered() {
    return this.triggered;
  }

  track(method, targetPath) {
    const next = (this.callCounts.get(method) ?? 0) + 1;
    this.callCounts.set(method, next);
    const rule = this.rules.find((item) =>
      item.method === method
      && item.atCall === next
      && (item.pathIncludes === undefined || targetPath.includes(item.pathIncludes))
    );
    if (rule !== undefined) {
      this.triggered += 1;
      const error = new Error(`${method} injected failure`);
      error.code = rule.code;
      throw error;
    }
  }

  async readText(filePath) {
    this.track("readText", filePath);
    return this.delegate.readText(filePath);
  }

  async readTextBounded(filePath, maxBytes) {
    this.track("readTextBounded", filePath);
    if (typeof this.delegate.readTextBounded === "function") {
      return this.delegate.readTextBounded(filePath, maxBytes);
    }
    const text = await this.delegate.readText(filePath);
    const bytesRead = Buffer.byteLength(text, "utf8");
    return {
      text: bytesRead > maxBytes ? text.slice(0, maxBytes) : text,
      bytesRead,
      truncated: bytesRead > maxBytes
    };
  }

  async writeText(filePath, content, modeBits) {
    this.track("writeText", filePath);
    return this.delegate.writeText(filePath, content, modeBits);
  }

  async appendText(filePath, content) {
    this.track("appendText", filePath);
    return this.delegate.appendText(filePath, content);
  }

  async exists(filePath) {
    this.track("exists", filePath);
    return this.delegate.exists(filePath);
  }

  async mkdir(dirPath, options) {
    this.track("mkdir", dirPath);
    return this.delegate.mkdir(dirPath, options);
  }

  async rename(oldPath, newPath) {
    this.track("rename", `${oldPath}->${newPath}`);
    return this.delegate.rename(oldPath, newPath);
  }

  async remove(targetPath, options) {
    this.track("remove", targetPath);
    return this.delegate.remove(targetPath, options);
  }

  lstat(targetPath) {
    this.track("lstat", targetPath);
    return this.delegate.lstat(targetPath);
  }

  stat(targetPath) {
    this.track("stat", targetPath);
    return this.delegate.stat(targetPath);
  }

  async readdir(targetPath) {
    this.track("readdir", targetPath);
    return this.delegate.readdir(targetPath);
  }

  async realpath(targetPath) {
    this.track("realpath", targetPath);
    return this.delegate.realpath(targetPath);
  }

  async fsyncFile(filePath) {
    this.track("fsyncFile", filePath);
    return this.delegate.fsyncFile(filePath);
  }

  async fsyncDir(dirPath) {
    this.track("fsyncDir", dirPath);
    return this.delegate.fsyncDir(dirPath);
  }

  async ensureParentDir(filePath) {
    this.track("ensureParentDir", filePath);
    return this.delegate.ensureParentDir(filePath);
  }
}

class StageFakeAptAdapter {
  constructor(observation) {
    this.observation = observation;
    this.refreshed = 0;
    this.simulated = 0;
    this.installed = 0;
  }

  async observe(packageNames) {
    const selected = this.observation.packages
      .filter((entry) => packageNames.includes(entry.name))
      .map((entry) => ({ ...entry }));
    return {
      ...this.observation,
      packages: selected
    };
  }

  async refreshMetadata() {
    this.refreshed += 1;
    this.observation = {
      ...this.observation,
      metadataFresh: true
    };
  }

  async simulateInstall() {
    this.simulated += 1;
  }

  async installPinned(pins) {
    this.installed += 1;
    const byName = new Map(pins.map((pin) => [pin.name, pin.version]));
    this.observation = {
      ...this.observation,
      packages: this.observation.packages.map((entry) => ({
        ...entry,
        installedVersion: byName.get(entry.name) ?? entry.installedVersion
      })),
      rebootRequired: false
    };
  }
}

function makeConfig(root, selectedStages = ["S01"]) {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
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

async function writeConfig(configPath, config) {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function supportedPreflightProbe(expectedUser) {
  return {
    async readOnlyHostReport() {
      return {
        osRelease: "ubuntu-24.04",
        arch: "amd64",
        uid: 1000,
        username: expectedUser,
        hasSystemd: true,
        cgroupVersion: "v2",
        freeDiskBytes: 10 * 1024 ** 3,
        totalDiskBytes: 20 * 1024 ** 3,
        freeInodes: 100_000,
        cpuCount: 4,
        totalMemBytes: 8 * 1024 ** 3
      };
    }
  };
}

function makeBootstrapStage(receiptPath) {
  return {
    id: "S00",
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      const exists = fs.existsSync(receiptPath);
      return {
        stageId: "S00",
        status: exists ? "verified" : "blocked",
        checks: { bootstrap_receipt_present: exists },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan(_desired, observed) {
      return {
        stageId: "S00",
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: observed.checks.bootstrap_receipt_present === true ? [] : ["bootstrap-required"]
      };
    },
    async apply(ctx) {
      const observation = await this.observe(ctx);
      return [{
        operationId: "s00-bootstrap-check",
        stageId: "S00",
        resourceId: "bootstrap-receipt",
        observedAt: observation.observedAt,
        checks: observation.checks,
        versions: observation.versions,
        artifacts: []
      }];
    },
    async verify(ctx) {
      return this.apply(ctx);
    },
    async recover(ctx) {
      return this.verify(ctx);
    }
  };
}

function makeS00Verified() {
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
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
}

function makeNoopS01() {
  return {
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
      return {
        stageId: "S01",
        optional: false,
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

function aptObservationWithMissingInstall() {
  return {
    metadataFresh: false,
    metadataUpdatedAt: "2026-10-23T10:00:00.000Z",
    sudoAvailable: true,
    dpkgAuditClean: true,
    dpkgAuditOutput: "",
    rebootRequired: false,
    packages: [
      { name: "git", installedVersion: null, candidateVersion: "1:2.43.0-1ubuntu7.3" },
      { name: "curl", installedVersion: null, candidateVersion: "8.5.0-2ubuntu10.6" },
      { name: "ca-certificates", installedVersion: null, candidateVersion: "20240203" },
      { name: "build-essential", installedVersion: null, candidateVersion: "12.10ubuntu1" },
      { name: "tmux", installedVersion: null, candidateVersion: "3.4-1ubuntu0.1" }
    ]
  };
}

function aptObservationWithInstalledPackages() {
  return {
    metadataFresh: true,
    metadataUpdatedAt: "2026-10-23T10:00:00.000Z",
    sudoAvailable: true,
    dpkgAuditClean: true,
    dpkgAuditOutput: "",
    rebootRequired: false,
    packages: [
      { name: "git", installedVersion: "1:2.43.0-1ubuntu7.3", candidateVersion: "1:2.43.0-1ubuntu7.3" },
      { name: "curl", installedVersion: "8.5.0-2ubuntu10.6", candidateVersion: "8.5.0-2ubuntu10.6" },
      { name: "ca-certificates", installedVersion: "20240203", candidateVersion: "20240203" },
      { name: "build-essential", installedVersion: "12.10ubuntu1", candidateVersion: "12.10ubuntu1" },
      { name: "tmux", installedVersion: "3.4-1ubuntu0.1", candidateVersion: "3.4-1ubuntu0.1" }
    ]
  };
}

async function approveRequiredGates(engine, configPath, planResult) {
  const approvals = Array.isArray(planResult.envelope.data?.required_approvals)
    ? planResult.envelope.data.required_approvals
    : [];
  for (const approval of approvals) {
    await engine.run("gate-approve", {
      configPath,
      gateId: approval.id,
      planHash: planResult.envelope.plan_hash
    });
  }
}

function legacyChecksum(record) {
  return createHash("sha256")
    .update(`${record.sequence}|${record.at}|${record.operation_id}|${record.stage}|${record.code}|${record.message}`)
    .digest("hex");
}

async function scenarioN00() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `probe-${mode}-n00-`));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const bootstrapReceiptPath = path.join(root, "bootstrap", "receipt.json");
  await fs.promises.mkdir(path.dirname(bootstrapReceiptPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(bootstrapReceiptPath, "{\"ok\":true}\n", "utf8");
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new ProcessAdapter(4100),
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([
      makeBootstrapStage(bootstrapReceiptPath),
      createPreflightStage(supportedPreflightProbe(config.host.expected_user))
    ])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data?.plan_path,
    nonInteractive: true
  });
  const status = await engine.run("status", { configPath });
  const resume = await engine.run("resume", { configPath });
  return {
    plan: plan.exitCode,
    apply: apply.exitCode,
    status: status.exitCode,
    resume: resume.exitCode,
    applyCode: apply.envelope.error?.code ?? null
  };
}

async function scenarioN01N02(label, aptObservation) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `probe-${mode}-${label}-`));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S02"]);
  await writeConfig(configPath, config);
  const aptAdapter = new StageFakeAptAdapter(aptObservation);
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new ProcessAdapter(4200),
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([
      makeS00Verified(),
      createPreflightStage(supportedPreflightProbe(config.host.expected_user)),
      createSystemStage(aptAdapter)
    ])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S02" });
  await approveRequiredGates(engine, configPath, plan);
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data?.plan_path,
    nonInteractive: true
  });
  const status = await engine.run("status", { configPath });
  const resume = await engine.run("resume", { configPath });
  return {
    plan: plan.exitCode,
    apply: apply.exitCode,
    status: status.exitCode,
    resume: resume.exitCode,
    statusCode: status.envelope.error?.code ?? null,
    resumeCode: resume.envelope.error?.code ?? null
  };
}

async function scenarioN03() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `probe-${mode}-n03-`));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new ProcessAdapter(4300);
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, {
    ...seeded,
    stages: seeded.stages.map((item) =>
      item.id === "S00" || item.id === "S01" ? { ...item, status: "verified" } : item
    )
  });

  const legacyRecords = [
    {
      sequence: 1,
      at: "2026-10-23T12:00:00.000Z",
      operation_id: "x",
      stage: "S01",
      code: "intent",
      message: "intent 1"
    },
    {
      sequence: 2,
      at: "2026-10-23T12:00:01.000Z",
      operation_id: "x",
      stage: "S01",
      code: "receipt",
      message: "receipt 1"
    },
    {
      sequence: 3,
      at: "2026-10-23T12:00:02.000Z",
      operation_id: "x",
      stage: "S01",
      code: "intent",
      message: "intent 2"
    }
  ].map((record) => ({ ...record, checksum: legacyChecksum(record) }));

  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "events.jsonl"),
    `${legacyRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00Verified(), makeNoopS01()])
  );
  const recover = await engine.run("recover", { configPath });
  return {
    recover: recover.exitCode,
    recoverCode: recover.envelope.error?.code ?? null
  };
}

async function scenarioN06() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `probe-${mode}-n06-`));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new ProcessAdapter(4400);
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, {
    ...seeded,
    stages: seeded.stages.map((item) =>
      item.id === "S00" || item.id === "S01" ? { ...item, status: "verified" } : item
    )
  });
  await saveState(fsAdapter, config, {
    ...seeded,
    stages: seeded.stages.map((item) =>
      item.id === "S00" || item.id === "S01" ? { ...item, status: "verified" } : item
    ),
    in_flight_operation: {
      id: "s02-install",
      stage_id: "S02",
      kind: "mutate",
      started_at: "2026-10-23T12:30:00.000Z"
    }
  });
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:31:00.000Z") }
    },
    createRegistry([makeS00Verified(), makeNoopS01()])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  const recover = await engine.run("recover", { configPath });
  return {
    plan: plan.exitCode,
    planCode: plan.envelope.error?.code ?? null,
    recover: recover.exitCode,
    recoverCode: recover.envelope.error?.code ?? null
  };
}

async function scenarioN07Baseline() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "probe-baseline-n07-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const fsAdapter = new FaultFilesystemAdapter();
  const processAdapter = new ProcessAdapter(4500);
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, {
    ...seeded,
    stages: seeded.stages.map((item) =>
      item.id === "S00" || item.id === "S01" ? { ...item, status: "verified" } : item
    )
  });
  await saveState(fsAdapter, config, {
    ...seeded,
    stages: seeded.stages.map((item) =>
      item.id === "S00" || item.id === "S01" ? { ...item, status: "verified" } : item
    ),
    in_flight_operation: {
      id: "s02-install",
      stage_id: "S02",
      kind: "mutate",
      started_at: "2026-10-23T12:35:00.000Z"
    }
  });
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:36:00.000Z") }
    },
    createRegistry([makeS00Verified(), makeNoopS01()])
  );

  fsAdapter.setRules([{ method: "rename", atCall: 2, pathIncludes: "state.json->", code: "EIO" }]);
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  const planFaultHit = fsAdapter.getTriggered();

  fsAdapter.setRules([{ method: "remove", atCall: 1, pathIncludes: "recovery-required.json", code: "EIO" }]);
  const recover1 = await engine.run("recover", { configPath });
  const recoverFaultHit = fsAdapter.getTriggered();

  fsAdapter.setRules([]);
  const recover2 = await engine.run("recover", { configPath });
  return {
    plan: plan.exitCode,
    planCode: plan.envelope.error?.code ?? null,
    planFaultHit,
    recover1: recover1.exitCode,
    recover1Code: recover1.envelope.error?.code ?? null,
    recoverFaultHit,
    recover2: recover2.exitCode,
    recover2Code: recover2.envelope.error?.code ?? null
  };
}

async function scenarioN07Fixed() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "probe-fixed-n07-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root, ["S01"]);
  await writeConfig(configPath, config);
  const fsAdapter = new FaultFilesystemAdapter();
  const processAdapter = new ProcessAdapter(4600);
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, seeded);
  await saveState(fsAdapter, config, seeded);
  await fsAdapter.remove(path.join(config.paths.setup_state_dir, "state.json"));
  await fsAdapter.writeText(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify({
      schema_version: 1,
      reason: "state_primary_missing_previous_present",
      observed_at: "2026-10-23T12:00:00.000Z",
      installation_id: config.installation_id,
      state_primary_present: false,
      state_previous_present: true,
      state_quarantine_entries: [],
      journal_present: false
    }, null, 2)}\n`,
    0o600
  );

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new HttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:36:00.000Z") }
    },
    createRegistry([makeS00Verified(), makeNoopS01()])
  );

  fsAdapter.setRules([{ method: "remove", atCall: 1, pathIncludes: "recovery-required.json", code: "EIO" }]);
  const recover1 = await engine.run("recover", { configPath });
  const recoverFaultHit = fsAdapter.getTriggered();

  fsAdapter.setRules([]);
  const recover2 = await engine.run("recover", { configPath });
  return {
    recover1: recover1.exitCode,
    recover1Code: recover1.envelope.error?.code ?? null,
    recoverFaultHit,
    recover2: recover2.exitCode,
    recover2Code: recover2.envelope.error?.code ?? null
  };
}

async function main() {
  const originalNodeVersion = process.versions.node;
  Object.defineProperty(process.versions, "node", { value: "24.19.0", configurable: true });
  try {
    const results = {
      mode,
      N00: await scenarioN00(),
      N01: await scenarioN01N02("n01", aptObservationWithMissingInstall()),
      N02: await scenarioN01N02("n02", aptObservationWithInstalledPackages()),
      N03: await scenarioN03(),
      N06: await scenarioN06(),
      N07: mode === "baseline" ? await scenarioN07Baseline() : await scenarioN07Fixed()
    };
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    Object.defineProperty(process.versions, "node", { value: originalNodeVersion, configurable: true });
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
