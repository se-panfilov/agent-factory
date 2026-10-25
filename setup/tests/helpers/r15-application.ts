// Standalone typed fixtures; no test callbacks are imported.
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

export function makeConfig(): SetupConfig {
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

export function makeManifest(config: SetupConfig): ApplicationManifestData {
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

export function makeRelease(config: SetupConfig): ReleaseInspection {
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

export function makeCheckout(config: SetupConfig): ExistingCheckoutObservation {
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

export function makeCtx(config: SetupConfig): StageContext {
  return {
    installationId: "ebf4bcbe-bf10-44f3-a1ee-f2947974c64a",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "d".repeat(64),
    planHash: "e".repeat(64),
    config
  };
}

export class FakeApplicationAdapter implements ApplicationReleaseAdapter {
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
