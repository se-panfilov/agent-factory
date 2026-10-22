import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type SetupConfig, type StageContext, type StageObservation } from "../../src/core/types";
import { createPlatformsStage } from "../../src/stages/platforms";

function makeConfig(root: string): SetupConfig {
  return {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: "f61d6968-8524-4d33-8e89-c935afc381ab",
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
      application_work_dir: path.join(root, "work")
    },
    release: {
      archive_path: path.join(root, "release.tar.xz"),
      sha256: "a".repeat(64),
      source_commit: "b".repeat(40)
    },
    version_lock_path: path.join(root, "versions.lock.json"),
    selected_stages: ["S13"],
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
      inference: false,
      platforms: true
    }
  };
}

function makeCtx(config: SetupConfig): StageContext {
  return {
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "d".repeat(64),
    planHash: "e".repeat(64),
    config
  };
}

function observed(): StageObservation {
  return {
    stageId: "S13",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: new Date().toISOString()
  };
}

async function writeRequest(config: SetupConfig, payload: Record<string, unknown>): Promise<void> {
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s13-platform-request.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

async function writeBrowserSmokeAdapter(config: SetupConfig): Promise<void> {
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s13-browser-smoke-adapter.json"),
    `${JSON.stringify({
      schema_version: 1,
      profile: "browser_smoke",
      command: ["/usr/bin/node", "dist/checks/browser-smoke.js", "--candidate", config.release.source_commit]
    }, null, 2)}\n`,
    "utf8"
  );
}

test("S13 apply writes workflow proposal and readiness without auto-dispatch", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p13-platforms-apply-"));
  const config = makeConfig(root);
  await writeRequest(config, {
    schema_version: 1,
    candidate_sha: config.release.source_commit,
    profile: "guard",
    platforms: [],
    trusted_workflow_sha: "c".repeat(40),
    allowed_workflow_path: ".github/workflows/factory-platform-check.yml",
    allowed_producer: "github-actions:factory-platform-check",
    actions_allowed: true,
    billing_reviewed: true
  });

  const stage = createPlatformsStage(new NodeFilesystemAdapter());
  const plan = stage.plan(config, observed());
  const receipts = await stage.apply(makeCtx(config), plan);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.checks.s13_dispatch_required, false);
  assert.equal(receipts[0]?.checks.s13_checks_status, "unknown");

  const proposalPath = path.join(config.paths.setup_state_dir, "s13-proposals", "factory-platform-check.proposed.yml");
  const readinessPath = path.join(config.paths.setup_state_dir, "s13-platform-readiness.json");
  assert.equal(fs.existsSync(proposalPath), true);
  assert.equal(fs.existsSync(readinessPath), true);

  const readinessRaw = await fs.promises.readFile(readinessPath, "utf8");
  const readiness = JSON.parse(readinessRaw) as {
    dispatch_required: boolean;
    checks_status: string;
    integration_verified: boolean;
    platforms: string[];
  };
  assert.equal(readiness.dispatch_required, false);
  assert.equal(readiness.checks_status, "unknown");
  assert.equal(readiness.integration_verified, false);
  assert.deepEqual(readiness.platforms, []);
});

test("S13 blocks browser_smoke when PR12 adapter record is missing", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p13-platforms-missing-adapter-"));
  const config = makeConfig(root);
  await writeRequest(config, {
    schema_version: 1,
    candidate_sha: config.release.source_commit,
    profile: "browser_smoke",
    platforms: ["linux-x64"],
    trusted_workflow_sha: "c".repeat(40),
    allowed_workflow_path: ".github/workflows/factory-platform-check.yml",
    allowed_producer: "github-actions:factory-platform-check",
    actions_allowed: true,
    billing_reviewed: true
  });
  const stage = createPlatformsStage(new NodeFilesystemAdapter());
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s13_browser_smoke_adapter_missing"
  );
});

test("S13 rejects duplicate platforms before proposal generation", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p13-platforms-duplicate-"));
  const config = makeConfig(root);
  await writeRequest(config, {
    schema_version: 1,
    candidate_sha: config.release.source_commit,
    profile: "guard",
    platforms: ["linux-x64", "linux-x64"],
    trusted_workflow_sha: "c".repeat(40),
    allowed_workflow_path: ".github/workflows/factory-platform-check.yml",
    allowed_producer: "github-actions:factory-platform-check",
    actions_allowed: true,
    billing_reviewed: true
  });
  const stage = createPlatformsStage(new NodeFilesystemAdapter());
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s13_platform_duplicate"
  );
});

test("S13 verify accepts collector evidence only with trusted workflow/runner identity", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p13-platforms-verify-pass-"));
  const config = makeConfig(root);
  await writeRequest(config, {
    schema_version: 1,
    candidate_sha: config.release.source_commit,
    profile: "browser_smoke",
    platforms: ["linux-x64", "windows-x64"],
    trusted_workflow_sha: "c".repeat(40),
    allowed_workflow_path: ".github/workflows/factory-platform-check.yml",
    allowed_producer: "github-actions:factory-platform-check",
    actions_allowed: true,
    billing_reviewed: true
  });
  await writeBrowserSmokeAdapter(config);

  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s13-platform-collector-evidence.json"),
    `${JSON.stringify({
      schema_version: 1,
      checks: [
        {
          platform: "linux-x64",
          check_key: "browser_smoke",
          verdict: "pass",
          producer: "github-actions:factory-platform-check",
          workflow_ref: ".github/workflows/factory-platform-check.yml@" + "c".repeat(40),
          run_id: "100",
          runner_label: "ubuntu-24.04",
          runner_os: "Linux",
          runner_arch: "X64",
          runner_image: "ubuntu24-20261001.1",
          candidate_sha: config.release.source_commit,
          actual_checkout_sha: config.release.source_commit
        },
        {
          platform: "windows-x64",
          check_key: "browser_smoke",
          verdict: "pass",
          producer: "github-actions:factory-platform-check",
          workflow_ref: ".github/workflows/factory-platform-check.yml@" + "c".repeat(40),
          run_id: "101",
          runner_label: "windows-2025",
          runner_os: "Windows",
          runner_arch: "X64",
          runner_image: "windows2025-20261001.2",
          candidate_sha: config.release.source_commit,
          actual_checkout_sha: config.release.source_commit
        }
      ],
      dispatch: {
        accepted: true,
        dispatch_key: "dispatch-1",
        timed_out: false,
        reconciled: true
      },
      observed_at: "2026-10-22T12:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const stage = createPlatformsStage(new NodeFilesystemAdapter());
  const plan = stage.plan(config, observed());
  await stage.apply(makeCtx(config), plan);
  const verifyReceipts = await stage.verify(makeCtx(config));
  assert.equal(verifyReceipts.length, 1);
  assert.equal(verifyReceipts[0]?.checks.s13_integration_verified, true);
  assert.equal(verifyReceipts[0]?.checks.s13_checks_status, "pass");
});

test("S13 rejects untrusted workflow or runner arch drift in collector evidence", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p13-platforms-verify-fail-"));
  const config = makeConfig(root);
  await writeRequest(config, {
    schema_version: 1,
    candidate_sha: config.release.source_commit,
    profile: "guard",
    platforms: ["macos-arm64"],
    trusted_workflow_sha: "c".repeat(40),
    allowed_workflow_path: ".github/workflows/factory-platform-check.yml",
    allowed_producer: "github-actions:factory-platform-check",
    actions_allowed: true,
    billing_reviewed: true
  });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s13-platform-collector-evidence.json"),
    `${JSON.stringify({
      schema_version: 1,
      checks: [
        {
          platform: "macos-arm64",
          check_key: "guard",
          verdict: "pass",
          producer: "github-actions:factory-platform-check",
          workflow_ref: ".github/workflows/factory-platform-check.yml@" + "d".repeat(40),
          run_id: "101",
          runner_label: "macos-15",
          runner_os: "macOS",
          runner_arch: "X64",
          runner_image: "macos15-20261001.1",
          candidate_sha: config.release.source_commit,
          actual_checkout_sha: config.release.source_commit
        }
      ],
      dispatch: {
        accepted: true,
        dispatch_key: null,
        timed_out: false,
        reconciled: true
      },
      observed_at: "2026-10-22T12:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const stage = createPlatformsStage(new NodeFilesystemAdapter());
  const plan = stage.plan(config, observed());
  await assert.rejects(
    async () => stage.apply(makeCtx(config), plan),
    (error) => {
      if (!(error instanceof Error) || !("code" in error)) {
        return false;
      }
      const code = (error as { code?: string }).code;
      return code === "s13_untrusted_workflow_ref" || code === "s13_runner_identity_mismatch";
    }
  );
});
