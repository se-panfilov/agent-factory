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

function makeCtx(): StageContext {
  return {
    installationId: "ebf4bcbe-bf10-44f3-a1ee-f2947974c64a",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "d".repeat(64),
    planHash: "e".repeat(64)
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
  const receipts = await stage.apply(makeCtx(), plan);

  assert.equal(plan.requiredGates.includes("s05-dockerfile-build-reviewed"), true);
  assert.equal(receipts.length, 1);
  assert.equal(adapter.extractCalls, 1);
  assert.equal(adapter.materializeCalls, 1);
  assert.equal(adapter.probeCalls, 1);
  assert.equal(receipts[0]?.checks.content_hashes_verified, true);
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
    async () => stage.apply(makeCtx(), plan),
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
    async () => stage.apply(makeCtx(), plan),
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
    async () => stage.apply(makeCtx(), plan),
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
    async () => stage.apply(makeCtx(), plan),
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
    async () => stage.apply(makeCtx(), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s05_content_hash_mismatch"
      && (error as { exitCode?: number }).exitCode === ExitCode.SecurityBoundaryViolation
    )
  );
});
