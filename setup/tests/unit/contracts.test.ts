import test from "node:test";
import assert from "node:assert/strict";
import { validateAllContracts, validateContractSchema } from "../../src/core/validators";

const VALID_CONFIG = {
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
    setup_state_dir: "/home/factory/.local/state/agent-factory-setup",
    setup_cache_dir: "/home/factory/.local/share/agent-factory-setup/releases",
    setup_bin_dir: "/home/factory/.local/bin",
    setup_node_dir: "/home/factory/.local/share/agent-factory-setup/node/24.19.0",
    application_dir: "/home/factory/work/agent-factory",
    application_state_dir: "/home/factory/work/agent-factory/state",
    application_auth_dir: "/home/factory/work/agent-factory/auth",
    application_work_dir: "/home/factory/work/factory-toy"
  },
  release: {
    archive_path: "/home/factory/releases/factory-setup-v0.0.1.tar.xz",
    sha256: "a2f048c2377b43dc6bf397d79769f8ab8c96f476f6f05560f23957a6215db5be",
    source_commit: "67a26ebf8f6f0287effe5f0f35f90285f63df39b"
  },
  version_lock_path: "/home/factory/releases/versions.lock.json",
  selected_stages: ["S00", "S01", "S07"],
  resource_profile: "daily3",
  network: {
    mode: "cloud-only",
    allow_paid_fallback: false
  },
  secret_refs: {
    auth_dir: "/home/factory/work/agent-factory/auth"
  },
  github: {
    repository_allowlist: ["se-panfilov/agent-factory"]
  },
  optional_features: {
    inference: false,
    platforms: false
  }
};

const VALID_STATE = {
  schema_version: 1,
  contract_version: "1.0.0",
  installer_version: "0.0.1",
  installation_id: "0f71966d-ef6f-4976-97cb-eb34cb139204",
  host_fingerprint: {
    machine_id_hash: "0f73de77ad6ad1c96927170f466e3f4baea64714cc5ef81a3477d6f03ac71350",
    os: "ubuntu-24.04",
    arch: "amd64",
    boot_id: "f324dcd7-4035-4430-ab39-ce31f9e396bf"
  },
  config_hash: "487f266aa4ad0cb306f9f36595f8e38f8fbf35c4a7902dc6cd2ce51f53d96e77",
  lock_hash: "7c1ebca5eb95f6985c391554a911f80b5e4fd2c1faa20ceb57723ecf3340d77a",
  stages: [
    {
      id: "S01",
      status: "planned",
      observed_at: "2026-10-21T20:00:00Z",
      checks: {
        cpu: 4,
        disk_ok: true
      },
      versions: {
        ubuntu: "24.04"
      },
      applied_hashes: [],
      artifacts: [],
      dependencies_hash: "4b07795d20ed06b5d9ed2f0225f863916f035df5f00e957241ac6ca16f489b6f"
    }
  ],
  pending_gates: [],
  in_flight_operation: null,
  last_error: null
};

const VALID_PLAN = {
  schema_version: 1,
  contract_version: "1.0.0",
  installation_id: "0f71966d-ef6f-4976-97cb-eb34cb139204",
  desired_hash: "cbf18c501796da4ac8f5489f13f8d8e2a2f52f8ceacdf4ecfd171f06dc6f66f6",
  plan_hash: "a47a81f4cad8f685dca8f9ff812f39b3b3f6f3867d80a6f0893fc31f06eb2fab",
  created_at: "2026-10-21T20:00:00Z",
  stages: [
    {
      stage_id: "S01",
      optional: false,
      required_capabilities: ["runner-readonly"],
      operations: [
        {
          id: "op-observe-host",
          stage_id: "S01",
          kind: "observe",
          resource_id: "installation:0f71966d-ef6f-4976-97cb-eb34cb139204",
          risk: "low",
          gate_ids: [],
          preconditions: ["host-user-matches"],
          side_effects: [],
          timeout_sec: 30,
          retryable: true
        }
      ],
      required_gates: []
    }
  ]
};

const VALID_INSTALLER_RELEASE = {
  schema_version: 1,
  contract_version: "1.0.0",
  installer: { version: "0.0.1" },
  node: {
    version: "24.19.0",
    source_url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
    sha256: "25eb6bcf514cfd63f4607825840339724b8f7f8fcb7fda23a6f3f5f273f8f8f7"
  },
  npm: { version: "11.0.0" },
  docker: {
    ce: "5:28.3.0-1~ubuntu.24.04~noble",
    cli: "5:28.3.0-1~ubuntu.24.04~noble",
    containerd: "1.7.27-1",
    buildx: "0.20.1-1~ubuntu.24.04~noble",
    compose: "2.36.2-1~ubuntu.24.04~noble"
  },
  tailscale: { version: "1.82.5" },
  codex: {
    package: "@openai/codex",
    version: "0.32.0",
    integrity: "sha512-L6GS6QgeNcRU+UQyIZhO6gJ4xXh1gRdrtKdUxQeT0JSZZW73gMCLxW0zkYxIu+skzAQwVnj8FA6NfUNFF6Awjw=="
  },
  images: {
    base_image_platform_digest: "sha256:c31be4e55872ca3d44f5f5eceddb896a27af2f5f50384f53fc449ef77a6df7f2",
    agent_image_digest: "sha256:3c9cde2f2f37ec6e50b92ca5a3ad2d7f8f66c61cf143811e7f831909be9b4414"
  },
  sources: {
    trusted_fingerprints: ["node-release-key-2026"],
    official_urls: ["https://nodejs.org/dist/v24.19.0/"]
  },
  qualification: {
    report_refs: ["setup/docs/qualification/P15-amd64.md"]
  }
};

const VALID_APPLICATION_MANIFEST = {
  schema_version: 1,
  application_version: "0.4.0",
  source_commit: "0d9a5ebfc4ecf27679fbf0e6513dce06c96c4e11",
  content_hashes: {
    "dist/index.js": "3574f6764e37a7166ed17ea7d127ddbdf95f84f2a531472534cd28e5e3f95f1f"
  },
  node_range: ">=24.0.0 <25",
  capabilities: ["runner-readonly", "app-status"],
  commands: {
    runner_verify: ["node", "dist/runner/verify.js"],
    runner_stop: ["node", "dist/runner/stop.js"],
    app_status: ["node", "dist/cli.js", "status"]
  },
  config_schema_version: 1,
  state_schema_version: 1,
  migrations: {
    from: 1,
    to: 2
  },
  security_evidence_refs: ["docs/security/m0-review.md"]
};

test("accepts valid minimal contract set", () => {
  const results = validateAllContracts({
    config: VALID_CONFIG,
    state: VALID_STATE,
    plan: VALID_PLAN,
    installerRelease: VALID_INSTALLER_RELEASE,
    applicationManifest: VALID_APPLICATION_MANIFEST
  });

  for (const result of results) {
    assert.equal(result.ok, true, `expected ${result.schema} to be valid: ${result.errors.join("; ")}`);
  }
});

test("rejects schema_unknown fixture", () => {
  const schemaUnknown = {
    ...VALID_CONFIG,
    schema_version: 2
  };
  const result = validateContractSchema("config", schemaUnknown);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /schema_version/);
});

test("rejects unknown_field fixture", () => {
  const unknownField = {
    ...VALID_CONFIG,
    unknown_field: "unexpected"
  };
  const result = validateContractSchema("config", unknownField);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /additional properties/);
});

test("rejects invalid path fixture", () => {
  const invalidPath = {
    ...VALID_CONFIG,
    paths: {
      ...VALID_CONFIG.paths,
      application_dir: "../agent-factory"
    }
  };
  const result = validateContractSchema("config", invalidPath);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /path must be absolute/);
});

test("rejects missing pin fixture", () => {
  const missingPin = {
    ...VALID_INSTALLER_RELEASE,
    codex: {
      package: "@openai/codex",
      version: "0.32.0"
    }
  };
  const result = validateContractSchema("installer-release", missingPin);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /integrity/);
});
