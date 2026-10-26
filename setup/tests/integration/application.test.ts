import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createApplicationStage } from "../../src/stages/application";
import {
  type ApplicationManifestData,
  type ApplicationReleaseAdapter,
  type ExistingCheckoutObservation,
  type ProbeResult,
  type ReleaseInspection
} from "../../src/adapters/git";
import { ExitCode, type SetupConfig, type StageContext, type StageObservation } from "../../src/core/types";

function makeConfig(): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "ebf4bcbe-bf10-44f3-a1ee-f2947974c64a",
    profile: "supervised",
    host: {
      os: "ubuntu-24.04",
      arch: "amd64",
      expected_user: "factory"
    },
    paths: {
      setup_state_dir: "/tmp/setup-state",
      setup_cache_dir: "/tmp/setup-cache",
      setup_bin_dir: "/tmp/setup-bin",
      setup_node_dir: "/tmp/setup-node",
      application_dir: "/tmp/work/agent-factory",
      application_state_dir: "/tmp/work/agent-factory/state",
      application_auth_dir: "/tmp/work/agent-factory/auth",
      application_work_dir: "/tmp/work/factory-toy"
    },
    release: {
      archive_path: "/tmp/artifacts/app-m0.tar",
      sha256: "a".repeat(64),
      source_commit: "b".repeat(40)
    },
    version_lock_path: "/tmp/versions.lock.json",
    selected_stages: ["S05"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: "/tmp/work/agent-factory/auth"
    },
    github: {
      repository_allowlist: ["github.com/se-panfilov/agent-factory"]
    },
    optional_features: {
      inference: false,
      platforms: false
    }
  };
}

function makeManifest(config: SetupConfig): ApplicationManifestData {
  return {
    schema_version: 1,
    application_version: "m0.0.1",
    source_commit: config.release.source_commit,
    content_hashes: {
      "runner.js": "c".repeat(64)
    },
    node_range: ">=24.0.0 <25",
    capabilities: ["runner-readonly"],
    commands: {
      runner_verify: ["node", "runner.js"],
      runner_stop: ["node", "runner.js", "stop"]
    },
    config_schema_version: 1,
    state_schema_version: 1,
    migrations: {
      from: 1,
      to: 1
    },
    security_evidence_refs: ["docs/security/m0.md"]
  };
}

function makeRelease(config: SetupConfig): ReleaseInspection {
  return {
    archiveExists: true,
    archiveSha256: config.release.sha256,
    sha256Matches: true,
    entryCount: 5,
    traversalEntries: [],
    symlinkEntries: [],
    specialEntries: [],
    hasDockerfile: false,
    hasBuildContext: true,
    manifestPath: "release/deployment-manifest.json",
    manifest: makeManifest(config),
    manifestValid: true,
    manifestErrors: []
  };
}

function makeCheckout(config: SetupConfig): ExistingCheckoutObservation {
  return {
    exists: false,
    hasGitDir: false,
    dirty: false,
    detachedHead: true,
    branch: null,
    headCommit: null,
    originUrl: null,
    hasDeploymentManifest: false,
    deployedSourceCommit: null
  };
}

function makeCtx(config: SetupConfig): StageContext {
  return {
    installationId: "ebf4bcbe-bf10-44f3-a1ee-f2947974c64a",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "d".repeat(64),
    planHash: "e".repeat(64),
    config
  };
}

class FakeApplicationAdapter implements ApplicationReleaseAdapter {
  constructor(
    public checkout: ExistingCheckoutObservation,
    public release: ReleaseInspection,
    public probe: ProbeResult = {
      runnerVerifyHelpOk: true,
      runnerStopHelpOk: true,
      details: []
    },
    public hashMismatches: string[] = []
  ) {}

  extractCalls = 0;
  materializeCalls = 0;
  probeCalls = 0;

  async observeExistingCheckout(_config: SetupConfig): Promise<ExistingCheckoutObservation> {
    return { ...this.checkout };
  }

  async inspectArchive(_config: SetupConfig): Promise<ReleaseInspection> {
    return {
      ...this.release,
      traversalEntries: [...this.release.traversalEntries],
      symlinkEntries: [...this.release.symlinkEntries],
      specialEntries: [...this.release.specialEntries]
    };
  }

  async extractArchive(_config: SetupConfig, _targetDir: string): Promise<void> {
    this.extractCalls += 1;
  }

  async verifyContentHashes(_rootDir: string, _expected: Record<string, string>): Promise<string[]> {
    return [...this.hashMismatches];
  }

  async materializeRelease(_rootDir: string, _targetDir: string): Promise<void> {
    this.materializeCalls += 1;
    this.checkout.exists = true;
    this.checkout.deployedSourceCommit = this.release.manifest?.source_commit ?? null;
  }

  async probeCommands(_rootDir: string, _manifest: ApplicationManifestData, _config: SetupConfig): Promise<ProbeResult> {
    this.probeCalls += 1;
    return this.probe;
  }

  async commitExists(_repoDir: string, _commit: string): Promise<boolean> {
    return true;
  }

  async fetchReadOnly(): Promise<void> {
    throw new Error("not used");
  }
}

function placeholderObserved(): StageObservation {
  return {
    stageId: "S05",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: new Date().toISOString()
  };
}

test("S05 applies trusted synthetic M0 artifact and runs offline probes", async () => {
  const config = makeConfig();
  const adapter = new FakeApplicationAdapter(makeCheckout(config), makeRelease(config));
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());
  const receipts = await stage.apply(makeCtx(config), plan);

  assert.equal(plan.requiredGates.includes("s05-dockerfile-build-reviewed"), true);
  assert.equal(receipts.length, plan.operations.length);
  assert.equal(adapter.extractCalls, 2);
  assert.equal(adapter.materializeCalls, 1);
  assert.equal(adapter.probeCalls, 1);
  const hashVerified = receipts.some((receipt) => receipt.checks.content_hashes_verified === true);
  assert.equal(hashVerified, true);
});

test("S05 returns explicit blocker when valid M0 release is missing", async () => {
  const config = makeConfig();
  const release = makeRelease(config);
  release.archiveExists = false;
  release.manifest = null;
  release.manifestValid = false;
  release.manifestPath = null;
  release.manifestErrors = ["manifest_missing"];
  const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_m0_release_missing"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );
});

test("S05 rejects traversal or symlink entries before extraction", async () => {
  const config = makeConfig();
  const release = makeRelease(config);
  release.symlinkEntries = ["release/link"];
  const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_archive_symlink_forbidden"
      && (error as { exitCode?: number }).exitCode === ExitCode.SecurityBoundaryViolation
    )
  );
  assert.equal(adapter.extractCalls, 0);
});

test("S05 rejects archive path traversal entries before extraction", async () => {
  const config = makeConfig();
  const release = makeRelease(config);
  release.traversalEntries = ["../escape"];
  const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_archive_path_traversal"
      && (error as { exitCode?: number }).exitCode === ExitCode.SecurityBoundaryViolation
    )
  );
  assert.equal(adapter.extractCalls, 0);
});

test("S05 rejects dirty existing checkout and does not reset", async () => {
  const config = makeConfig();
  const checkout = makeCheckout(config);
  checkout.exists = true;
  checkout.hasGitDir = true;
  checkout.dirty = true;
  checkout.detachedHead = false;
  checkout.branch = "main";
  checkout.headCommit = config.release.source_commit;
  checkout.originUrl = "https://github.com/se-panfilov/agent-factory";
  const adapter = new FakeApplicationAdapter(checkout, makeRelease(config));
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_existing_checkout_dirty"
      && (error as { exitCode?: number }).exitCode === ExitCode.DriftOrRecoveryRequired
    )
  );
  assert.equal(adapter.materializeCalls, 0);
});

test("S05 verifies hash mismatches as security violation", async () => {
  const config = makeConfig();
  const adapter = new FakeApplicationAdapter(
    makeCheckout(config),
    makeRelease(config),
    {
      runnerVerifyHelpOk: true,
      runnerStopHelpOk: true,
      details: []
    },
    ["runner.js:hash-mismatch"]
  );
  const stage = createApplicationStage(adapter);
  const plan = stage.plan(config, placeholderObserved());

  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_content_hash_mismatch"
      && (error as { exitCode?: number }).exitCode === ExitCode.SecurityBoundaryViolation
    )
  );
});

import { r14Fixture, r14Noop } from "../helpers/r14-engine";
import fs from "node:fs/promises";
for (const mode of ["success", "negative", "timeout", "missing"] as const) {
  test(`U02 S05 engine ${mode}: materialization cannot substitute mandatory probes`, async () => {
    const x = await r14Fixture("S05"), a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
    if (mode === "negative") a.probe.runnerVerifyHelpOk = false;
    if (mode === "missing") a.release.manifest!.commands.runner_verify = [];
    const originalProbe = a.probeCommands.bind(a);
    a.probeCommands = async (root, manifest, config) => {
      if (mode === "timeout") { a.probeCalls++; throw new Error("injected command timeout"); }
      if ((manifest.commands.runner_verify?.length ?? 0) === 0) { a.probeCalls++; return { runnerVerifyHelpOk: false, runnerStopHelpOk: true, details: ["missing command"] }; }
      return originalProbe(root, manifest, config);
    };
    const e = x.engine([r14Noop("S04"), createApplicationStage(a)]);
    await x.planAndApprove(e);
    const applied = await e.run("apply", x.applyOptions);
    if (mode === "missing") assert.equal(a.probeCalls, 0, "missing command is refused before application adapter entry");
    else assert.ok(a.probeCalls >= 1, "required valid command probe actually called");
    assert.equal(a.extractCalls, 2, "both extractions are explicitly planned"); assert.equal(a.materializeCalls, 1);
    const state = await x.state();
    if (mode === "success") {
      assert.equal(applied.exitCode, 0, JSON.stringify(applied));
      assert.equal(state.stages.find(s => s.id === "S05")?.status, "verified");
      const count = a.probeCalls;
      a.probe.runnerVerifyHelpOk = false;
      const verified = await e.run("verify", { configPath: x.configPath });
      assert.notEqual(verified.exitCode, 0); assert.ok(a.probeCalls > count);
      assert.notEqual((await x.state()).stages.find(s => s.id === "S05")?.status, "verified");
      const refreshed = await e.run("status", { configPath: x.configPath, refresh: true });
      assert.notEqual(refreshed.exitCode, 0);
      const before = a.probeCalls;
      await e.run("status", { configPath: x.configPath });
      assert.equal(a.probeCalls, before, "recorded status does not spawn command probes");
    } else {
      assert.notEqual(applied.exitCode, 0, JSON.stringify(applied));
      assert.notEqual(state.stages.find(s => s.id === "S05")?.status, "verified");
      const journal = (await fs.readFile(path.join(x.config.paths.setup_state_dir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { operation_id: string; code: string });
      assert.equal(journal.some(r => r.operation_id.includes("probe-release") && ["verify", "checkpoint"].includes(r.code)), false);
    }
  });
}

test("U02 existing commit without journal-bound deployment trust cannot spawn probes during plan", async () => {
  const x = await r14Fixture("S05"), checkout = makeCheckout(x.config);
  checkout.exists = true; checkout.deployedSourceCommit = x.config.release.source_commit;
  const a = new FakeApplicationAdapter(checkout, makeRelease(x.config));
  const e = x.engine([r14Noop("S04"), createApplicationStage(a)]);
  const plan = await x.planAndApprove(e);
  assert.equal(a.probeCalls, 0, "preexisting checkout is not executable trust evidence");
  assert.ok(plan.stages.find(s => s.stage_id === "S05")!.operations.some(o => o.id.includes("probe-release")));
  const result = await e.run("apply", x.applyOptions);
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.ok(a.probeCalls >= 1);
});

test("U02 failing mandatory S05 probe prevents dependent S06 effects", async () => {
  const x = await r14Fixture("S06"), a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
  a.probe.runnerVerifyHelpOk = false;
  let dependentEffects = 0;
  const dependent = r14Noop("S06"); dependent.dependencies = ["S05"];
  dependent.plan = () => ({ stageId: "S06", optional: false, requiredCapabilities: [], requiredGates: [], operations: [{ action: "fixture.counter" as const,
    id: "s06-effect-trap", stageId: "S06",  kind: "mutate", resourceId: "dependent-fixture", risk: "low", gateIds: [], preconditions: [], sideEffects: ["fixture only"], timeoutSec: 1, retryable: false }] });
  dependent.apply = async () => { dependentEffects++; throw new Error("Dependent stage must never execute"); };
  const e = x.engine([r14Noop("S04"), createApplicationStage(a), dependent]);
  await x.planAndApprove(e);
  const result = await e.run("apply", x.applyOptions);
  assert.notEqual(result.exitCode, 0); assert.ok(a.probeCalls >= 1); assert.equal(dependentEffects, 0);
  assert.notEqual((await x.state()).stages.find(s => s.id === "S05")?.status, "verified");
});
