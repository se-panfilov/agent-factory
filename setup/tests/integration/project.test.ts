import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { createProjectStage, type ProjectStageAdapter } from "../../src/stages/project";
import { type SetupConfig, type StageContext, type StageObservation } from "../../src/core/types";

class FakeProjectAdapter implements ProjectStageAdapter {
  public fetchCalls = 0;
  public checkerCalls = 0;
  public checkoutState: {
    exists: boolean;
    gitDirExists: boolean;
    detachedHead: boolean;
    headSha: string | null;
    dirty: boolean;
    originUrl: string | null;
  };

  constructor(
    private readonly checkerResult: { supported: boolean; status: "verified" | "blocked" | "unknown"; details: string },
    targetSha: string
  ) {
    this.checkoutState = {
      exists: false,
      gitDirExists: false,
      detachedHead: false,
      headSha: null,
      dirty: false,
      originUrl: null
    };
    this.checkoutState.headSha = targetSha;
  }

  async observeCheckout(checkoutDir: string) {
    if (!this.checkoutState.exists) {
      return {
        exists: false,
        gitDirExists: false,
        detachedHead: false,
        headSha: null,
        dirty: false,
        originUrl: null
      };
    }
    return {
      ...this.checkoutState,
      originUrl: this.checkoutState.originUrl ?? "https://github.com/se-panfilov/anarchy-engine.git"
    };
  }

  async fetchDetachedCheckout(input: { repository: string; targetSha: string; checkoutDir: string }): Promise<void> {
    this.fetchCalls += 1;
    const checkoutDir = input.checkoutDir;
    await fs.promises.mkdir(checkoutDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.join(checkoutDir, ".git"), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(checkoutDir, ".nvmrc"), "24.19.0\n", "utf8");
    await fs.promises.writeFile(path.join(checkoutDir, "package-lock.json"), "{\"lockfileVersion\":3}\n", "utf8");
    await fs.promises.writeFile(path.join(checkoutDir, "package.json"), "{\"workspaces\":[\"packages/*\"]}\n", "utf8");
    await fs.promises.writeFile(path.join(checkoutDir, "AGENTS.md"), "# rules\n", "utf8");
    await fs.promises.mkdir(path.join(checkoutDir, ".github", "workflows"), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(
      path.join(checkoutDir, ".github", "workflows", "ci.yml"),
      "name: ci\non: [push]\n",
      "utf8"
    );
    await fs.promises.writeFile(path.join(checkoutDir, "playwright.config.ts"), "export default {};\n", "utf8");
    this.checkoutState = {
      exists: true,
      gitDirExists: true,
      detachedHead: true,
      headSha: input.targetSha,
      dirty: false,
      originUrl: `https://github.com/${input.repository}.git`
    };
  }

  async runChecker(input: { checkerDir: string; inventoryPath: string }) {
    this.checkerCalls += 1;
    await fs.promises.mkdir(input.checkerDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(input.checkerDir, "checker.log"), "ok\n", "utf8");
    return this.checkerResult;
  }
}

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
    selected_stages: ["S09"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: path.join(root, "app", "auth")
    },
    github: {
      repository_allowlist: ["se-panfilov/anarchy-engine"]
    },
    optional_features: {
      inference: false,
      platforms: false
    }
  };
}

function makeCtx(config: SetupConfig): StageContext {
  return {
    installationId: config.installation_id,
    contractVersion: "1.0.0",
    profile: config.profile,
    desiredHash: "c".repeat(64),
    planHash: "d".repeat(64),
    config
  };
}

function placeholderObserved(): StageObservation {
  return {
    stageId: "S09",
    status: "planned",
    checks: {},
    versions: {},
    observedAt: new Date().toISOString()
  };
}

test("S09 prepares detached checkout at exact SHA and writes proposals without GitHub writes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p09-project-"));
  const config = makeConfig(root);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
  const adapter = new FakeProjectAdapter({ supported: false, status: "unknown", details: "missing" }, config.release.source_commit);
  const stage = createProjectStage(new NodeFilesystemAdapter(), adapter);
  const plan = stage.plan(config, placeholderObserved());
  const receipts = await stage.apply(makeCtx(config), plan);

  assert.equal(adapter.fetchCalls, 1);
  assert.equal(adapter.checkerCalls, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.checks.detached_checkout_bound_to_sha, true);
  assert.equal(receipts[0]?.checks.baseline_ci_result, "unknown");

  const inventoryRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "s09-target-inventory.json"), "utf8");
  const inventory = JSON.parse(inventoryRaw) as { target_sha: string; package_manager_lock: string; playwright_config_paths: string[] };
  assert.equal(inventory.target_sha, config.release.source_commit);
  assert.equal(inventory.package_manager_lock, "package-lock.json");
  assert.deepEqual(inventory.playwright_config_paths, ["playwright.config.ts"]);

  const baselineRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "s09-baseline-evidence.json"), "utf8");
  const baseline = JSON.parse(baselineRaw) as { ci_result: string; ci_status: string };
  assert.equal(baseline.ci_result, "unknown");
  assert.equal(baseline.ci_status, "missing");
});

test("S09 baseline recorder maps draft and skipped CI to unknown", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p09-project-ci-"));
  const config = makeConfig(root);
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s09-collector-evidence.json"),
    JSON.stringify({ ci_status: "draft", verification: "verified" }),
    "utf8"
  );
  const adapter = new FakeProjectAdapter({ supported: true, status: "verified", details: "ok" }, config.release.source_commit);
  const stage = createProjectStage(new NodeFilesystemAdapter(), adapter);
  const plan = stage.plan(config, placeholderObserved());
  await stage.apply(makeCtx(config), plan);

  let baselineRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "s09-baseline-evidence.json"), "utf8");
  let baseline = JSON.parse(baselineRaw) as { ci_result: string; ci_status: string };
  assert.equal(baseline.ci_status, "draft");
  assert.equal(baseline.ci_result, "unknown");

  await fs.promises.writeFile(
    path.join(config.paths.setup_state_dir, "s09-collector-evidence.json"),
    JSON.stringify({ ci_status: "skipped", verification: "verified" }),
    "utf8"
  );
  await stage.verify(makeCtx(config));
  baselineRaw = await fs.promises.readFile(path.join(config.paths.setup_state_dir, "s09-baseline-evidence.json"), "utf8");
  baseline = JSON.parse(baselineRaw) as { ci_result: string; ci_status: string };
  assert.equal(baseline.ci_status, "skipped");
  assert.equal(baseline.ci_result, "unknown");
});

test("S09 enforces exact full SHA binding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p09-project-allow-"));
  const config = makeConfig(root);
  config.release.source_commit = "abc123";
  await fs.promises.mkdir(config.paths.setup_state_dir, { recursive: true });

  const adapter = new FakeProjectAdapter({ supported: false, status: "unknown", details: "missing" }, config.release.source_commit);
  const stage = createProjectStage(new NodeFilesystemAdapter(), adapter);
  assert.throws(
    () => stage.plan(config, placeholderObserved()),
    (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "s09_target_sha_invalid"
  );
});
