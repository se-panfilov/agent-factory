import { fixtureContextFiles } from "../helpers/r22-context";
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
  readStateCommitManifest,
  saveState,
  stateHash,
  type StateCommitManifest,
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
  atCall?: number;
  stackIncludes?: string;
  pathIncludes?: string;
  code: string;
  message?: string;
}

class InstrumentedFilesystemAdapter implements FilesystemAdapter {
  private readonly delegate = new NodeFilesystemAdapter();
  localLockSemantics(dir: string): Promise<boolean> { return this.delegate.localLockSemantics(dir); }
  private readonly callCounts = new Map<FsMethod, number>();
  private failureRules: FailureRule[];
  private readonly consumedRules = new Set<number>();
  private triggeredFailures = 0;
  readonly calls: Array<{ method: FsMethod; path: string }> = [];

  constructor(failureRules: FailureRule[] = []) {
    this.failureRules = failureRules;
  }

  setFailureRules(rules: FailureRule[]): void {
    this.failureRules = rules;
    this.callCounts.clear();
    this.consumedRules.clear();
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
    const matchingRuleIndex = this.failureRules.findIndex((rule, index) =>
      !this.consumedRules.has(index)
      && rule.method === method
      && (rule.atCall === undefined || rule.atCall === next)
      && (rule.stackIncludes === undefined || new Error().stack?.includes(rule.stackIncludes))
      && (rule.pathIncludes === undefined || targetPath.includes(rule.pathIncludes))
    );
    if (matchingRuleIndex >= 0) {
      const matchingRule = this.failureRules[matchingRuleIndex]!;
      this.consumedRules.add(matchingRuleIndex);
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

  async hostIdentity(): Promise<{ os: "ubuntu-24.04"; arch: "amd64" }> { return { os: "ubuntu-24.04", arch: "amd64" }; }
  async loginSessionId(): Promise<string> { return "injected-test-login"; }
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
  await fixtureContextFiles(config, config.selected_stages.some(id => ["S05","S06","S07","S08","S09","S10","S11","S13","S14"].includes(id)));
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
          : [{ action: "fixture.counter" as const,
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

function commitManifestPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "state-commit.json");
}

async function seedProvenMissingPrimaryFixture(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<{ candidateHash: string }> {
  const base = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, base);
  const candidateHash = stateHash(base);
  const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await appendEvent(fsAdapter, config, {
    operation_id: "proof-op",
    stage: "S01",
    code: "intent",
    message: "intent:proof-op",
    attempt_id: attemptId
  });
  await appendEvent(fsAdapter, config, {
    operation_id: "proof-op",
    stage: "S01",
    code: "effect",
    message: "effect:proof-op",
    attempt_id: attemptId
  });
  await appendEvent(fsAdapter, config, {
    operation_id: "proof-op",
    stage: "S01",
    code: "verify",
    message: "verify:verified",
    attempt_id: attemptId
  });
  const checkpoint = await appendEvent(fsAdapter, config, {
    operation_id: "proof-op",
    stage: "S01",
    code: "checkpoint",
    message: "checkpoint:verified",
    attempt_id: attemptId,
    state_hash: candidateHash
  });
  const manifest = await readStateCommitManifest(fsAdapter, config);
  assert.ok(manifest !== null);
  const proven: StateCommitManifest = {
    ...manifest,
    last_effect_checkpoint: {
      attempt_id: attemptId,
      operation_id: "proof-op",
      stage: "S01",
      state_hash: candidateHash,
      sequence: checkpoint.sequence,
      updated_at: "2026-10-23T12:00:00.000Z"
    }
  };
  await fs.promises.writeFile(commitManifestPath(config), `${JSON.stringify(proven, null, 2)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
  return { candidateHash };
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
    { id: "quarantine-dir-fsync", rule: { method: "fsyncDir", stackIncludes: "restorePrimaryState", pathIncludes: `${path.sep}state`, code: "EIO" } }
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
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-04-independent-"));
    const config = makeConfig(root), fsAdapter = new InstrumentedFilesystemAdapter();
    const processAdapter = new CountingProcessAdapter(2004, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100);
    const base = await initState(fsAdapter, processAdapter, { now: () => new Date("2026-10-23T12:00:00Z") }, config, "0.0.1");
    await saveState(fsAdapter, config, base);
    const upgraded: SetupState = { ...base, in_flight_operation: { id: "s01-op", stage_id: "S01", kind: "mutate", started_at: "2026-10-23T12:01:00Z" } };
    const baseHash = stateHash(base), upgradedHash = stateHash(upgraded);
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
      assert.equal(
        loadError?.code === "recovery_required"
          || loadError?.code === "state_recovery_required"
          || loadError?.code === "state_generation_mismatch"
          || loadError?.code === "state_commit_manifest_missing"
          || loadError?.code === "state_commit_manifest_invalid",
        true
      );
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
  const fsAdapter = new NodeFilesystemAdapter();
  await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);

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
  async hostIdentity() { return {os:"ubuntu-24.04",arch:"amd64"}; }
  async loginSessionId() { return "injected-test-login"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "1".repeat(64); }
  async processStartTicks() { return 1; }
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

  const cancelHandle = await acquireLock(new NodeFilesystemAdapter(), processAdapter, config);
  const cancel = await engine.run("cancel", { configPath });
  assert.equal(cancel.exitCode, ExitCode.Success, JSON.stringify(cancel.envelope));
  assert.equal(
    fs.existsSync(path.join(config.paths.setup_state_dir, "cancel-request.json")),
    true
  );

  await cancelHandle.release();
  const lockDir = path.join(config.paths.setup_state_dir, "lock");
  await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({
      boot_id: "f324dcd7-4035-4430-ab39-ce31f9e396bf",
      pid: 999999,
      process_start_ticks: 1,
      nonce: "27c6a948-98df-4342-9bc8-841be871a61b",
      installation_id: config.installation_id,
      created_at: "2026-10-23T12:00:00.000Z"
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
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
      rule: { method: "writeText", pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "marker-prepare-fsync",
      rule: { method: "fsyncFile", pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "marker-prepare-rename",
      rule: { method: "rename", pathIncludes: "recovery-required.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-write",
      rule: { method: "writeText", pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-fsync",
      rule: { method: "fsyncFile", pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-rename",
      rule: { method: "rename", pathIncludes: "state.json.tmp-", code: "EIO" }
    },
    {
      name: "primary-fsync-dir",
      rule: { method: "fsyncDir", stackIncludes: "restorePrimaryState", pathIncludes: `${path.sep}state`, code: "EIO" }
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
    await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);
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
    assert.equal(firstRecover.exitCode, ExitCode.DriftOrRecoveryRequired, `${boundary.name}: ${JSON.stringify(firstRecover.envelope)}`);

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
  await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);
  fsAdapter.setFailureRules([
    {
      method: "remove",
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
  await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);
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
  await seedProvenMissingPrimaryFixture(cleanFsAdapter, cleanProcessAdapter, cleanConfig);
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
  const cancelHandle = await acquireLock(fsAdapter, processAdapter, config);
  const cancel = await engine.run("cancel", { configPath });
  assert.equal(cancel.exitCode, ExitCode.Success, JSON.stringify(cancel.envelope));
  await cancelHandle.release();
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
  async hostIdentity() { return {os:"ubuntu-24.04",arch:"amd64"}; }
  async loginSessionId() { return "injected-test-login"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "1".repeat(64); }
  async processStartTicks() { return 1; }
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

test("K10 cross-process interrupted writer keeps reader non-mutating and blocks unsafe recovery", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k10-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effect", "k10.txt");
  const readyPath = path.join(root, "ipc", "writer-ready");
  const releasePath = path.join(root, "ipc", "writer-release");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const engineModulePath = path.resolve(__dirname, "../../src/core/engine.js");
  const planModulePath = path.resolve(__dirname, "../../src/core/plan.js");
  const fsModulePath = path.resolve(__dirname, "../../src/adapters/filesystem.js");

  const writerPath = path.join(root, "writer.js");
  const writerScript = `
const fs = require("node:fs");
const path = require("node:path");

const [configPath, effectPath, readyPath, releasePath, engineModulePath, planModulePath, fsModulePath] = process.argv.slice(2);
const { SetupEngine } = require(engineModulePath);
const { createRegistry } = require(planModulePath);
const { NodeFilesystemAdapter } = require(fsModulePath);

class ProcessAdapterImpl {
  async runCommand() { return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }; }
  pid() { return process.pid; }
  uid() { return 1000; }
  username() { return "factory"; }
  async hostIdentity() { return {os:"ubuntu-24.04",arch:"amd64"}; }
  async loginSessionId() { return "injected-test-login"; }
  async bootId() { return "f324dcd7-4035-4430-ab39-ce31f9e396bf"; }
  async machineIdHash() { return "${"1".repeat(64)}"; }
  async processStartTicks(pid) { return pid === process.pid ? 1 : null; }
  isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
}

class HttpAdapterImpl {
  async get() { return { statusCode: 200, headers: {}, body: Buffer.from("") }; }
}

function makeS00() {
  return {
    id: "S00",
    dependencies: [],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return { stageId: "S00", status: "verified", checks: { ok: true }, versions: {}, observedAt: new Date().toISOString() };
    },
    plan() {
      return { stageId: "S00", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
    },
    async apply() { return []; },
    async verify() { return []; },
    async recover() { return []; }
  };
}

function makeWriterStage() {
  return {
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
        operations: [{
          id: "k10-op",
          stageId: "S01",
          action: "fixture.counter", kind: "mutate",
          resourceId: "k10-resource",
          risk: "low",
          gateIds: [],
          preconditions: [],
          sideEffects: ["write effect"],
          timeoutSec: 60,
          retryable: false
        }],
        requiredGates: []
      };
    },
    async apply() {
      await fs.promises.mkdir(path.dirname(effectPath), { recursive: true });
      await fs.promises.mkdir(path.dirname(readyPath), { recursive: true });
      await fs.promises.writeFile(effectPath, "effect\\n", "utf8");
      await fs.promises.writeFile(readyPath, "ready\\n", "utf8");
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() > deadline) {
          throw new Error("release timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return [{
        operationId: "k10-op",
        stageId: "S01",
        resourceId: "k10-resource",
        observedAt: new Date().toISOString(),
        checks: { applied: true },
        versions: {},
        artifacts: [effectPath]
      }];
    },
    async verify() {
      return [];
    },
    async recover() {
      return [];
    }
  };
}

async function main() {
  const engine = new SetupEngine(
    {
      fsAdapter: new NodeFilesystemAdapter(),
      processAdapter: new ProcessAdapterImpl(),
      httpAdapter: new HttpAdapterImpl(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:40:00.000Z") }
    },
    createRegistry([makeS00(), makeWriterStage()])
  );
  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  if (plan.exitCode !== 0 || typeof plan.envelope.data?.plan_path !== "string") {
    console.error(JSON.stringify(plan));
    process.exit(20);
    return;
  }
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data.plan_path,
    nonInteractive: true
  });
  console.log(JSON.stringify(apply));
  process.exit(apply.exitCode === 0 ? 0 : 21);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(22);
});
`;
  await fs.promises.writeFile(writerPath, writerScript, "utf8");

  const child = spawn(process.execPath, [
    writerPath,
    configPath,
    effectPath,
    readyPath,
    releasePath,
    engineModulePath,
    planModulePath,
    fsModulePath
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const childStderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => childStderr.push(chunk.toString("utf8")));

  const waitDeadline = Date.now() + 30_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() > waitDeadline) {
      throw new Error(`writer did not reach barrier: ${childStderr.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const parentFs = new InstrumentedFilesystemAdapter();
  const parentProcess = new CountingProcessAdapter(
    3101,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const parentEngine = new SetupEngine(
    {
      fsAdapter: parentFs,
      processAdapter: parentProcess,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:41:00.000Z") }
    },
    createRegistry([makeS00(), makeMutatingStage(effectPath)])
  );

  const statusDuringWrite = await parentEngine.run("status", { configPath });
  assert.equal(statusDuringWrite.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(statusDuringWrite.envelope));
  assert.equal(
    ["journal_recovery_required", "recovery_required", "state_recovery_required"].includes(statusDuringWrite.envelope.error?.code ?? ""),
    true,
    JSON.stringify(statusDuringWrite.envelope)
  );
  assert.deepEqual(parentFs.getMutatingCalls().map((entry) => entry.method), []);

  child.kill("SIGKILL");
  const [childCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(signal === "SIGKILL" || childCode !== 0, true, childStderr.join(""));
  assert.equal(fs.existsSync(effectPath), true);

  const lockOnly = await parentEngine.run("recover", { configPath, lockOnly: true });
  assert.equal(lockOnly.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(lockOnly.envelope));
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "lock")), true);
  // Explicit harness-only manual lock reconciliation after confirmed SIGKILL; product refused takeover.
  await fs.promises.rename(path.join(config.paths.setup_state_dir, "lock"), path.join(config.paths.setup_state_dir, "lock.manual-k10"));

  const recover = await parentEngine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(
    ["recovery_unresolved", "state_recovery_required", "in_flight_operation_present", "journal_recovery_required"].includes(recover.envelope.error?.code ?? ""),
    true,
    JSON.stringify(recover.envelope)
  );

  const evidence = await inspectStateEvidence(new NodeFilesystemAdapter(), config);
  assert.equal(evidence.journal.unresolvedOperationIds.includes("k10-op"), true);
  const rawState = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8");
  const parsedState = JSON.parse(rawState) as SetupState;
  assert.ok(parsedState.in_flight_operation !== null);
});

test("K01 stale primary plus completed journal checkpoint remains recovery-blocked", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k01-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effect", "k01.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    3001,
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
      clock: { now: () => new Date("2026-10-23T14:00:00.000Z") }
    },
    createRegistry([makeS00(), makeMutatingStage(effectPath)])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const initialRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8");
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data?.plan_path as string,
    nonInteractive: true
  });
  assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));
  assert.equal(fs.existsSync(effectPath), true);

  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), initialRaw, "utf8");

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(
    ["state_generation_mismatch", "state_checkpoint_proof_mismatch", "recovery_unresolved"].includes(recover.envelope.error?.code ?? ""),
    true
  );

  const planAfter = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(planAfter.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(planAfter.envelope));
  assert.equal(
    ["state_generation_mismatch", "state_checkpoint_proof_mismatch", "recovery_required", "state_recovery_required"].includes(planAfter.envelope.error?.code ?? ""),
    true
  );
});

test("K04 prepared recovery decision is immutable across previous/current substitution", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k04-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    3002,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);
  fsAdapter.setFailureRules([{ method: "writeText", pathIncludes: "state.json.tmp-", code: "EIO" }]);

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:05:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const interrupted = await engine.run("recover", { configPath });
  assert.equal(interrupted.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(interrupted.envelope));
  assert.equal(interrupted.envelope.error?.code, "recovery_primary_persist_failed");

  const markerBeforeRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "recovery-required.json"), "utf8");
  const markerBefore = JSON.parse(markerBeforeRaw) as RecoveryMarkerRecord;
  assert.equal(markerBefore.recovery_commit?.phase, "prepared");
  const preparedHash = markerBefore.recovery_commit?.candidate_state_hash ?? "";

  const previousRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json.previous"), "utf8");
  const previousState = JSON.parse(previousRaw) as SetupState;
  const rewrittenPrevious: SetupState = {
    ...previousState,
    last_error: {
      code: "mutated",
      stage: "S01",
      operation_id: "mutated",
      retryable: false,
      public_message: "mutated",
      next_action: "mutated",
      evidence_ref: "mutated"
    }
  };
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "state.json.previous"),
    `${JSON.stringify(rewrittenPrevious, null, 2)}\n`,
    "utf8"
  );

  fsAdapter.setFailureRules([]);
  const afterPreviousSwap = await engine.run("recover", { configPath });
  assert.equal(afterPreviousSwap.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(afterPreviousSwap.envelope));
  assert.equal(afterPreviousSwap.envelope.error?.code, "recovery_unresolved");
  const markerAfterPreviousSwapRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "recovery-required.json"), "utf8");
  const markerAfterPreviousSwap = JSON.parse(markerAfterPreviousSwapRaw) as RecoveryMarkerRecord;
  assert.equal(markerAfterPreviousSwap.recovery_commit?.candidate_state_hash, preparedHash);

  const foreignCurrent: SetupState = {
    ...previousState,
    in_flight_operation: {
      id: "unknown-op",
      stage_id: "S02",
      kind: "mutate",
      started_at: "2026-10-23T14:06:00.000Z"
    }
  };
  await fs.promises.writeFile(path.join(config.paths.setup_state_dir, "state.json"), `${JSON.stringify(foreignCurrent, null, 2)}\n`, "utf8");
  const stateBefore = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8");
  const afterCurrentSwap = await engine.run("recover", { configPath });
  assert.equal(afterCurrentSwap.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(afterCurrentSwap.envelope));
  assert.equal(afterCurrentSwap.envelope.error?.code, "recovery_unresolved");
  const stateAfter = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8");
  assert.equal(stateAfter, stateBefore);
});

test("K05 missing primary with old previous and empty journal remains unresolved without generation proof", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k05-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    3003,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  const base = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, {
    ...base,
    last_error: {
      code: "newer",
      stage: "S01",
      operation_id: "newer",
      retryable: false,
      public_message: "newer",
      next_action: "newer",
      evidence_ref: "newer"
    }
  });
  await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:10:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(recover.envelope.error?.code, "recovery_unresolved");
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), false);
});

test("T04 newer manifest generation blocks old checkpoint recovery candidate", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t04-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new NodeFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    3204,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );

  const base = await seedValidState(fsAdapter, processAdapter, config);
  await saveState(fsAdapter, config, base);
  const oldHash = stateHash(base);
  const attemptId = "c0ffee00-0000-4000-8000-000000000001";
  await appendEvent(fsAdapter, config, {
    operation_id: "t04-op",
    stage: "S01",
    code: "intent",
    message: "intent:t04-op",
    attempt_id: attemptId
  });
  await appendEvent(fsAdapter, config, {
    operation_id: "t04-op",
    stage: "S01",
    code: "effect",
    message: "effect:t04-op",
    attempt_id: attemptId
  });
  await appendEvent(fsAdapter, config, {
    operation_id: "t04-op",
    stage: "S01",
    code: "verify",
    message: "verify:t04-op",
    attempt_id: attemptId
  });
  const checkpoint = await appendEvent(fsAdapter, config, {
    operation_id: "t04-op",
    stage: "S01",
    code: "checkpoint",
    message: "checkpoint:t04-op",
    attempt_id: attemptId,
    state_hash: oldHash
  });
  const manifestBefore = await readStateCommitManifest(fsAdapter, config);
  assert.ok(manifestBefore !== null);
  await fs.promises.writeFile(
    commitManifestPath(config),
    `${JSON.stringify({
      ...manifestBefore,
      last_effect_checkpoint: {
        attempt_id: attemptId,
        operation_id: "t04-op",
        stage: "S01",
        state_hash: oldHash,
        sequence: checkpoint.sequence,
        updated_at: "2026-10-23T12:00:00.000Z"
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const newerState: SetupState = {
    ...base,
    in_flight_operation: {
      id: "t04-newer-unknown",
      stage_id: "S01",
      kind: "mutate",
      started_at: "2026-10-23T12:10:00.000Z"
    }
  };
  await saveState(fsAdapter, config, newerState);
  const newerHash = stateHash(newerState);
  assert.notEqual(newerHash, oldHash);
  const manifestAfterNewer = await readStateCommitManifest(fsAdapter, config);
  assert.ok(manifestAfterNewer !== null);
  assert.equal(manifestAfterNewer.last_state_hash, newerHash);
  assert.equal(manifestAfterNewer.last_effect_checkpoint?.state_hash, oldHash);

  await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "recovery-required.json"),
    `${JSON.stringify(recoveryMarkerBody(config, {}), null, 2)}\n`,
    "utf8"
  );

  const engine = new SetupEngine(
    {
      fsAdapter,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:20:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const recover = await engine.run("recover", { configPath });
  assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
  assert.equal(recover.envelope.error?.code, "recovery_unresolved");
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), false);
  assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json.previous")), true);
  const manifestFinal = await readStateCommitManifest(fsAdapter, config);
  assert.ok(manifestFinal !== null);
  assert.equal(manifestFinal.last_state_hash, newerHash);
  assert.equal(manifestFinal.last_effect_checkpoint?.state_hash, oldHash);
});

test("T05 manifest-only evidence never reinitializes fresh state and malformed/foreign manifests stay blocked", async () => {
  const processAdapter = new CountingProcessAdapter(
    3205,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );

  {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t05-manifest-only-"));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);

    const fsAdapter = new NodeFilesystemAdapter();
    const base = await seedValidState(fsAdapter, processAdapter, config);
    const unknownState: SetupState = {
      ...base,
      in_flight_operation: {
        id: "t05-unknown",
        stage_id: "S01",
        kind: "mutate",
        started_at: "2026-10-23T12:00:00.000Z"
      }
    };
    await saveState(fsAdapter, config, unknownState);
    const manifestBefore = await readStateCommitManifest(fsAdapter, config);
    assert.ok(manifestBefore !== null);

    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json.previous"), { force: true });

    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:30:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );

    const recover = await engine.run("recover", { configPath });
    assert.equal(recover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(recover.envelope));
    assert.equal(recover.envelope.error?.code, "recovery_unresolved");

    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));

    const plan = await engine.run("plan", { configPath, stageId: "S01" });
    assert.equal(plan.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(plan.envelope));

    assert.equal(fs.existsSync(path.join(config.paths.setup_state_dir, "state.json")), false);
    const manifestAfter = await readStateCommitManifest(fsAdapter, config);
    assert.ok(manifestAfter !== null);
    assert.equal(manifestAfter.last_state_hash, manifestBefore.last_state_hash);
  }

  {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t05-manifest-malformed-"));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    const fsAdapter = new NodeFilesystemAdapter();
    await seedValidState(fsAdapter, processAdapter, config);
    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json.previous"), { force: true });
    await fs.promises.writeFile(commitManifestPath(config), "{broken\n", "utf8");

    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:35:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );
    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
    assert.equal(status.envelope.error?.code, "state_commit_manifest_invalid");
  }

  {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t05-manifest-foreign-"));
    const configPath = path.join(root, "config", "setup.json");
    const config = makeConfig(root);
    await writeConfig(configPath, config);
    const fsAdapter = new NodeFilesystemAdapter();
    await seedValidState(fsAdapter, processAdapter, config);
    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json"), { force: true });
    await fs.promises.rm(path.join(config.paths.setup_state_dir, "state.json.previous"), { force: true });
    const manifest = await readStateCommitManifest(fsAdapter, config);
    assert.ok(manifest !== null);
    await fs.promises.writeFile(
      commitManifestPath(config),
      `${JSON.stringify({
        ...manifest,
        installation_id: "f0000000-0000-4000-8000-000000000000"
      }, null, 2)}\n`,
      "utf8"
    );

    const engine = new SetupEngine(
      {
        fsAdapter,
        processAdapter,
        httpAdapter: new FakeHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T12:37:00.000Z") }
      },
      createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
    );
    const status = await engine.run("status", { configPath });
    assert.equal(status.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(status.envelope));
    assert.equal(status.envelope.error?.code, "state_commit_manifest_foreign");
  }
});

test("T06 primary_restored cleanup admission blocks conflicting quarantine evidence before marker removal", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t06-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const fsAdapter = new InstrumentedFilesystemAdapter();
  const processAdapter = new CountingProcessAdapter(
    3206,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );
  await seedProvenMissingPrimaryFixture(fsAdapter, processAdapter, config);
  fsAdapter.setFailureRules([
    {
      method: "remove",
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
      clock: { now: () => new Date("2026-10-23T12:40:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );

  const firstRecover = await engine.run("recover", { configPath });
  assert.equal(firstRecover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(firstRecover.envelope));
  const markerPath = path.join(config.paths.setup_state_dir, "recovery-required.json");
  const markerRaw = await fs.promises.readFile(markerPath, "utf8");
  const marker = JSON.parse(markerRaw) as RecoveryMarkerRecord;
  assert.equal(marker.recovery_commit?.phase, "primary_restored");

  const conflictState: SetupState = {
    ...JSON.parse(await fs.promises.readFile(path.join(config.paths.setup_state_dir, "state.json"), "utf8")) as SetupState,
    in_flight_operation: {
      id: "t06-quarantine-unknown",
      stage_id: "S01",
      kind: "mutate",
      started_at: "2026-10-23T12:41:00.000Z"
    }
  };
  const quarantinePath = path.join(config.paths.setup_state_dir, "state.json.corrupt-t06");
  await fs.promises.writeFile(quarantinePath, `${JSON.stringify(conflictState, null, 2)}\n`, "utf8");

  fsAdapter.setFailureRules([]);
  const secondRecover = await engine.run("recover", { configPath });
  assert.equal(secondRecover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(secondRecover.envelope));
  assert.equal(secondRecover.envelope.error?.code, "recovery_unresolved");
  assert.equal(fs.existsSync(markerPath), true);
  assert.equal(fs.existsSync(quarantinePath), true);
});

test("T07 proven recovery works directly and after marker written by plan, while ambiguous case stays blocked", async () => {
  const processAdapter = new CountingProcessAdapter(
    3207,
    "f324dcd7-4035-4430-ab39-ce31f9e396bf",
    "1".repeat(64),
    100
  );

  const directRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t07-direct-"));
  const directConfigPath = path.join(directRoot, "config", "setup.json");
  const directConfig = makeConfig(directRoot);
  await writeConfig(directConfigPath, directConfig);
  const directFs = new NodeFilesystemAdapter();
  await seedProvenMissingPrimaryFixture(directFs, processAdapter, directConfig);
  await fs.promises.rm(path.join(directConfig.paths.setup_state_dir, "recovery-required.json"), { force: true });
  const directCandidateHash = stateHash(
    JSON.parse(await fs.promises.readFile(path.join(directConfig.paths.setup_state_dir, "state.json.previous"), "utf8")) as SetupState
  );
  const directEngine = new SetupEngine(
    {
      fsAdapter: directFs,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:50:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const directRecover = await directEngine.run("recover", { configPath: directConfigPath });
  assert.equal(directRecover.exitCode, ExitCode.Success, JSON.stringify(directRecover.envelope));
  const directState = JSON.parse(
    await fs.promises.readFile(path.join(directConfig.paths.setup_state_dir, "state.json"), "utf8")
  ) as SetupState;
  const directHash = stateHash(directState);
  assert.equal(directHash, directCandidateHash);

  const planFirstRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t07-plan-first-"));
  const planFirstConfigPath = path.join(planFirstRoot, "config", "setup.json");
  const planFirstConfig = makeConfig(planFirstRoot);
  await writeConfig(planFirstConfigPath, planFirstConfig);
  const planFirstFs = new NodeFilesystemAdapter();
  await seedProvenMissingPrimaryFixture(planFirstFs, processAdapter, planFirstConfig);
  await fs.promises.rm(path.join(planFirstConfig.paths.setup_state_dir, "recovery-required.json"), { force: true });
  const planFirstCandidateHash = stateHash(
    JSON.parse(await fs.promises.readFile(path.join(planFirstConfig.paths.setup_state_dir, "state.json.previous"), "utf8")) as SetupState
  );
  const planFirstEngine = new SetupEngine(
    {
      fsAdapter: planFirstFs,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:52:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const planFirst = await planFirstEngine.run("plan", { configPath: planFirstConfigPath, stageId: "S01" });
  assert.equal(planFirst.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(planFirst.envelope));
  const markerRaw = await fs.promises.readFile(path.join(planFirstConfig.paths.setup_state_dir, "recovery-required.json"), "utf8");
  const marker = JSON.parse(markerRaw) as RecoveryMarkerRecord;
  assert.equal(marker.reason, "state_missing_with_recovery_evidence");

  const recoverAfterPlan = await planFirstEngine.run("recover", { configPath: planFirstConfigPath });
  assert.equal(recoverAfterPlan.exitCode, ExitCode.Success, JSON.stringify(recoverAfterPlan.envelope));
  const recoveredAfterPlan = JSON.parse(
    await fs.promises.readFile(path.join(planFirstConfig.paths.setup_state_dir, "state.json"), "utf8")
  ) as SetupState;
  assert.equal(stateHash(recoveredAfterPlan), planFirstCandidateHash);

  const ambiguousRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-t07-ambiguous-"));
  const ambiguousConfigPath = path.join(ambiguousRoot, "config", "setup.json");
  const ambiguousConfig = makeConfig(ambiguousRoot);
  await writeConfig(ambiguousConfigPath, ambiguousConfig);
  const ambiguousFs = new NodeFilesystemAdapter();
  const base = await seedValidState(ambiguousFs, processAdapter, ambiguousConfig);
  await saveState(ambiguousFs, ambiguousConfig, {
    ...base,
    in_flight_operation: {
      id: "t07-ambiguous",
      stage_id: "S01",
      kind: "mutate",
      started_at: "2026-10-23T12:53:00.000Z"
    }
  });
  await fs.promises.rm(path.join(ambiguousConfig.paths.setup_state_dir, "state.json"), { force: true });

  const ambiguousEngine = new SetupEngine(
    {
      fsAdapter: ambiguousFs,
      processAdapter,
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T12:54:00.000Z") }
    },
    createRegistry([makeS00(), makeNoopStage("S01", ["S00"])])
  );
  const ambiguousPlan = await ambiguousEngine.run("plan", { configPath: ambiguousConfigPath, stageId: "S01" });
  assert.equal(ambiguousPlan.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(ambiguousPlan.envelope));
  const ambiguousRecover = await ambiguousEngine.run("recover", { configPath: ambiguousConfigPath });
  assert.equal(ambiguousRecover.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(ambiguousRecover.envelope));
  assert.equal(ambiguousRecover.envelope.error?.code, "recovery_unresolved");
});

test("K07 receipts must match planned operation/stage/resource and cannot be foreign", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k07-"));
  const configPath = path.join(root, "config", "setup.json");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  const foreignStage: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: "planned",
        checks: { staged: true },
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
          { action: "fixture.counter" as const,
            id: "op-a",
            stageId: "S01",
             kind: "mutate",
            resourceId: "resource-a",
            risk: "low",
            gateIds: [],
            preconditions: [],
            sideEffects: [],
            timeoutSec: 5,
            retryable: false
          },
          { action: "fixture.counter" as const,
            id: "op-b",
            stageId: "S01",
             kind: "mutate",
            resourceId: "resource-b",
            risk: "low",
            gateIds: [],
            preconditions: [],
            sideEffects: [],
            timeoutSec: 5,
            retryable: false
          }
        ],
        requiredGates: []
      };
    },
    async apply() {
      return [
        {
          operationId: "foreign-op",
          stageId: "S12",
          resourceId: "foreign-resource",
          observedAt: new Date().toISOString(),
          checks: { forged: true },
          versions: {},
          artifacts: []
        }
      ];
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
      processAdapter: new CountingProcessAdapter(
        3004,
        "f324dcd7-4035-4430-ab39-ce31f9e396bf",
        "1".repeat(64),
        100
      ),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:20:00.000Z") }
    },
    createRegistry([makeS00(), foreignStage])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data?.plan_path as string,
    nonInteractive: true
  });
  assert.equal(apply.exitCode, ExitCode.DriftOrRecoveryRequired, JSON.stringify(apply.envelope));
  assert.equal(
    ["stage_effect_receipt_stage_mismatch", "stage_effect_receipt_unplanned", "stage_effect_receipt_missing"].includes(apply.envelope.error?.code ?? ""),
    true
  );
  const journalRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "events.jsonl"), "utf8");
  assert.equal(journalRaw.includes("\"code\":\"checkpoint\""), false);
});

test("K09 empty or verify-only plan does not call stage.apply (trap stage)", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r1-k09-"));
  const configPath = path.join(root, "config", "setup.json");
  const effectPath = path.join(root, "effect", "trap.txt");
  const config = makeConfig(root);
  await writeConfig(configPath, config);

  let applyCalls = 0;
  const trapStage: StageModule = {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: "S01",
        status: "verified",
        checks: { noop: true },
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
    async apply() {
      applyCalls += 1;
      await fs.promises.mkdir(path.dirname(effectPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(effectPath, "trap\n", "utf8");
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
      processAdapter: new CountingProcessAdapter(
        3005,
        "f324dcd7-4035-4430-ab39-ce31f9e396bf",
        "1".repeat(64),
        100
      ),
      httpAdapter: new FakeHttpAdapter(),
      installerVersion: "0.0.1",
      clock: { now: () => new Date("2026-10-23T14:30:00.000Z") }
    },
    createRegistry([makeS00(), trapStage, makeNoopStage("S12", ["S01"])])
  );

  const plan = await engine.run("plan", { configPath, stageId: "S01" });
  assert.equal(plan.exitCode, ExitCode.Success, JSON.stringify(plan.envelope));
  const apply = await engine.run("apply", {
    configPath,
    planPath: plan.envelope.data?.plan_path as string,
    nonInteractive: true
  });
  assert.equal(apply.exitCode, ExitCode.Success, JSON.stringify(apply.envelope));
  assert.equal(applyCalls, 0);
  assert.equal(fs.existsSync(effectPath), false);
});

async function r14CoreFixture(fsAdapter: FilesystemAdapter = new NodeFilesystemAdapter()) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "q1a-r14-core-"));
  const config = makeConfig(root), configPath = path.join(root, "config.json"), effectPath = path.join(root, "effect");
  await writeConfig(configPath, config);
  const processAdapter = new CountingProcessAdapter(3301, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100);
  let effects = 0;
  const stage = makeMutatingStage(effectPath), apply = stage.apply.bind(stage);
  stage.apply = async (ctx, plan) => { effects++; return apply(ctx, plan); };
  const engine = new SetupEngine({ fsAdapter, processAdapter, clock: { now: () => new Date("2026-10-24T10:00:00Z") } }, createRegistry([makeS00(), stage]));
  const plan = () => engine.run("plan", { configPath });
  const runApply = () => engine.run("apply", { configPath, planPath: path.join(config.paths.setup_state_dir, "plan.json") });
  return { root, config, configPath, effectPath, engine, stage, plan, runApply, effects: () => effects };
}
async function r14EvidenceBytes(config: SetupConfig) {
  const result: Record<string, string | null> = {};
  for (const file of ["state.json", "state.json.previous", "state-commit.json", "events.jsonl", "recovery-required.json"]) {
    try { result[file] = await fs.promises.readFile(path.join(config.paths.setup_state_dir, file), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; result[file] = null; }
  }
  return result;
}
for (const mode of ["direct", "plan-first"] as const) {
  test(`U03 C01 engine-generated plan-apply-plan recovery ${mode} retains final proof without replay`, async () => {
    const x = await r14CoreFixture();
    assert.equal((await x.plan()).exitCode, 0); assert.equal((await x.runApply()).exitCode, 0);
    const manifestBefore = await readStateCommitManifest(new NodeFilesystemAdapter(), x.config);
    assert.ok(manifestBefore?.clean_proof);
    await x.plan();
    const primary = path.join(x.config.paths.setup_state_dir, "state.json");
    const expected = await fs.promises.readFile(`${primary}.previous`, "utf8");
    await fs.promises.unlink(primary);
    if (mode === "plan-first") assert.equal((await x.plan()).exitCode, 8);
    const outcome = await x.engine.run("recover", { configPath: x.configPath });
    assert.equal(outcome.exitCode, 8);
    assert.equal(outcome.envelope.error?.code, "context_review_unproven");
    assert.equal(outcome.envelope.data?.review_required, true);
    assert.equal(await fs.promises.readFile(primary, "utf8"), expected);
    const recovered = await readStateCommitManifest(new NodeFilesystemAdapter(), x.config);
    assert.deepEqual(recovered?.last_effect_checkpoint, manifestBefore?.last_effect_checkpoint);
    assert.ok(recovered?.clean_proof?.snapshot_hashes.includes(stateHash(JSON.parse(expected) as SetupState)));
    const beforeRepeat = await r14EvidenceBytes(x.config);
    assert.equal((await x.engine.run("recover", { configPath: x.configPath })).exitCode, 8);
    assert.deepEqual(await r14EvidenceBytes(x.config), beforeRepeat);
    assert.equal((await x.plan()).exitCode, 0); assert.equal((await x.runApply()).exitCode, 0);
    assert.equal(x.effects(), 1, "resource observe prevents effect replay after proven restore");
  });
}
for (const phase of ["current", "missing", "prepared", "primary_restored"] as const) {
  for (const contradiction of ["quarantine", "attempt", "operation", "stage", "sequence", "hash", "previous", "journal", "generation", "manifest-missing", "manifest-malformed", "manifest-foreign", "manifest-unsupported", "decision"] as const) {
    test(`U05 admission ${phase}/${contradiction} refuses before state-evidence writes`, async () => {
      const instrumented = new InstrumentedFilesystemAdapter(), x = await r14CoreFixture(instrumented);
      assert.equal((await x.plan()).exitCode, 0); assert.equal((await x.runApply()).exitCode, 0); assert.equal((await x.plan()).exitCode, 0);
      const primary = path.join(x.config.paths.setup_state_dir, "state.json"), marker = path.join(x.config.paths.setup_state_dir, "recovery-required.json");
      if (phase !== "current") await fs.promises.unlink(primary);
      if (phase === "prepared" || phase === "primary_restored") {
        instrumented.setFailureRules([{ method: phase === "prepared" ? "writeText" : "remove", pathIncludes: phase === "prepared" ? "state.json.tmp-" : "recovery-required.json", code: "EIO" }]);
        const first = await x.engine.run("recover", { configPath: x.configPath });
        assert.equal(first.exitCode, 8, JSON.stringify(first)); assert.equal(instrumented.getTriggeredFailures(), 1);
        instrumented.setFailureRules([]);
        const decision = JSON.parse(await fs.promises.readFile(marker, "utf8")) as RecoveryMarkerRecord;
        assert.equal(decision.recovery_commit?.phase, phase);
      }
      const mPath = commitManifestPath(x.config);
      if (["attempt", "operation", "stage", "sequence", "hash", "generation"].includes(contradiction)) {
        const m = JSON.parse(await fs.promises.readFile(mPath, "utf8")) as StateCommitManifest;
        const cp = m.last_effect_checkpoint!;
        if (contradiction === "attempt") cp.attempt_id = "different-attempt";
        if (contradiction === "operation") cp.operation_id = "different-operation";
        if (contradiction === "stage") cp.stage = "S02";
        if (contradiction === "sequence") cp.sequence++;
        if (contradiction === "hash") cp.state_hash = "f".repeat(64);
        if (contradiction === "generation") { m.generation++; m.last_state_hash = "e".repeat(64); }
        await fs.promises.writeFile(mPath, JSON.stringify(m));
      }
      if (contradiction === "manifest-missing") await fs.promises.unlink(mPath);
      if (contradiction === "manifest-malformed") await fs.promises.writeFile(mPath, "{partial");
      if (contradiction === "manifest-foreign" || contradiction === "manifest-unsupported") {
        const m = JSON.parse(await fs.promises.readFile(mPath, "utf8")) as Record<string, unknown>;
        if (contradiction === "manifest-foreign") m.installation_id = "11111111-1111-4111-8111-111111111111";
        else m.schema_version = 2;
        await fs.promises.writeFile(mPath, JSON.stringify(m));
      }
      if (contradiction === "decision") {
        const original = phase === "prepared" || phase === "primary_restored" ? JSON.parse(await fs.promises.readFile(marker, "utf8")) as RecoveryMarkerRecord : recoveryMarkerBody(x.config, { recovery_commit: {
          phase: "prepared", source: "previous", candidate_state_hash: "f".repeat(64), updated_at: "2026-10-24T10:00:00Z",
          source_manifest: (await readStateCommitManifest(instrumented, x.config))! } });
        original.recovery_commit!.candidate_state_hash = "f".repeat(64);
        await fs.promises.writeFile(marker, JSON.stringify(original));
      }
      if (contradiction === "quarantine") await fs.promises.writeFile(`${primary}.corrupt-unknown`, "unknown-effect");
      if (contradiction === "previous") await fs.promises.writeFile(`${primary}.previous`, "{}");
      if (contradiction === "journal") await fs.promises.appendFile(path.join(x.config.paths.setup_state_dir, "events.jsonl"), "partial-unknown");
      const before = await r14EvidenceBytes(x.config);
      const result = await x.engine.run("recover", { configPath: x.configPath });
      assert.equal(result.exitCode, 8, JSON.stringify(result));
      assert.deepEqual(await r14EvidenceBytes(x.config), before, "immutable refusal including decision and manifest");
      if (phase === "current") {
        assert.equal((await x.plan()).exitCode, 8); assert.deepEqual(await r14EvidenceBytes(x.config), before);
        assert.equal((await x.runApply()).exitCode, 8); assert.deepEqual(await r14EvidenceBytes(x.config), before);
      }
      if (contradiction === "quarantine") assert.equal(await fs.promises.readFile(`${primary}.corrupt-unknown`, "utf8"), "unknown-effect");
      assert.equal(x.effects(), 1);
    });
  }
}

function r14Digests(bytes: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(bytes).map(([p, body]) => [p, body === null ? null : createHash("sha256").update(body).digest("hex")]));
}
for (const phase of ["initial", "operation-binding", "final-commit"] as const) {
  for (const boundary of ["writeText", "fsyncFile", "rename", "fsyncDir"] as const) {
    for (const timing of ["before", "after", "control"] as const) {
      test(`U07 manifest ${phase}/${boundary}/${timing}: fresh fixture and fault-off control`, async () => {
        const delegate = new NodeFilesystemAdapter();
        let active: { temp: string; target?: string; phase: string } | undefined;
        let hits = 0, lastPath = "";
        async function around<T>(method: string, exactPath: string, action: () => Promise<T>): Promise<T> {
          const match = method === boundary && active?.phase === phase && timing !== "control" && hits === 0;
          if (match && timing === "before") { hits++; lastPath = exactPath; throw Object.assign(new Error("R14 injected manifest fault"), { code: method === "writeText" ? "ENOSPC" : "EIO" }); }
          const result = await action();
          if (match && timing === "after") { hits++; lastPath = exactPath; throw Object.assign(new Error("R14 injected manifest fault after artifact"), { code: method === "writeText" ? "ENOSPC" : "EIO" }); }
          return result;
        }
        const adapter = new Proxy(delegate, { get(target, key, receiver) {
          if (key === "writeText") return async (p: string, body: string, mode?: number) => {
            if (p.includes("state-commit.json.tmp-")) {
              const m = JSON.parse(body) as StateCommitManifest;
              active = { temp: p, phase: m.clean_proof !== undefined ? "final-commit" : m.last_effect_checkpoint !== undefined ? "operation-binding" : m.generation === 1 ? "initial" : "state-metadata" };
              return around("writeText", p, () => target.writeText(p, body, mode));
            }
            return target.writeText(p, body, mode);
          };
          if (key === "fsyncFile") return async (p: string) => active?.temp === p ? around("fsyncFile", p, () => target.fsyncFile(p)) : target.fsyncFile(p);
          if (key === "rename") return async (a: string, b: string) => {
            if (active?.temp === a) { active.target = b; return around("rename", `${a}->${b}`, () => target.rename(a, b)); }
            return target.rename(a, b);
          };
          if (key === "fsyncDir") return async (p: string) => {
            if (active?.target !== undefined && path.dirname(active.target) === p) {
              try { return await around("fsyncDir", `${active.target}:parent:${p}`, () => target.fsyncDir(p)); } finally { active = undefined; }
            }
            return target.fsyncDir(p);
          };
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const x = await r14CoreFixture(adapter);
        const before = r14Digests(await r14EvidenceBytes(x.config));
        const planned = await x.plan();
        const applied = planned.exitCode === 0 ? await x.runApply() : planned;
        const after = r14Digests(await r14EvidenceBytes(x.config));
        if (timing === "control") {
          assert.equal(hits, 0); assert.equal(applied.exitCode, 0, JSON.stringify(applied)); assert.equal(x.effects(), 1);
        } else {
          assert.equal(hits, 1, `${phase}/${boundary} reached precisely once`);
          assert.equal(applied.exitCode, 8, JSON.stringify(applied));
          assert.equal(applied.envelope.error?.code, "state_commit_manifest_write_failed");
          assert.equal(x.effects(), phase === "initial" ? 0 : 1);
          assert.ok(lastPath.includes("state-commit.json"), lastPath);
        }
        if (timing !== "control" && phase === "final-commit") {
          const persisted = JSON.parse((await r14EvidenceBytes(x.config))["state.json"]!) as SetupState;
          assert.notEqual(persisted.stages.find(s => s.id === "S01")?.status, "verified", "failed final publication cannot leave stage verified");
          assert.notEqual((await x.engine.run("status", { configPath: x.configPath })).exitCode, 0, "recorded status cannot report success after failed publication");
        }
        const effectsAtFailure = x.effects();
        const recovered = await x.engine.run("recover", { configPath: x.configPath });
        const replanned = await x.plan();
        const retried = replanned.exitCode === 0 ? await x.runApply() : replanned;
        assert.ok([0, 8].includes(recovered.exitCode), JSON.stringify(recovered));
        assert.ok([0, 8].includes(retried.exitCode), JSON.stringify(retried));
        assert.ok(x.effects() <= 1, "no unknown effect replay");
        console.log("R14_FAULT " + JSON.stringify({ phase, boundary, timing, path: lastPath, hits, before, after,
          effects_at_failure: effectsAtFailure, effects: x.effects(), result: applied.exitCode, next_recover: recovered.exitCode, next_apply: retried.exitCode }));
      });
    }
  }
}

import { r14Clock, r14Noop, r14Process } from "../helpers/r14-engine";
for (const phase of ["between-operations", "checkpoint-before-binding", "before-install", "install-after-effect", "final-primary", "final-manifest", "recovery-prepared", "recovery-restored", "cleanup-before-remove", "cleanup-after-remove"]) {
  test(`U04 U08 separate S02 child writer ${phase}: IPC barrier, reader, foreign lock, SIGKILL and restart`, async () => {
    const childScript = path.resolve(__dirname, "../../../tests/helpers/r14-child.cjs");
    const dist = path.resolve(__dirname, "../..");
    const child = spawn(process.execPath, [childScript, dist, phase], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); });
    type Barrier = { type: string; phase: string; path: string; configPath: string; config: SetupConfig; effectsFile: string };
    let deadline: NodeJS.Timeout | undefined;
    const barrier = await new Promise<Barrier>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`IPC barrier deadline: ${phase}: ${stderr}`)), 20_000);
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Writer exited before barrier (${code}): ${stderr}`)));
      child.on("message", (value: Barrier) => { if (value.type === "barrier") { clearTimeout(deadline); resolve(value); } });
    }).catch(error => { child.kill("SIGKILL"); throw error; });
    try {
      assert.equal(barrier.phase, phase); assert.ok(path.isAbsolute(barrier.path));
      const realPidProcess: ProcessAdapter = { ...r14Process, isPidAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } } };
      const e = new SetupEngine({ fsAdapter: new NodeFilesystemAdapter(), processAdapter: realPidProcess, clock: r14Clock }, createRegistry([r14Noop("S01"), r14Noop("S02")]));
      const before = await r14EvidenceBytes(barrier.config);
      await e.run("status", { configPath: barrier.configPath });
      assert.deepEqual(await r14EvidenceBytes(barrier.config), before, "reader never writes marker/migration/repair");
      const foreign = await e.run("recover", { configPath: barrier.configPath });
      assert.equal(foreign.exitCode, 7, JSON.stringify(foreign));
      assert.deepEqual(await r14EvidenceBytes(barrier.config), before);
      const effectsBefore = await fs.promises.readFile(barrier.effectsFile, "utf8");
      const exit = once(child, "exit"); child.kill("SIGKILL");
      const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, "SIGKILL");
      const unlocked = await e.run("recover", { configPath: barrier.configPath, lockOnly: true });
      const uncertain = ["checkpoint-before-binding", "before-install", "install-after-effect", "final-primary"].includes(phase);
      assert.equal(unlocked.exitCode, uncertain ? 8 : 0, JSON.stringify(unlocked));
      if (uncertain) {
        assert.equal(fs.existsSync(path.join(barrier.config.paths.setup_state_dir, "lock")), true);
        // Harness-only manual lock reconciliation keeps all unknown operation/state evidence intact.
        await fs.promises.rename(path.join(barrier.config.paths.setup_state_dir, "lock"), path.join(barrier.config.paths.setup_state_dir, "lock.manual-u04"));
      }
      assert.deepEqual(await r14EvidenceBytes(barrier.config), before, "lock-only reconciliation never rewrites state evidence");
      const result = await e.run("recover", { configPath: barrier.configPath });
      const expected = ["checkpoint-before-binding", "before-install", "install-after-effect", "final-primary"].includes(phase) ? 8 : 0;
      const reviewRequired = ["recovery-prepared", "recovery-restored", "cleanup-before-remove", "cleanup-after-remove"].includes(phase);
      assert.equal(result.exitCode, reviewRequired ? 8 : expected, JSON.stringify(result));
      if (reviewRequired) assert.equal(result.envelope.error?.code, "context_review_unproven");
      assert.equal(await fs.promises.readFile(barrier.effectsFile, "utf8"), effectsBefore, "restart does not replay effects");
      const effects: string[] = JSON.parse(effectsBefore) as string[];
      if (["between-operations", "checkpoint-before-binding"].includes(phase)) assert.deepEqual(effects, ["refresh"]);
      else if (phase === "before-install") assert.deepEqual(effects, ["refresh", "simulate"]);
      else assert.deepEqual(effects, ["refresh", "simulate", "install"]);
      const stateBody = await fs.promises.readFile(path.join(barrier.config.paths.setup_state_dir, "state.json"), "utf8");
      const state = JSON.parse(stateBody) as SetupState;
      if (["between-operations", "checkpoint-before-binding", "before-install", "install-after-effect"].includes(phase)) assert.notEqual(state.stages.find(s => s.id === "S02")?.status, "verified");
      // Restart with the real S02 producer and fake persistent host state, not a no-op executor.
      const hostEffects = [...effects];
      const persistentApt: AptAdapter = {
        observe: async names => ({ metadataFresh: hostEffects.includes("refresh"), metadataUpdatedAt: r14Clock.now().toISOString(), sudoAvailable: true, dpkgAuditClean: true, dpkgAuditOutput: "", rebootRequired: false,
          packages: names.map(name => ({ name, installedVersion: hostEffects.includes("install") ? "1.0" : null, candidateVersion: "1.0" })) }),
        refreshMetadata: async () => { hostEffects.push("refresh"); },
        simulateInstall: async () => { hostEffects.push("simulate"); },
        installPinned: async () => { hostEffects.push("install"); }
      };
      const realRestart = new SetupEngine({ fsAdapter: new NodeFilesystemAdapter(), processAdapter: realPidProcess, clock: r14Clock }, createRegistry([r14Noop("S01"), createSystemStage(persistentApt)]));
      const restartPlan = await realRestart.run("plan", { configPath: barrier.configPath });
      if (expected === 8) {
        assert.equal(restartPlan.exitCode, 8, JSON.stringify(restartPlan));
        assert.deepEqual(hostEffects, effects, "actual S02 restart refuses unknown replay before calling apt");
      } else {
        assert.equal(restartPlan.exitCode, 0, JSON.stringify(restartPlan));
        await approveRequiredGates(realRestart, barrier.configPath, restartPlan);
        const resumed = await realRestart.run("resume", { configPath: barrier.configPath });
        assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
        assert.equal(hostEffects.filter(v => v === "refresh").length, 1, "known refresh is not repeated");
        assert.equal(hostEffects.filter(v => v === "install").length, 1, "installation executes at most once");
      }
      console.log("R14_CRASH " + JSON.stringify({ phase, path: barrier.path, effects, resumed_effects: hostEffects, restart_plan_exit: restartPlan.exitCode, before: r14Digests(before), after: r14Digests(await r14EvidenceBytes(barrier.config)), reader_unchanged: true, foreign_lock_exit: foreign.exitCode, recover_exit: result.exitCode, child_signal: signal }));
    } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}

test("U04 S02 late exception preserves real refresh/simulate checkpoints and unknown install", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "af-r14-late-apt-")), config = makeConfig(root), configPath = path.join(root, "config.json");
  config.selected_stages = ["S02"]; await writeConfig(configPath, config);
  const f = new NodeFilesystemAdapter(), apt = new StageFakeAptAdapter(aptObservationWithMissingInstall());
  apt.installPinned = async () => {
    const evidence = await inspectStateEvidence(f, config);
    assert.equal(evidence.journal.unresolvedOperationIds.length, 1, "only current install remains unknown");
    assert.ok(evidence.commitManifest?.completed_operations?.some(p => p.receipt.resourceId === "apt-metadata"));
    assert.ok(evidence.commitManifest?.completed_operations?.some(p => p.receipt.resourceId === "apt-simulation"));
    assert.equal(evidence.commitManifest?.last_effect_checkpoint?.operation_id.startsWith("s02-apt-simulate-"), true);
    throw new Error("injected late install failure");
  };
  const e = new SetupEngine({ fsAdapter: f, processAdapter: new CountingProcessAdapter(3401, "f324dcd7-4035-4430-ab39-ce31f9e396bf", "1".repeat(64), 100), clock: r14Clock }, createRegistry([r14Noop("S01"), createSystemStage(apt)]));
  const planned = await e.run("plan", { configPath });
  assert.equal(planned.exitCode, 0);
  await approveRequiredGates(e, configPath, planned);
  const result = await e.run("apply", { configPath, planPath: path.join(config.paths.setup_state_dir, "plan.json") });
  assert.equal(result.exitCode, 6, JSON.stringify(result)); assert.equal(apt.refreshed, 1); assert.equal(apt.simulated, 1);
  const state = JSON.parse(await f.readText(path.join(config.paths.setup_state_dir, "state.json"))) as SetupState;
  assert.ok(state.in_flight_operation?.id.includes("s02-apt-install-")); assert.notEqual(state.stages.find(s => s.id === "S02")?.status, "verified");
  const before = await r14EvidenceBytes(config);
  assert.equal((await e.run("recover", { configPath })).exitCode, 8);
  assert.deepEqual(await r14EvidenceBytes(config), before);
});

for (const fault of ["restore-manifest-write", "restore-manifest-rename", "cleanup-remove", "control"] as const) {
  test(`U08 engine clean proof survives metadata-only generation and recovery ${fault}`, async () => {
    const f = new InstrumentedFilesystemAdapter(), x = await r14CoreFixture(f);
    assert.equal((await x.plan()).exitCode, 0); assert.equal((await x.runApply()).exitCode, 0);
    const originalPlan = x.stage.plan.bind(x.stage);
    x.stage.plan = (desired, observed) => ({ ...originalPlan(desired, observed), requiredGates: ["r14-metadata-review"] });
    const planned = await x.plan(); assert.equal(planned.exitCode, 0);
    const approved = await x.engine.run("gate-approve", { configPath: x.configPath, gateId: "r14-metadata-review", planHash: planned.envelope.plan_hash! });
    assert.equal(approved.exitCode, 0);
    const primary = path.join(x.config.paths.setup_state_dir, "state.json");
    const previous = JSON.parse(await f.readText(`${primary}.previous`)) as SetupState;
    const m = await readStateCommitManifest(f, x.config);
    assert.notEqual(m?.last_state_hash, stateHash(previous), "actual gate metadata creates distinct generation");
    assert.ok(m?.clean_proof?.snapshot_hashes.includes(stateHash(previous)));
    await fs.promises.unlink(primary);
    if (fault === "restore-manifest-write") f.setFailureRules([{ method: "writeText", pathIncludes: "state-commit.json.tmp-", code: "ENOSPC" }]);
    if (fault === "restore-manifest-rename") f.setFailureRules([{ method: "rename", pathIncludes: "state-commit.json.tmp-", code: "EIO" }]);
    if (fault === "cleanup-remove") f.setFailureRules([{ method: "remove", pathIncludes: "recovery-required.json", code: "EIO" }]);
    const beforeRecovery = r14Digests(await r14EvidenceBytes(x.config));
    const first = await x.engine.run("recover", { configPath: x.configPath });
    const afterFault = r14Digests(await r14EvidenceBytes(x.config));
    const hitCount = f.getTriggeredFailures();
    assert.equal(first.exitCode, fault === "control" ? 0 : 8, JSON.stringify(first));
    assert.equal(f.getTriggeredFailures(), fault === "control" ? 0 : 1);
    f.setFailureRules([]);
    assert.equal((await x.engine.run("recover", { configPath: x.configPath })).exitCode, 0);
    assert.equal(stateHash(JSON.parse(await f.readText(primary)) as SetupState), stateHash(previous));
    assert.deepEqual((await readStateCommitManifest(f, x.config))?.last_effect_checkpoint, m?.last_effect_checkpoint);
    assert.equal(x.effects(), 1);
    console.log("R14_RECOVERY_FAULT " + JSON.stringify({ fault, before: beforeRecovery, after_fault: afterFault, after_retry: r14Digests(await r14EvidenceBytes(x.config)), hits: hitCount, first_exit: first.exitCode, next_recover: 0, effects: x.effects() }));
  });
}
