import test from "node:test";
import assert from "node:assert/strict";
import { buildStageClosure, createRegistry, validatePlanConsistency } from "../../src/core/plan";
import { ensureNonInteractiveGates } from "../../src/core/gates";
import { ExitCode, type InstallerPlan, type SetupConfig, type SetupState, type StageModule } from "../../src/core/types";
import { hashConfig } from "../../src/core/config";

function makeConfig(): SetupConfig {
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
      setup_state_dir: "/tmp/state",
      setup_cache_dir: "/tmp/cache",
      setup_bin_dir: "/tmp/bin",
      setup_node_dir: "/tmp/node",
      application_dir: "/tmp/app",
      application_state_dir: "/tmp/app/state",
      application_auth_dir: "/tmp/app/auth",
      application_work_dir: "/tmp/app/work"
    },
    release: {
      archive_path: "/tmp/release.tar.xz",
      sha256: "a".repeat(64),
      source_commit: "b".repeat(40)
    },
    version_lock_path: "/tmp/lock.json",
    selected_stages: ["S01"],
    resource_profile: "daily3",
    network: {
      mode: "cloud-only",
      allow_paid_fallback: false
    },
    secret_refs: {
      auth_dir: "/tmp/auth"
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

function makeStage(id: "S00" | "S01", dependencies: Array<"S00" | "S01">): StageModule {
  return {
    id,
    dependencies,
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe() {
      return {
        stageId: id,
        status: "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
      };
    },
    plan() {
      return {
        stageId: id,
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

test("buildStageClosure resolves transitive prerequisites", () => {
  const registry = createRegistry([makeStage("S00", []), makeStage("S01", ["S00"])]);
  const closure = buildStageClosure(registry, ["S01"]);
  assert.deepEqual(closure, ["S00", "S01"]);
});

test("buildStageClosure rejects cycles", () => {
  const registry = createRegistry([makeStage("S00", ["S01"]), makeStage("S01", ["S00"])]);
  assert.throws(
    () => buildStageClosure(registry, ["S01"]),
    (error) => error instanceof Error && error.message.includes("cycle detected")
  );
});

test("validatePlanConsistency rejects stale desired hash", () => {
  const config = makeConfig();
  const stalePlan: InstallerPlan = {
    schema_version: 1,
    contract_version: "1.0.0",
    installation_id: config.installation_id,
    desired_hash: "f".repeat(64),
    plan_hash: "0".repeat(64),
    created_at: "2026-10-22T00:00:00Z",
    stages: []
  };
  assert.throws(
    () => validatePlanConsistency(config, stalePlan),
    (error) => error instanceof Error && error.message.includes("desired hash")
  );
});

test("ensureNonInteractiveGates enforces pending approvals", () => {
  const state: SetupState = {
    schema_version: 1,
    contract_version: "1.0.0",
    installer_version: "0.0.1",
    installation_id: "0f71966d-ef6f-4976-97cb-eb34cb139204",
    host_fingerprint: {
      machine_id_hash: "a".repeat(64),
      os: "ubuntu-24.04",
      arch: "amd64",
      boot_id: "f324dcd7-4035-4430-ab39-ce31f9e396bf"
    },
    config_hash: hashConfig(makeConfig()),
    lock_hash: "b".repeat(64),
    stages: [],
    pending_gates: [
      {
        id: "gate-1",
        operation_id: "op-1",
        plan_hash: "p".repeat(64),
        expires_at: "2999-01-01T00:00:00Z",
        status: "pending"
      }
    ],
    in_flight_operation: null,
    last_error: null
  };

  try {
    ensureNonInteractiveGates(state, "p".repeat(64), true);
    assert.fail("expected gate check to fail");
  } catch (error) {
    assert.equal((error as { exitCode?: number }).exitCode, ExitCode.ManualActionRequired);
  }
});
