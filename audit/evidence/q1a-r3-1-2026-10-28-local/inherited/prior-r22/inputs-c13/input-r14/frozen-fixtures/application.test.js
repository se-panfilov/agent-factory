"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const application_1 = require("../../src/stages/application");
const types_1 = require("../../src/core/types");
function makeConfig() {
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
function makeManifest(config) {
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
function makeRelease(config) {
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
function makeCheckout(config) {
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
function makeCtx(config) {
    return {
        installationId: "ebf4bcbe-bf10-44f3-a1ee-f2947974c64a",
        contractVersion: "1.0.0",
        profile: "supervised",
        desiredHash: "d".repeat(64),
        planHash: "e".repeat(64),
        config
    };
}
class FakeApplicationAdapter {
    checkout;
    release;
    probe;
    hashMismatches;
    constructor(checkout, release, probe = {
        runnerVerifyHelpOk: true,
        runnerStopHelpOk: true,
        details: []
    }, hashMismatches = []) {
        this.checkout = checkout;
        this.release = release;
        this.probe = probe;
        this.hashMismatches = hashMismatches;
    }
    extractCalls = 0;
    materializeCalls = 0;
    probeCalls = 0;
    async observeExistingCheckout(_config) {
        return { ...this.checkout };
    }
    async inspectArchive(_config) {
        return {
            ...this.release,
            traversalEntries: [...this.release.traversalEntries],
            symlinkEntries: [...this.release.symlinkEntries],
            specialEntries: [...this.release.specialEntries]
        };
    }
    async extractArchive(_config, _targetDir) {
        this.extractCalls += 1;
    }
    async verifyContentHashes(_rootDir, _expected) {
        return [...this.hashMismatches];
    }
    async materializeRelease(_rootDir, _targetDir) {
        this.materializeCalls += 1;
        this.checkout.exists = true;
        this.checkout.deployedSourceCommit = this.release.manifest?.source_commit ?? null;
    }
    async probeCommands(_rootDir, _manifest, _config) {
        this.probeCalls += 1;
        return this.probe;
    }
    async commitExists(_repoDir, _commit) {
        return true;
    }
    async fetchReadOnly() {
        throw new Error("not used");
    }
}
function placeholderObserved() {
    return {
        stageId: "S05",
        status: "planned",
        checks: {},
        versions: {},
        observedAt: new Date().toISOString()
    };
}
(0, node_test_1.default)("S05 applies trusted synthetic M0 artifact and runs offline probes", async () => {
    const config = makeConfig();
    const adapter = new FakeApplicationAdapter(makeCheckout(config), makeRelease(config));
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    const receipts = await stage.apply(makeCtx(config), plan);
    strict_1.default.equal(plan.requiredGates.includes("s05-dockerfile-build-reviewed"), true);
    strict_1.default.equal(receipts.length, plan.operations.length);
    strict_1.default.equal(adapter.extractCalls, 2);
    strict_1.default.equal(adapter.materializeCalls, 1);
    strict_1.default.equal(adapter.probeCalls, 1);
    const hashVerified = receipts.some((receipt) => receipt.checks.content_hashes_verified === true);
    strict_1.default.equal(hashVerified, true);
});
(0, node_test_1.default)("S05 returns explicit blocker when valid M0 release is missing", async () => {
    const config = makeConfig();
    const release = makeRelease(config);
    release.archiveExists = false;
    release.manifest = null;
    release.manifestValid = false;
    release.manifestPath = null;
    release.manifestErrors = ["manifest_missing"];
    const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    await strict_1.default.rejects(async () => stage.apply(makeCtx(config), plan), (error) => (error instanceof Error
        && "code" in error
        && error.code === "s05_m0_release_missing"
        && error.exitCode === types_1.ExitCode.BlockedByMissingCapabilityOrEvidence));
});
(0, node_test_1.default)("S05 rejects traversal or symlink entries before extraction", async () => {
    const config = makeConfig();
    const release = makeRelease(config);
    release.symlinkEntries = ["release/link"];
    const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    await strict_1.default.rejects(async () => stage.apply(makeCtx(config), plan), (error) => (error instanceof Error
        && "code" in error
        && error.code === "s05_archive_symlink_forbidden"
        && error.exitCode === types_1.ExitCode.SecurityBoundaryViolation));
    strict_1.default.equal(adapter.extractCalls, 0);
});
(0, node_test_1.default)("S05 rejects archive path traversal entries before extraction", async () => {
    const config = makeConfig();
    const release = makeRelease(config);
    release.traversalEntries = ["../escape"];
    const adapter = new FakeApplicationAdapter(makeCheckout(config), release);
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    await strict_1.default.rejects(async () => stage.apply(makeCtx(config), plan), (error) => (error instanceof Error
        && "code" in error
        && error.code === "s05_archive_path_traversal"
        && error.exitCode === types_1.ExitCode.SecurityBoundaryViolation));
    strict_1.default.equal(adapter.extractCalls, 0);
});
(0, node_test_1.default)("S05 rejects dirty existing checkout and does not reset", async () => {
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
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    await strict_1.default.rejects(async () => stage.apply(makeCtx(config), plan), (error) => (error instanceof Error
        && "code" in error
        && error.code === "s05_existing_checkout_dirty"
        && error.exitCode === types_1.ExitCode.DriftOrRecoveryRequired));
    strict_1.default.equal(adapter.materializeCalls, 0);
});
(0, node_test_1.default)("S05 verifies hash mismatches as security violation", async () => {
    const config = makeConfig();
    const adapter = new FakeApplicationAdapter(makeCheckout(config), makeRelease(config), {
        runnerVerifyHelpOk: true,
        runnerStopHelpOk: true,
        details: []
    }, ["runner.js:hash-mismatch"]);
    const stage = (0, application_1.createApplicationStage)(adapter);
    const plan = stage.plan(config, placeholderObserved());
    await strict_1.default.rejects(async () => stage.apply(makeCtx(config), plan), (error) => (error instanceof Error
        && "code" in error
        && error.code === "s05_content_hash_mismatch"
        && error.exitCode === types_1.ExitCode.SecurityBoundaryViolation));
});
