import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { NodeFilesystemAdapter, type FilesystemAdapter } from "../../src/adapters/filesystem";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import {
  appendEvent,
  initState,
  inspectStateEvidence,
  loadState,
  saveState,
  stateHash,
  type RecoveryMarkerRecord
} from "../../src/core/state";
import { stableStringify } from "../../src/core/config";
import { acquireLock } from "../../src/core/lock";
import {
  ExitCode,
  type JsonEnvelope,
  type SetupConfig,
  type SetupState,
  type StageContext,
  type StageId,
  type StageModule,
  type StageOperation
} from "../../src/core/types";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { type HttpGetOptions, type HttpResponse } from "../../src/adapters/http";
import { type AptAdapter, type AptPackagePin, type AptSystemObservation } from "../../src/adapters/apt";
import { createPreflightStage, type PreflightProbe } from "../../src/stages/preflight";
import { createSystemStage } from "../../src/stages/system";

type FsMethod = keyof FilesystemAdapter;

interface FailureRule {
  method: FsMethod;
  atCall: number;
  pathIncludes?: string;
  code: string;
  message?: string;
}

class InstrumentedFilesystemAdapter implements FilesystemAdapter {
  private readonly delegate = new NodeFilesystemAdapter();
  private readonly callCounts = new Map<FsMethod, number>();
  private failureRules: FailureRule[];
  private triggeredFailures = 0;
  readonly calls: Array<{ method: FsMethod; path: string }> = [];

  constructor(failureRules: FailureRule[] = []) {
    this.failureRules = failureRules;
  }

  setFailureRules(rules: FailureRule[]): void {
    this.failureRules = rules;
    this.callCounts.clear();
    this.triggeredFailures = 0;
  }

  getTriggeredFailures(): number {
    return this.triggeredFailures;
  }

  getMutatingCalls(): Array<{ method: FsMethod; path: string }> {
    const mutating = new Set<FsMethod>([
      "writeText",
      "appendText",
      "mkdir",
      "rename",
      "remove",
      "fsyncFile",
      "fsyncDir",
      "ensureParentDir"
    ]);
    return this.calls.filter((entry) => mutating.has(entry.method));
  }

  async readText(filePath: string): Promise<string> {
    this.track("readText", filePath);
    return this.delegate.readText(filePath);
  }

  async readTextBounded(filePath: string, maxBytes: number): Promise<{
    text: string;
    bytesRead: number;
    truncated: boolean;
  }> {
    this.track("readTextBounded", filePath);
    return this.delegate.readTextBounded(filePath, maxBytes);
  }

  async writeText(filePath: string, content: string, mode?: number): Promise<void> {
    this.track("writeText", filePath);
    await this.delegate.writeText(filePath, content, mode);
  }

  async appendText(filePath: string, content: string): Promise<void> {
    this.track("appendText", filePath);
    await this.delegate.appendText(filePath, content);
  }

  async exists(filePath: string): Promise<boolean> {
    this.track("exists", filePath);
    return this.delegate.exists(filePath);
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    this.track("mkdir", dirPath);
    await this.delegate.mkdir(dirPath, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.track("rename", `${oldPath}->${newPath}`);
    await this.delegate.rename(oldPath, newPath);
  }

  async remove(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.track("remove", targetPath);
    await this.delegate.remove(targetPath, options);
  }

  lstat(targetPath: string): ReturnType<FilesystemAdapter["lstat"]> {
    this.track("lstat", targetPath);
    return this.delegate.lstat(targetPath);
  }

  stat(targetPath: string): ReturnType<FilesystemAdapter["stat"]> {
    this.track("stat", targetPath);
    return this.delegate.stat(targetPath);
  }

  async readdir(targetPath: string): Promise<string[]> {
    this.track("readdir", targetPath);
    return this.delegate.readdir(targetPath);
  }

  async realpath(targetPath: string): Promise<string> {
    this.track("realpath", targetPath);
    return this.delegate.realpath(targetPath);
  }

  async fsyncFile(filePath: string): Promise<void> {
    this.track("fsyncFile", filePath);
    await this.delegate.fsyncFile(filePath);
  }

  async fsyncDir(dirPath: string): Promise<void> {
    this.track("fsyncDir", dirPath);
    await this.delegate.fsyncDir(dirPath);
  }

  async ensureParentDir(filePath: string): Promise<void> {
    this.track("ensureParentDir", filePath);
    await this.delegate.ensureParentDir(filePath);
  }

  private track(method: FsMethod, targetPath: string): void {
    this.calls.push({ method, path: targetPath });
    const current = this.callCounts.get(method) ?? 0;
    const next = current + 1;
    this.callCounts.set(method, next);
    const matchingRule = this.failureRules.find((rule) =>
      rule.method === method
      && rule.atCall === next
      && (rule.pathIncludes === undefined || targetPath.includes(rule.pathIncludes))
    );
    if (matchingRule !== undefined) {
      this.triggeredFailures += 1;
      const error = new Error(matchingRule.message ?? `${matchingRule.method} injected failure`) as NodeJS.ErrnoException;
      error.code = matchingRule.code;
      throw error;
    }
  }
}

class CountingProcessAdapter implements ProcessAdapter {
  public commandCalls: CommandOptions[] = [];

  constructor(
    private readonly processPid: number,
    private readonly bootIdValue: string,
    private readonly machineIdValue: string,
    private readonly processStart: number | null,
    private readonly processUid = 1000,
    private readonly processUser = "factory",
    private readonly livePidCheck = false
  ) {}

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    this.commandCalls.push(options);
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
    return this.machineIdValue;
  }

  async processStartTicks(pid: number): Promise<number | null> {
    if (pid === this.processPid) {
      return this.processStart;
    }
    return null;
  }

  isPidAlive(pid: number): boolean {
    if (this.livePidCheck) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
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

function makeConfig(root: string): SetupConfig {
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

function makeNoopStage(id: "S01" | "S12", dependencies: Array<"S00" | "S01">): StageModule {
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

function makeMutatingStage(effectPath: string): StageModule {
  return {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      const exists = fs.existsSync(effectPath);
      return {
        stageId: "S01",
        status: exists ? "verified" : "planned",
        checks: { effect_present: exists },
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan(_desired, observed) {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: [],
        operations: observed.status === "verified"
          ? []
          : [{
              id: "s01-op",
              stageId: "S01",
              kind: "mutate",
              resourceId: "effect",
              risk: "low",
              gateIds: [],
              preconditions: [],
              sideEffects: ["write fixture"],
              timeoutSec: 10,
              retryable: false
            }],
        requiredGates: []
      };
    },
    async apply() {
      await fs.promises.mkdir(path.dirname(effectPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(effectPath, "ok\n", "utf8");
      return [
        {
          operationId: "s01-op",
          stageId: "S01",
          resourceId: "effect",
          observedAt: new Date().toISOString(),
          checks: { written: true },
          versions: {},
          artifacts: [effectPath]
        }
      ];
    },
    async verify() {
      return [];
    },
    async recover(_ctx: StageContext, _operation: StageOperation) {
      return [];
    }
  };
}

function makeBootstrapStage(receiptPath: string): StageModule {
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
        checks: {
          bootstrap_receipt_present: exists
        },
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
      return [
        {
          operationId: "s00-bootstrap-check",
          stageId: "S00",
          resourceId: "bootstrap-receipt",
          observedAt: observation.observedAt,
          checks: observation.checks,
          versions: observation.versions,
          artifacts: []
        }
      ];
    },
    async verify(ctx) {
      return this.apply(ctx, {
        stageId: "S00",
        optional: false,
        requiredCapabilities: [],
        operations: [],
        requiredGates: []
      });
    },
    async recover(ctx) {
      return this.verify(ctx);
    }
  };
}

function supportedPreflightProbe(expectedUser: string): PreflightProbe {
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

class StageFakeAptAdapter implements AptAdapter {
  constructor(private observation: AptSystemObservation) {}

  refreshed = 0;
  simulated = 0;
  installed = 0;

  async observe(packageNames: string[]): Promise<AptSystemObservation> {
    const selected = this.observation.packages
      .filter((entry) => packageNames.includes(entry.name))
      .map((entry) => ({ ...entry }));
    return {
      ...this.observation,
      packages: selected
    };
  }

  async refreshMetadata(): Promise<void> {
    this.refreshed += 1;
    this.observation = {
      ...this.observation,
      metadataFresh: true
    };
  }

  async simulateInstall(_pins: AptPackagePin[]): Promise<void> {
    this.simulated += 1;
  }

  async installPinned(pins: AptPackagePin[]): Promise<void> {
    this.installed += 1;
    const byName = new Map(pins.map((pin) => [pin.name, pin.version] as const));
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

function aptObservationWithMissingInstall(): AptSystemObservation {
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

function v2Checksum(record: Omit<{
  schema_version: 2;
  sequence: number;
  at: string;
  installation_id: string;
  attempt_id: string;
  operation_id: string;
  stage: StageId;
  code: "intent" | "effect" | "verify" | "checkpoint";
  message: string;
  state_hash?: string;
}, "checksum">): string {
  return createHash("sha256").update(stableStringify(record)).digest("hex");
}

interface JournalV2Record {
  schema_version: 2;
  sequence: number;
  checksum: string;
  at: string;
  installation_id: string;
  attempt_id: string;
  operation_id: string;
  stage: StageId;
  code: "intent" | "effect" | "verify" | "checkpoint";
  message: string;
  state_hash?: string;
}

function makeV2Event(record: Omit<JournalV2Record, "checksum">): JournalV2Record {
  return {
    ...record,
    checksum: v2Checksum(record)
  };
}

async function appendV2Event(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  record: Omit<JournalV2Record, "checksum">
): Promise<void> {
  await appendEvent(fsAdapter, config, makeV2Event(record));
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

function containsErrorCode(envelope: JsonEnvelope, code: string): boolean {
  if (envelope.error?.code === code) {
    return true;
  }
  const maybeErrors = (envelope as { errors?: Array<{ code?: string }> }).errors;
  if (!Array.isArray(maybeErrors)) {
    return false;
  }
  return maybeErrors.some((entry) => entry.code === code);
}

function recoveryMarkerBody(config: SetupConfig, overrides: Partial<RecoveryMarkerRecord>): RecoveryMarkerRecord {
  return {
    schema_version: 1,
    reason: "state_primary_missing_previous_present",
    observed_at: "2026-10-23T12:00:00.000Z",
    installation_id: config.installation_id,
    state_primary_present: false,
    state_previous_present: true,
    state_quarantine_entries: [],
    journal_present: false,
    ...overrides
  };
}

async function withNodeVersion<T>(nodeVersion: string, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  Object.defineProperty(process.versions, "node", {
    value: nodeVersion,
    configurable: true
  });
  try {
    return await run();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(process.versions, "node", descriptor);
    }
  }
}

async function seedValidState(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<SetupState> {
  const state = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  const withVerified = {
    ...state,
    stages: state.stages.map((item) =>
      item.id === "S00" || item.id === "S01"
        ? { ...item, status: "verified" as const }
        : item
    )
  };
  await saveState(fsAdapter, config, withVerified);
  return withVerified;
}

test("R1-01 status/gate-list read-only path is mutation-free even with held writer lock", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-01-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2001,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await seedValidState(fsAdapter, processAdapter, config);
  fsAdapter.calls.length = 0;

  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({
      boot_id: "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      pid: 9999,
      process_start_ticks: 1,
      nonce: "nonce",
      installation_id: config.installation_id,
      created_at: "2026-10-23T12:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const status = await engine.run("status", { configPath });
  assert.equal(status.exitCode, ExitCode.Success, JSON.stringify(status.envelope));
  assert.equal(status.envelope.data?.recorded_state_only, true);

  const gateList = await engine.run("gate-list", { configPath });
  assert.equal(gateList.exitCode, ExitCode.Success, JSON.stringify(gateList.envelope));

  assert.deepEqual(
    fsAdapter.getMutatingCalls().map((entry) => entry.method),
    []
  );
});

test("R1-02 read-only diagnostics never mutate damaged state paths", async () => {
  const scenarios = [
    "corrupt-primary",
    "missing-primary-previous",
    "marker-present",
    "journal-only-intent"
  ] as const;

  for (const scenario of scenarios) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `q1a-r1-02-${scenario}-`));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });

    if (scenario === "corrupt-primary") {
      await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");
    }
    if (scenario === "missing-primary-previous") {
      await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json.previous"), "{ }\n", "utf8");
    }
    if (scenario === "marker-present") {
      await fs.promises.writeFile(
        path.join(config.paths.setup_state_dir, "recovery-required.json"),
        `${JSON.stringify({ schema_version: 1, reason: "state_corrupt", observed_at: "2026-10-23T00:00:00.000Z" }, null, 2)}\n`,
        "utf8"
      );
    }
    if (scenario === "journal-only-intent") {
      await fs.promises.writeFile(
        path.join(config.paths.setup_state_dir, "events.jsonl"),
        `${JSON.stringify({
          sequence: 1,
          at: "2026-10-23T00:00:00.000Z",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "intent:mutate",
          checksum: "f".repeat(64)
        })}\n`,
        "utf8"
      );
    }

    const fsAdapter = new InstrumentedFilesystemAdapter();
    const processAdapter = new CountingProcessAdapter(
      2002,
      "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      "1".repeat(64),
      100
    );
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );

    const result = await engine.run("status", { configPath });
    assert.equal(result.exitCode, ExitCode.DriftOrRecoveryRequired, `${scenario}: ${JSON.stringify(result.envelope)}`);
    assert.ok(result.envelope.error?.code !== undefined);

    assert.deepEqual(
      fsAdapter.getMutatingCalls().map((entry) => entry.method),
      [],
      `${scenario}: read-only command performed mutation`
    );
  }
});

test("R1-03 marker/quarantine failure windows preserve uncertainty and never reset to fresh state", async () => {
  const boundaries: Array<{ id: string; rule: FailureRule }> = [
    { id: "marker-write", rule: { method: "writeText", atCall: 2, pathIncludes: "recovery-required.json.tmp-", code: "ENOSPC" } },
    { id: "marker-fsync", rule: { method: "fsyncFile", atCall: 2, pathIncludes: "recovery-required.json.tmp-", code: "EIO" } },
    { id: "marker-rename", rule: { method: "rename", atCall: 1, pathIncludes: "recovery-required.json.tmp-", code: "EIO" } },
    { id: "marker-dir-fsync", rule: { method: "fsyncDir", atCall: 2, pathIncludes: `${path.sep}state`, code: "EIO" } },
    { id: "quarantine-rename", rule: { method: "rename", atCall: 2, pathIncludes: "state.json.corrupt-", code: "EIO" } },
    { id: "quarantine-dir-fsync", rule: { method: "fsyncDir", atCall: 3, pathIncludes: `${path.sep}state`, code: "EIO" } }
  ];

  for (const boundary of boundaries) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `q1a-r1-03-${boundary.id}-`));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");

    const fsAdapter = new InstrumentedFilesystemAdapter();
    const processAdapter = new CountingProcessAdapter(
      2003,
      "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      "1".repeat(64),
      100
    );
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );

    const first = await engine.run("plan", { configPath, stageId: "S01" });
    assert.equal(first.exitCode, ExitCode.DriftOrRecoveryRequired, `${boundary.id}: ${JSON.stringify(first.envelope)}`);

    fsAdapter.setFailureRules([]);
    fsAdapter.calls.length = 0;
    const second = await engine.run("status", { configPath });
    assert.equal(second.exitCode, ExitCode.DriftOrRecoveryRequired, `${boundary.id}: ${JSON.stringify(second.envelope)}`);

    const evidence = await inspectStateEvidence(new NodeFilesystemAdapter(), config);
    const looksFresh = evidence.marker === null
      && !evidence.stateExists
      && !evidence.previousExists
      && evidence.quarantineEntries.length === 0
      && !evidence.journal.hasRecords;
    assert.equal(looksFresh, false, `${boundary.id}: uncertainty evidence was lost`);
  }
});

test("R1-04 save/journal fault boundaries keep deterministic old/new or recovery outcome", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-04-"));
  const config = makeConfig(root);
  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2004,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  const base = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, base);

  const upgraded: SetupState = {
    ...base,
    in_flight_operation: {
      id: "s01-op",
      stage_id: "S01",
      kind: "mutate",
      started_at: "2026-10-23T12:01:00.000Z"
    }
  };
  const baseHash = stateHash(base);
  const upgradedHash = stateHash(upgraded);

  const boundaries: FailureRule[] = [
    { method: "writeText", atCall: 1, pathIncludes: "state.json.tmp-", code: "ENOSPC" },
    { method: "fsyncFile", atCall: 1, pathIncludes: "state.json.tmp-", code: "EIO" },
    { method: "rename", atCall: 1, pathIncludes: "state.json.tmp-", code: "EIO" },
    { method: "fsyncDir", atCall: 1, code: "EIO" },
    { method: "writeText", atCall: 2, pathIncludes: "state.json.previous.tmp-", code: "ENOSPC" },
    { method: "fsyncFile", atCall: 2, pathIncludes: "state.json.previous.tmp-", code: "EIO" },
    { method: "rename", atCall: 2, pathIncludes: "state.json.previous.tmp-", code: "EIO" },
    { method: "fsyncDir", atCall: 2, code: "EIO" }
  ];

  for (const failure of boundaries) {
    fsAdapter.setFailureRules([failure]);
    await assert.rejects(
      () => saveState(fsAdapter, config, upgraded),
      () => true
    );
    fsAdapter.setFailureRules([]);
    let loaded: SetupState | null = null;
    let loadError: { code?: string } | null = null;
    try {
      loaded = await loadState(
        fsAdapter,
        processAdapter,
        { now: () => new Date("2026-10-23T12:02:00.000Z") },
        config,
        "0.0.1",
        {
          initializeIfMissing: false,
          persistConfigDrift: false,
          readOnly: true
        }
      );
    } catch (error) {
      loadError = error as { code?: string };
    }

    if (loaded !== null) {
      const hash = stateHash(loaded);
      assert.ok(hash === baseHash || hash === upgradedHash, `unexpected state hash after ${failure.method}`);
    } else {
      assert.equal(loadError?.code === "recovery_required" || loadError?.code === "state_recovery_required", true);
    }
  }

  const journalBoundaries: FailureRule[] = [
    { method: "appendText", atCall: 1, pathIncludes: "events.jsonl", code: "ENOSPC" },
    { method: "fsyncFile", atCall: 1, pathIncludes: "events.jsonl", code: "EIO" },
    { method: "fsyncDir", atCall: 1, pathIncludes: `${path.sep}state`, code: "EIO" }
  ];

  for (const failure of journalBoundaries) {
    const journalRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-04-journal-"));
    const journalConfig = makeConfig(journalRoot);
    const journalFs = new InstrumentedFilesystemAdapter();
    const journalProcess = new CountingProcessAdapter(
      20040,
      "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      "1".repeat(64),
      100
    );
    await fs.promises.mkdir(journalConfig.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    const journalState = await initState(
      journalFs,
      journalProcess,
      { now: () => new Date("2026-10-23T12:00:00.000Z") },
      journalConfig,
      "0.0.1"
    );
    await saveState(journalFs, journalConfig, journalState);
    journalFs.setFailureRules([failure]);

    await assert.rejects(
      () => appendEvent(journalFs, journalConfig, {
        operation_id: "journal-op",
        stage: "S01",
        code: "intent",
        message: "intent:mutate"
      }),
      () => true
    );
    journalFs.setFailureRules([]);

    const evidence = await inspectStateEvidence(new NodeFilesystemAdapter(), journalConfig);
    if (failure.method === "appendText") {
      assert.equal(evidence.journal.hasRecords, false);
      continue;
    }

    assert.equal(evidence.journal.hasRecords, true);
    assert.equal(evidence.journal.unresolvedOperationIds.includes("journal-op"), true);
    await assert.rejects(
      () => loadState(
        new NodeFilesystemAdapter(),
        journalProcess,
        { now: () => new Date("2026-10-23T12:02:00.000Z") },
        journalConfig,
        "0.0.1",
        {
          initializeIfMissing: false,
          persistConfigDrift: false,
          readOnly: true
        }
      ),
      (error) => (error as { code?: string }).code === "journal_recovery_required"
    );
  }
});

test("R1-05 journal-only/torn/oversized evidence blocks initialization without hidden writes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-05-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });

  const oversized = path.join(config.paths.setup_state_dir, "events.jsonl");
  await fs.promises.writeFile(oversized, `${"x".repeat(1024 * 1024 + 32)}\n`, "utf8");

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2005,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const result = await engine.run("status", { configPath });
  assert.equal(result.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(result.envelope));
  assert.equal((await fs.promises.stat(oversized)).size > 1024 * 1024, true);
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), false);
  assert.deepEqual(fsAdapter.getMutatingCalls().map((entry) => entry.method), []);
});

test("R1-06 unresolved intent keeps recovery required across status/resume/recover", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-06-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effect.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });

  const processAdapter = new CountingProcessAdapter(
    2006,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const previous = await initState(new NodeFilesystemAdapter(), processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json.previous"), `${JSON.stringify(previous, null, 2)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "events.jsonl"),
    `${JSON.stringify({
      sequence: 1,
      at: "2026-10-23T12:00:00.000Z",
      operation_id: "s01-op",
      stage: "S01",
      code: "intent",
      message: "intent:mutate",
      checksum: "0".repeat(64)
    })}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeMutatingStage(effectPath)])
  );

  const status = await engine.run("status", { configPath });
  assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));

  const resume = await engine.run("resume", { configPath, nonInteractive: true });
  assert.equal(resume.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(resume.envelope));
  assert.equal(fs.existsSync(effectPath), false);

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
});

test("R1-07 unreconciled marker/in-flight returns exit 8 and preserves evidence", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-07-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify({ schema_version: 1, reason: "state_corrupt", observed_at: "2026-10-23T12:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new CountingProcessAdapter(
        2007,
        "f324dcd7-4035-4430-ab39-ce31f9e396bf",
        "1".repeat(64),
        100
      ),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), true);
  assert.equal((recover.envelope.error?.next_action ?? "").toLowerCase().includes("delete marker"), false);
});

test("R1-08 supported recovery restores previous snapshot and is idempotent", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-08-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });

  const processAdapter = new CountingProcessAdapter(
    2008,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const snapshot = await initState(new NodeFilesystemAdapter(), processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json.previous"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify({ schema_version: 1, reason: "state_primary_missing_previous_present", observed_at: "2026-10-23T12:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const first = await engine.run("recover", { configPath });
  assert.equal(first.exitCode, ExitCode.Success, JSON.stringify(first.envelope));
  assert.equal(first.envelope.data?.outcome, "recovered_previous_generation");
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), false);

  const second = await engine.run("recover", { configPath });
  assert.equal(second.exitCode, ExitCode.Success, JSON.stringify(second.envelope));
  assert.equal(second.envelope.data?.outcome, "recovery_not_required");
});

test("R1-09 foreign candidate and invalid host identity are refused before overwrite", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-09-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });

  const foreign = await initState(
    new NodeFilesystemAdapter(),
    new CountingProcessAdapter(2009, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100),
    { now: () => new Date("2026-10-23T12:00:00.000Z") },
    { ...config, installation_id: "7657b98d-74a3-4097-9ab5-eb1cc20d2ae9" },
    "0.0.1"
  );
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json.previous"), `${JSON.stringify(foreign, null, 2)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify({ schema_version: 1, reason: "state_primary_missing_previous_present", observed_at: "2026-10-23T12:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const engineForeign = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new CountingProcessAdapter(2009, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const foreignRecover = await engineForeign.run("recover", { configPath });
  assert.equal(foreignRecover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(foreignRecover.envelope));
  assert.equal(foreignRecover.envelope.error?.code, "recovery_candidate_foreign_installation");
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), false);

  const validPrevious = await initState(
    new NodeFilesystemAdapter(),
    new CountingProcessAdapter(2010, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100),
    { now: () => new Date("2026-10-23T12:00:00.000Z") },
    config,
    "0.0.1"
  );
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json.previous"), `${JSON.stringify(validPrevious, null, 2)}\n`, "utf8");

  const engineInvalidIdentity = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new CountingProcessAdapter(2010, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "invalid", 100),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const invalidIdentity = await engineInvalidIdentity.run("recover", { configPath });
  assert.equal(invalidIdentity.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(invalidIdentity.envelope));
  assert.equal(invalidIdentity.envelope.error?.code, "recovery_host_identity_unavailable");
});

test("R1-10 ordinary effect routes are blocked before adapters when in-flight operation exists", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-10-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2011,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, {
    ...seeded,
    in_flight_operation: {
      id: "s08-auth",
      stage_id: "S08",
      kind: "mutate",
      started_at: "2026-10-23T12:01:00.000Z"
    }
  });

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const auth = await engine.run("auth-login", { configPath });
  assert.equal(auth.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(auth.envelope));

  const smoke = await engine.run("smoke", { configPath, provider: "fake", fixture: "toy" });
  assert.equal(smoke.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(smoke.envelope));

  const inference = await engine.run("inference-disable", { configPath });
  assert.equal(inference.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(inference.envelope));

  assert.equal(processAdapter.commandCalls.length, 0);
});

test("R1-11 writer/readers/recover interleaving keeps reader non-mutating and lock-only recover safe", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-11-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");

  const distRoot = path.resolve(__dirname, "../..");
  const holderPath = path.join(root, "hold-lock.js");
  const holderScript = `
const fs = require("node:fs");
const { NodeFilesystemAdapter } = require(${JSON.stringify(path.join(distRoot, "src/adapters/filesystem.js"))});
const { acquireLock } = require(${JSON.stringify(path.join(distRoot, "src/core/lock.js"))});

class Proc {
  async runCommand() { return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }; }
  pid() { return process.pid; }
  uid() { return 1000; }
  username() { return "factory"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "1".repeat(64); }
  async processStartTicks() { return null; }
  isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const lock = await acquireLock(new NodeFilesystemAdapter(), new Proc(), config);
  process.stdout.write("LOCKED\\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    if (chunk.includes("release")) {
      await lock.release();
      process.exit(0);
    }
  });
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(2);
});
`;
  await fs.promises.writeFile(holderPath, holderScript, "utf8");

  const holder = spawn(process.execPath, [holderPath, configPath], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  await new Promise<void>((resolve, reject) => {
    let output = "";
    holder.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("LOCKED")) {
        resolve();
      }
    });
    holder.on("exit", (code) => {
      if (!output.includes("LOCKED")) {
        reject(new Error(`lock holder exited early with code ${code}`));
      }
    });
  });

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2012,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    null,
    1000,
    "factory",
    true
  );
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const status = await engine.run("status", { configPath });
  assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), false);
  assert.equal(
    fsAdapter.getMutatingCalls().some((entry) => entry.method === "rename" || entry.method === "writeText"),
    false
  );

  const lockOnly = await engine.run("recover", { configPath, lockOnly: true });
  assert.equal(lockOnly.exitCode, ExitCode.LockOwnedByAnotherInstaller, JSON.stringify(lockOnly.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "lock")), true);

  holder.stdin.write("release\n");
  await once(holder, "exit");
});

test("R1-12 positive controls: fresh state init, cancel request, and lock-only stale cleanup keep working", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-12-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  const processAdapter = new CountingProcessAdapter(
    2013,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));

  const cancel = await engine.run("cancel", { configPath });
  assert.equal(cancel.exitCode, ExitCode.Success, JSON.stringify(cancel.envelope));
  assert.equal(
    fs.existsSync(path.join(config.paths.setup_state_dir, "cancel-request.json")),
    true
  );

  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({
      boot_id: "11111111-1111-4111-8111-111111111111",
      pid: 999999,
      process_start_ticks: null,
      nonce: "stale",
      installation_id: config.installation_id,
      created_at: "2026-10-23T12:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );
  const lockOnly = await engine.run("recover", { configPath, lockOnly: true });
  assert.equal(lockOnly.exitCode, ExitCode.Success, JSON.stringify(lockOnly.envelope));
  const entries = await fs.promises.readdir(config.paths.setup_state_dir);
  assert.equal(entries.some((entry) => entry.startsWith("lock.quarantine-")), true);
});

test("J01 real S00->S01 lifecycle plan/apply/status/resume stays journal-compatible", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j01-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  config.selected_stages = ["S01"];
  await writeConfig(configPath, config);

  const bootstrapReceiptPath = path.join(root, "bootstrap", "receipt.json");
  await fs.promises.mkdir(path.dirname(bootstrapReceiptPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(bootstrapReceiptPath, "{\"ok\":true}\n", "utf8");

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2101,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await withNodeVersion("24.19.0", async () => {
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      createRegistry([
        makeBootstrapStage(bootstrapReceiptPath),
        createPreflightStage(supportedPreflightProbe(config.host.expected_user))
      ])
    );

    const plan = await engine.run("plan", { configPath, stageId: "S01" });
    assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
    assert.equal(typeof plan.envelope.data?.plan_path, "string");

    const apply = await engine.run("apply", {
      configPath,
      planPath: plan.envelope.data?.plan_path as string,
      nonInteractive: true
    });
    assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));

    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.Success, JSON.stringify(status.envelope));

    const resumedEngine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:05:00.000Z") }
      },
      createRegistry([
        makeBootstrapStage(bootstrapReceiptPath),
        createPreflightStage(supportedPreflightProbe(config.host.expected_user))
      ])
    );
    const resume = await resumedEngine.run("resume", { configPath });
    assert.equal(resume.exitCode, ExitCode.Success, JSON.stringify(resume.envelope));

    const evidence = await inspectStateEvidence(fsAdapter, config);
    assert.equal(evidence.journal.parseError, false);
    assert.equal(evidence.journal.unknownOrder, false);
    assert.equal(evidence.journal.unresolvedOperationIds.length, 0);
  });
});

test("J02 real S02 install/refresh/no-op repeat preserves operation evidence and status/resume", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j02-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  config.selected_stages = ["S02"];
  await writeConfig(configPath, config);

  const bootstrapReceiptPath = path.join(root, "bootstrap", "receipt.json");
  await fs.promises.mkdir(path.dirname(bootstrapReceiptPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(bootstrapReceiptPath, "{\"ok\":true}\n", "utf8");

  const aptAdapter = new StageFakeAptAdapter(aptObservationWithMissingInstall());
  const processAdapter = new CountingProcessAdapter(
    2102,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const fsAdapter = new NodeFilesystemAdapter();
  await withNodeVersion("24.19.0", async () => {
    const registry = createRegistry([
      makeBootstrapStage(bootstrapReceiptPath),
      createPreflightStage(supportedPreflightProbe(config.host.expected_user)),
      createSystemStage(aptAdapter)
    ]);
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      registry
    );

    const plan = await engine.run("plan", { configPath, stageId: "S02" });
    assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
    assert.equal(typeof plan.envelope.data?.plan_path, "string");
    await approveRequiredGates(engine, configPath, plan);

    const apply = await engine.run("apply", {
      configPath,
      planPath: plan.envelope.data?.plan_path as string,
      nonInteractive: true
    });
    assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));
    assert.equal(aptAdapter.refreshed >= 1, true);
    assert.equal(aptAdapter.simulated >= 1, true);
    assert.equal(aptAdapter.installed, 1);

    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.Success, JSON.stringify(status.envelope));
    const resume = await engine.run("resume", { configPath });
    assert.equal(resume.exitCode, ExitCode.Success, JSON.stringify(resume.envelope));

    const plan2 = await engine.run("plan", { configPath, stageId: "S02" });
    assert.equal(plan2.exitCode, ExitCode.Success, JSON.stringify(plan2.envelope));
    assert.equal(typeof plan2.envelope.data?.plan_path, "string");
    await approveRequiredGates(engine, configPath, plan2);
    const apply2 = await engine.run("apply", {
      configPath,
      planPath: plan2.envelope.data?.plan_path as string,
      nonInteractive: true
    });
    assert.equal(apply2.exitCode, ExitCode.Success, JSON.stringify(apply2.envelope));
    assert.equal(aptAdapter.installed, 1);
  });
});

test("J03 new attempt, duplicate/gap/reorder/stage mismatch and receipt-before-intent require journal recovery", async () => {
  const scenarios: Array<{
    name: string;
    records: Array<Omit<JournalV2Record, "checksum">>;
  }> = [
    {
      name: "new-attempt-with-same-operation-id",
      records: [
        {
          schema_version: 2,
          sequence: 1,
          at: "2026-10-23T12:00:00.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "11111111-1111-4111-8111-111111111111",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "start"
        },
        {
          schema_version: 2,
          sequence: 2,
          at: "2026-10-23T12:00:01.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "11111111-1111-4111-8111-111111111111",
          operation_id: "s01-op",
          stage: "S01",
          code: "effect",
          message: "effect"
        },
        {
          schema_version: 2,
          sequence: 3,
          at: "2026-10-23T12:00:02.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "11111111-1111-4111-8111-111111111111",
          operation_id: "s01-op",
          stage: "S01",
          code: "verify",
          message: "verify"
        },
        {
          schema_version: 2,
          sequence: 4,
          at: "2026-10-23T12:00:03.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "11111111-1111-4111-8111-111111111111",
          operation_id: "s01-op",
          stage: "S01",
          code: "checkpoint",
          message: "commit",
          state_hash: "a".repeat(64)
        },
        {
          schema_version: 2,
          sequence: 5,
          at: "2026-10-23T12:00:04.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "22222222-2222-4222-8222-222222222222",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "re-attempt"
        }
      ]
    },
    {
      name: "gap",
      records: [
        {
          schema_version: 2,
          sequence: 1,
          at: "2026-10-23T12:00:00.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "33333333-3333-4333-8333-333333333333",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "start"
        },
        {
          schema_version: 2,
          sequence: 3,
          at: "2026-10-23T12:00:01.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "33333333-3333-4333-8333-333333333333",
          operation_id: "s01-op",
          stage: "S01",
          code: "effect",
          message: "gap"
        }
      ]
    },
    {
      name: "receipt-before-intent",
      records: [
        {
          schema_version: 2,
          sequence: 1,
          at: "2026-10-23T12:00:00.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "44444444-4444-4444-8444-444444444444",
          operation_id: "s01-op",
          stage: "S01",
          code: "effect",
          message: "effect-first"
        },
        {
          schema_version: 2,
          sequence: 2,
          at: "2026-10-23T12:00:01.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "44444444-4444-4444-8444-444444444444",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "intent-second"
        }
      ]
    },
    {
      name: "stage-mismatch",
      records: [
        {
          schema_version: 2,
          sequence: 1,
          at: "2026-10-23T12:00:00.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "55555555-5555-4555-8555-555555555555",
          operation_id: "shared-op",
          stage: "S01",
          code: "intent",
          message: "intent"
        },
        {
          schema_version: 2,
          sequence: 2,
          at: "2026-10-23T12:00:01.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "55555555-5555-4555-8555-555555555555",
          operation_id: "shared-op",
          stage: "S02",
          code: "effect",
          message: "mismatch"
        }
      ]
    },
    {
      name: "duplicate-intent",
      records: [
        {
          schema_version: 2,
          sequence: 1,
          at: "2026-10-23T12:00:00.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "66666666-6666-4666-8666-666666666666",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "intent-1"
        },
        {
          schema_version: 2,
          sequence: 2,
          at: "2026-10-23T12:00:01.000Z",
          installation_id: "cbcdfce2-8e6f-45e9-9d5b-7b4f9c4b6f5d",
          attempt_id: "66666666-6666-4666-8666-666666666666",
          operation_id: "s01-op",
          stage: "S01",
          code: "intent",
          message: "intent-2"
        }
      ]
    }
  ];

  for (const scenario of scenarios) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `q1a-r1-j03-${scenario.name}-`));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    const fsAdapter = new NodeFilesystemAdapter();
    const processAdapter = new CountingProcessAdapter(
      2103,
      "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      "1".repeat(64),
      100
    );
    await seedValidState(fsAdapter, processAdapter, config);
    await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(
      path.join(config.paths.setup_state_dir, "events.jsonl"),
      `${scenario.records.map((record) => JSON.stringify(makeV2Event(record))).join("\n")}\n`,
      "utf8"
    );
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:10:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );

    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, `${scenario.name}: ${JSON.stringify(status.envelope)}`);
    assert.equal(
      containsErrorCode(status.envelope, "journal_recovery_required"),
      true,
      `${scenario.name}: ${JSON.stringify(status.envelope)}`
    );
  }
});

test("J04 effect evidence without verify/checkpoint stays unknown and blocks plan/recover replay", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j04-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2104,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await seedValidState(fsAdapter, processAdapter, config);
  await appendV2Event(fsAdapter, config, {
    schema_version: 2,
    sequence: 1,
    at: "2026-10-23T12:00:00.000Z",
    installation_id: config.installation_id,
    attempt_id: "77777777-7777-4777-8777-777777777777",
    operation_id: "s01-op",
    stage: "S01",
    code: "intent",
    message: "intent"
  });
  await appendV2Event(fsAdapter, config, {
    schema_version: 2,
    sequence: 2,
    at: "2026-10-23T12:00:01.000Z",
    installation_id: config.installation_id,
    attempt_id: "77777777-7777-4777-8777-777777777777",
    operation_id: "s01-op",
    stage: "S01",
    code: "effect",
    message: "effect"
  });

  const effectPath = path.join(root, "effect", "touch.txt");
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:20:00.000Z") }
    },
    createRegistry([makeS00(), makeMutatingStage(effectPath)])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(plan.envelope));
  assert.equal(
    containsErrorCode(plan.envelope, "journal_recovery_required")
      || containsErrorCode(plan.envelope, "state_recovery_required"),
    true
  );

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(
    containsErrorCode(recover.envelope, "journal_recovery_required")
      || containsErrorCode(recover.envelope, "recovery_unresolved"),
    true
  );
  assert.equal(fs.existsSync(effectPath), false);
});

test("J05 corrupt newer in-flight with old previous and empty journal remains unresolved", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j05-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2105,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const seeded = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, {
    ...seeded,
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
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:31:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(plan.envelope));
  assert.equal(plan.envelope.error?.code, "state_corrupt");

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(recover.envelope.error?.code, "recovery_unresolved");
  assert.equal(
    fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")),
    true
  );
});

test("J06 interrupted recovery boundaries keep candidate durable and resume safely", async () => {
  const boundaries: Array<{ name: string; rule: FailureRule }> = [
    {
      name: "marker-prepare-write",
      rule: { method: "writeText", atCall: 2, pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "marker-prepare-fsync",
      rule: { method: "fsyncFile", atCall: 2, pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "marker-prepare-rename",
      rule: { method: "rename", atCall: 1, pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-write",
      rule: { method: "writeText", atCall: 3, pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-fsync",
      rule: { method: "fsyncFile", atCall: 3, pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-rename",
      rule: { method: "rename", atCall: 2, pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-fsync-dir",
      rule: { method: "fsyncDir", atCall: 3, pathIncludes: `${path.sep}state`, code: "EIO" }
    }
  ];

  for (const boundary of boundaries) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `q1a-r1-j06-${boundary.name}-`));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);

    const fsAdapter = new InstrumentedFilesystemAdapter();
    const processAdapter = new CountingProcessAdapter(
      2106,
      "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      "1".repeat(64),
      100
    );
    const seeded = await seedValidState(fsAdapter, processAdapter, config);
    await saveState(fsAdapter, config, seeded);
    await fsAdapter.remove(path.join(config.paths.setup_state_dir, "state.json"));
    await fsAdapter.writeText(
      path.join(config.paths.setup_state_dir, "recovery-required.json"),
      `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
      0o600
    );
    fsAdapter.setFailureRules([boundary.rule]);

    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:40:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );

    const firstRecover = await engine.run("recover", { configPath });
    assert.equal(fsAdapter.getTriggeredFailures(), 1, `${boundary.name}: fault injection did not trigger`);
    assert.notEqual(firstRecover.exitCode, ExitCode.Success, `${boundary.name}: ${JSON.stringify(firstRecover.envelope)}`);

    fsAdapter.setFailureRules([]);
    const resumeEngine = new SetupEngine(
      {
        fsAdapter,
        processAdapter: new CountingProcessAdapter(
          2206,
          "f324dcd7-4035-4430-ab39-ce31f9e396bf",
          "1".repeat(64),
          100
        ),
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:41:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );
    let secondRecover = await resumeEngine.run("recover", { configPath });
    if (
      secondRecover.exitCode === ExitCode.LockOwnedByAnotherInstaller
      && secondRecover.envelope.error?.code === "stale_lock_detected"
    ) {
      const lockOnly = await resumeEngine.run("recover", { configPath, lockOnly: true });
      assert.equal(lockOnly.exitCode, ExitCode.Success, `${boundary.name}: ${JSON.stringify(lockOnly.envelope)}`);
      secondRecover = await resumeEngine.run("recover", { configPath });
    }
    assert.equal(secondRecover.exitCode, ExitCode.Success, `${boundary.name}: ${JSON.stringify(secondRecover.envelope)}`);

    const previousRaw = await fs.promises.readFile(
      path.join(config.paths.setup_state_dir, "state.json.previous"),
      "utf8"
    );
    const previousJson = JSON.parse(previousRaw) as SetupState;
    assert.equal(previousJson.installation_id, config.installation_id, `${boundary.name}: previous damaged`);
    assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), true);
    assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), false);
  }
});

test("J07 committed recovery with marker cleanup failure resumes idempotently", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j07-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2107,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const seeded = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, seeded);
  await fsAdapter.remove(path.join(config.paths.setup_state_dir, "state.json"));
  await fsAdapter.writeText(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
    0o600
  );
  fsAdapter.setFailureRules([
    {
      method: "remove",
      atCall: 1,
      pathIncludes: "recovery-required.json",
      code: "EIO"
    }
  ]);

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:50:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const firstRecover = await engine.run("recover", { configPath });
  assert.equal(firstRecover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(firstRecover.envelope));
  assert.equal(
    ["recovery_commit_pending_cleanup", "recovery_marker_clear_failed"].includes(firstRecover.envelope.error?.code ?? ""),
    true,
    JSON.stringify(firstRecover.envelope)
  );
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), true);

  const markerRaw = await fs.promises.readFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    "utf8"
  );
  const marker = JSON.parse(markerRaw) as RecoveryMarkerRecord;
  assert.equal(marker.recovery_commit?.phase, "primary_restored");

  fsAdapter.setFailureRules([]);
  const secondRecover = await engine.run("recover", { configPath });
  assert.equal(secondRecover.exitCode, ExitCode.Success, JSON.stringify(secondRecover.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "recovery-required.json")), false);

  const thirdRecover = await engine.run("recover", { configPath });
  assert.equal(thirdRecover.exitCode, ExitCode.Success, JSON.stringify(thirdRecover.envelope));
});

test("J08 malformed marker, oversized/growing journal and EACCES return typed bounded diagnostics", async () => {
  const malformedCases: Array<{ name: string; payload: string }> = [
    { name: "null", payload: "null\n" },
    { name: "array", payload: "[]\n" },
    { name: "scalar", payload: "\"bad\"\n" },
    { name: "missing-reason", payload: `${JSON.stringify({ schema_version: 1, observed_at: "2026-10-23T12:00:00.000Z" })}\n` }
  ];

  for (const markerCase of malformedCases) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `q1a-r1-j08-marker-${markerCase.name}-`));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(
      path.join(config.paths.setup_state_dir, "recovery-required.json"),
      markerCase.payload,
      "utf8"
    );
    const engine = new SetupEngine(
      {
        fsAdapter: new NodeFilesystemAdapter(),
        processAdapter: new CountingProcessAdapter(
          2108,
          "f324dcd7-4035-4430-ab39-ce31f9e396bf",
          "1".repeat(64),
          100
        ),
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );
    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, `${markerCase.name}: ${JSON.stringify(status.envelope)}`);
    assert.equal(status.envelope.error?.code, "recovery_marker_invalid", markerCase.name);
  }

  {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j08-eacces-"));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    const fsAdapter = new InstrumentedFilesystemAdapter([
      { method: "readTextBounded", atCall: 1, pathIncludes: "events.jsonl", code: "EACCES" }
    ]);
    await fsAdapter.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    await fsAdapter.writeText(path.join(config.paths.setup_state_dir, "events.jsonl"), "{}", 0o600);
    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter: new CountingProcessAdapter(
          2109,
          "f324dcd7-4035-4430-ab39-ce31f9e396bf",
          "1".repeat(64),
          100
        ),
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:00:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );
    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
    assert.equal(status.envelope.error?.code, "state_path_access_failed");
  }

  {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j08-growth-"));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    const fsAdapter = new InstrumentedFilesystemAdapter();
    await fsAdapter.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
    await fsAdapter.writeText(
      path.join(config.paths.setup_state_dir, "events.jsonl"),
      `${"x".repeat((1024 * 1024) + 256)}\n`,
      0o600
    );

    const evidence = await inspectStateEvidence(fsAdapter, config);
    assert.equal(evidence.journal.oversized, true);
    assert.equal(
      fsAdapter.calls.some((entry) => entry.method === "readText" && entry.path.endsWith("events.jsonl")),
      false
    );
    assert.equal(
      fsAdapter.calls.some((entry) => entry.method === "readTextBounded" && entry.path.endsWith("events.jsonl")),
      true
    );
  }
});

test("J09 fault injections assert exact hit and fail when disabled on fresh fixture", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j09-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const rule: FailureRule = {
    method: "rename",
    atCall: 2,
    pathIncludes: "state.json.tmp-",
    code: "EIO"
  };
  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2110,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const seeded = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, seeded);
  await fsAdapter.remove(path.join(config.paths.setup_state_dir, "state.json"));
  await fsAdapter.writeText(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
    0o600
  );
  fsAdapter.setFailureRules([rule]);
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T13:00:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const failed = await engine.run("recover", { configPath });
  assert.notEqual(failed.exitCode, ExitCode.Success, JSON.stringify(failed.envelope));
  assert.equal(fsAdapter.getTriggeredFailures(), 1);

  const cleanRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j09-clean-"));
  const cleanConfigPath = path.join(cleanRoot, "config", "setup.json");
  const cleanConfig = makeConfig(cleanRoot);
  await writeConfig(cleanConfigPath, cleanConfig);
  const cleanFsAdapter = new InstrumentedFilesystemAdapter();
  const cleanProcessAdapter = new CountingProcessAdapter(
    2111,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const cleanSeeded = await seedValidState(cleanFsAdapter, cleanProcessAdapter, cleanConfig);
  await saveState(cleanFsAdapter, cleanConfig, cleanSeeded);
  await cleanFsAdapter.remove(path.join(cleanConfig.paths.setup_state_dir, "state.json"));
  await cleanFsAdapter.writeText(
    path.join(cleanConfig.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(cleanConfig, {}), null, 2)}\n`,
    0o600
  );
  const cleanEngine = new SetupEngine(
    {
      fsAdapter: cleanFsAdapter,
      processAdapter: cleanProcessAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T13:01:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const recovered = await cleanEngine.run("recover", { configPath: cleanConfigPath });
  assert.equal(recovered.exitCode, ExitCode.Success, JSON.stringify(recovered.envelope));
});

test("J10 pending evidence blocks ordinary effects while cancel and read-only diagnostics remain available", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j10-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2112,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const seeded = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T13:10:00.000Z") }, config, "0.0.1");
  await saveState(fsAdapter, config, {
    ...seeded,
    in_flight_operation: {
      id: "s08-auth",
      stage_id: "S08",
      kind: "mutate",
      started_at: "2026-10-23T13:10:01.000Z"
    }
  });

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T13:10:02.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const auth = await engine.run("auth-login", { configPath });
  assert.equal(auth.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(auth.envelope));
  const smoke = await engine.run("smoke", { configPath, provider: "fake", fixture: "toy" });
  assert.equal(smoke.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(smoke.envelope));
  const inferDisable = await engine.run("inference-disable", { configPath });
  assert.equal(inferDisable.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(inferDisable.envelope));
  assert.equal(processAdapter.commandCalls.length, 0);

  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");
  const status = await engine.run("status", { configPath });
  assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
  const cancel = await engine.run("cancel", { configPath });
  assert.equal(cancel.exitCode, ExitCode.Success, JSON.stringify(cancel.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "cancel-request.json")), true);
});

test("J11 child writer lock barrier blocks recover and keeps reader non-mutating", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-j11-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), "{broken", "utf8");

  const distRoot = path.resolve(__dirname, "../..");
  const holderPath = path.join(root, "hold-lock.js");
  const holderScript = `
const fs = require("node:fs");
const path = require("node:path");
const { NodeFilesystemAdapter } = require(${JSON.stringify(path.join(distRoot, "src/adapters/filesystem.js"))});
const { acquireLock } = require(${JSON.stringify(path.join(distRoot, "src/core/lock.js"))});

class Proc {
  async runCommand() { return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }; }
  pid() { return process.pid; }
  uid() { return 1000; }
  username() { return "factory"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "1".repeat(64); }
  async processStartTicks() { return null; }
  isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const lock = await acquireLock(new NodeFilesystemAdapter(), new Proc(), config);
  process.stdout.write("LOCKED\\\\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    if (chunk.includes("release")) {
      await lock.release();
      process.exit(0);
    }
  });
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(2);
});
`;
  await fs.promises.writeFile(holderPath, holderScript, "utf8");

  const holder = spawn(process.execPath, [holderPath, configPath], { stdio: ["pipe", "pipe", "pipe"] });
  const stdoutChunks: string[] = [];
  holder.stdout.setEncoding("utf8");
  holder.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
  await once(holder.stdout, "data");

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    2113,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T13:20:10.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.LockOwnedByAnotherInstaller, JSON.stringify(recover.envelope));
  const beforeMutations = fsAdapter.getMutatingCalls().length;
  const status = await engine.run("status", { configPath });
  assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
  assert.equal(fsAdapter.getMutatingCalls().length, beforeMutations);

  holder.stdin.write("release\n");
  const [holderCode] = await once(holder, "exit") as [number | null];
  assert.equal(holderCode, 0, stdoutChunks.join(""));
});
