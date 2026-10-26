"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const filesystem_1 = require("../../src/adapters/filesystem");
const engine_1 = require("../../src/core/engine");
const plan_1 = require("../../src/core/plan");
const types_1 = require("../../src/core/types");
const configuration_1 = require("../../src/stages/configuration");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = `sha256:${"1".repeat(64)}`;
class FakeProcessAdapter {
    codexBinaryPath;
    codexVersion;
    expectedDigest;
    machineHash;
    loginHelpOk;
    buildCalls = 0;
    constructor(codexBinaryPath, codexVersion, expectedDigest, machineHash, loginHelpOk = true) {
        this.codexBinaryPath = codexBinaryPath;
        this.codexVersion = codexVersion;
        this.expectedDigest = expectedDigest;
        this.machineHash = machineHash;
        this.loginHelpOk = loginHelpOk;
    }
    async runCommand(options) {
        if (options.binary === this.codexBinaryPath) {
            if (options.args[0] === "--version") {
                return this.ok(`${this.codexVersion}\n`);
            }
            if (options.args[0] === "exec" && options.args[1] === "--help") {
                return this.ok("Usage: codex exec\n");
            }
            if (options.args[0] === "login" && options.args[1] === "--help") {
                return this.loginHelpOk ? this.ok("Usage: codex login\n") : this.fail("login help failed");
            }
            return this.fail("unsupported codex args");
        }
        if (options.binary === "/usr/bin/git") {
            return this.ok("");
        }
        if (options.binary === "/usr/bin/docker") {
            if (options.args[0] === "build") {
                this.buildCalls += 1;
                return this.ok("build ok");
            }
            if (options.args[0] === "image"
                && options.args[1] === "inspect"
                && options.args[2] === "--format"
                && options.args[3] === "{{join .RepoDigests \",\"}}") {
                return this.ok(`local/agent@${this.expectedDigest}\n`);
            }
            if (options.args[0] === "image"
                && options.args[1] === "inspect"
                && options.args[2] === "--format"
                && options.args[3] === "{{.Id}}") {
                return this.ok(`${IMAGE_ID}\n`);
            }
            return this.fail(`unsupported docker command: ${options.args.join(" ")}`);
        }
        return this.fail(`unsupported binary: ${options.binary}`);
    }
    pid() {
        return 4000;
    }
    uid() {
        return 1000;
    }
    username() {
        return "factory";
    }
    async hostIdentity() { return {os:"ubuntu-24.04",arch:"amd64"}; }
    async loginSessionId() { return "c13-fixture-owner-login"; }
    async bootId() {
        return "f324dcd7-4035-4430-ab39-ce31f9e396bf";
    }
    async machineIdHash() {
        return this.machineHash;
    }
    async processStartTicks(_pid) {
        return 1;
    }
    isPidAlive(_pid) {
        return true;
    }
    ok(stdout) {
        return {
            exitCode: 0,
            stdout,
            stderr: "",
            timedOut: false,
            durationMs: 1
        };
    }
    fail(stderr) {
        return {
            exitCode: 1,
            stdout: "",
            stderr,
            timedOut: false,
            durationMs: 1
        };
    }
}
class TestHttpAdapter {
    async get(_options) {
        throw new Error("network access is not expected in this test");
    }
}
function makeConfig(root) {
    return {
        schema_version: 1,
        contract_version: "1.0.0",
        installation_id: "797fa484-91fe-4852-8a57-7d7dd84e2fa3",
        profile: "supervised",
        host: {
            os: "ubuntu-24.04",
            arch: "amd64",
            expected_user: "factory"
        },
        paths: {
            setup_state_dir: node_path_1.default.join(root, "state"),
            setup_cache_dir: node_path_1.default.join(root, "cache"),
            setup_bin_dir: node_path_1.default.join(root, "bin"),
            setup_node_dir: node_path_1.default.join(root, "node"),
            application_dir: node_path_1.default.join(root, "app"),
            application_state_dir: node_path_1.default.join(root, "app-state"),
            application_auth_dir: node_path_1.default.join(root, "app-auth"),
            application_work_dir: node_path_1.default.join(root, "work")
        },
        release: {
            archive_path: node_path_1.default.join(root, "release.tar.xz"),
            sha256: "c".repeat(64),
            source_commit: "d".repeat(40)
        },
        version_lock_path: node_path_1.default.join(root, "versions.lock.json"),
        selected_stages: ["S06"],
        resource_profile: "daily3",
        network: {
            mode: "cloud-only",
            allow_paid_fallback: false
        },
        secret_refs: {
            auth_dir: node_path_1.default.join(root, "app-auth")
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
function ctx(config) {
    return {
        installationId: "797fa484-91fe-4852-8a57-7d7dd84e2fa3",
        contractVersion: "1.0.0",
        profile: "supervised",
        desiredHash: "e".repeat(64),
        planHash: "f".repeat(64),
        config
    };
}
async function writeVersionLock(config, codexVersion = "0.32.0") {
    const lock = {
        schema_version: 1,
        contract_version: "1.0.0",
        installer: {
            version: "0.0.1"
        },
        node: {
            version: "24.19.0",
            source_url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
            sha256: "1".repeat(64)
        },
        npm: {
            version: "11.0.0"
        },
        docker: {
            ce: "5:28.3.0-1~ubuntu.24.04~noble",
            cli: "5:28.3.0-1~ubuntu.24.04~noble",
            containerd: "1.7.27-1",
            buildx: "0.20.1-1~ubuntu.24.04~noble",
            compose: "2.36.2-1~ubuntu.24.04~noble"
        },
        tailscale: {
            version: "1.82.5"
        },
        codex: {
            package: "@openai/codex",
            version: codexVersion,
            integrity: "sha512-example"
        },
        images: {
            base_image_platform_digest: DIGEST_A,
            agent_image_digest: DIGEST_B
        },
        sources: {
            trusted_fingerprints: ["test"],
            official_urls: ["https://nodejs.org/dist/v24.19.0/"]
        },
        qualification: {
            report_refs: ["setup/docs/qualification/P15-amd64.md"]
        }
    };
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(config.version_lock_path), { recursive: true });
    await node_fs_1.default.promises.writeFile(config.version_lock_path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}
async function prepareRoot() {
    const root = await node_fs_1.default.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "p07-config-images-"));
    const config = makeConfig(root);
    const codexPath = node_path_1.default.join(config.paths.setup_bin_dir, "codex");
    await node_fs_1.default.promises.mkdir(config.paths.setup_bin_dir, { recursive: true });
    await node_fs_1.default.promises.writeFile(codexPath, "#!/bin/sh\necho codex\n", { mode: 0o700 });
    await node_fs_1.default.promises.mkdir(config.paths.application_dir, { recursive: true });
    await node_fs_1.default.promises.mkdir(config.paths.application_work_dir, { recursive: true });
    await writeVersionLock(config);
    return { root, config, codexPath };
}
async function writeConfig(configPath, config) {
    await require("../helpers/r22-context.js").fixtureContextFiles(config,config.selected_stages.some(id=>["S05","S06","S07","S09","S10","S11","S13"].includes(id)));
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(configPath), { recursive: true, mode: 0o700 });
    await node_fs_1.default.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
function makeNoopDependencyStage(id) {
    return {
        id,
        dependencies: [],
        supportedProfiles: ["supervised", "service"],
        optional: false,
        requiredCapabilities: [],
        async observe() {
            return {
                stageId: id,
                status: "verified",
                checks: { noop: true },
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
async function approveRequiredGates(engine, configPath, planResult) {
    strict_1.default.equal(typeof planResult.envelope.plan_hash, "string");
    const approvals = Array.isArray(planResult.envelope.data?.required_approvals)
        ? planResult.envelope.data.required_approvals
        : [];
    for (const approval of approvals) {
        const approve = await engine.run("gate-approve", {
            configPath,
            gateId: approval.id,
            planHash: planResult.envelope.plan_hash
        });
        strict_1.default.equal(approve.exitCode, types_1.ExitCode.Success, JSON.stringify(approve.envelope));
    }
}
(0, node_test_1.default)("S06 applies canonical config/image and is idempotent on second run", async () => {
    const { config, codexPath } = await prepareRoot();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
    const stage = (0, configuration_1.createConfigurationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const observed = await stage.observe(ctx(config));
    const plan = stage.plan(config, observed);
    const receipt = await stage.apply(ctx(config), plan);
    strict_1.default.equal(receipt.length, 1);
    strict_1.default.equal(processAdapter.buildCalls, 1);
    const imageStatePath = node_path_1.default.join(config.paths.setup_state_dir, "s06-agent-image.json");
    const imageState = JSON.parse(await node_fs_1.default.promises.readFile(imageStatePath, "utf8"));
    strict_1.default.equal(imageState.codex_version, "0.32.0");
    const authMode = (await node_fs_1.default.promises.stat(config.paths.application_auth_dir)).mode & 0o777;
    const stateMode = (await node_fs_1.default.promises.stat(config.paths.application_state_dir)).mode & 0o777;
    const policyMode = (await node_fs_1.default.promises.stat(node_path_1.default.join(config.paths.application_dir, "policy-level1.json"))).mode & 0o777;
    strict_1.default.equal(authMode, 0o700);
    strict_1.default.equal(stateMode, 0o700);
    strict_1.default.equal(policyMode, 0o600);
    await stage.apply(ctx(config), plan);
    strict_1.default.equal(processAdapter.buildCalls, 1);
    const after = await stage.observe(ctx(config));
    strict_1.default.equal(after.status, "verified", JSON.stringify(after.checks));
});
(0, node_test_1.default)("S06 writes .proposed and blocks when user modified policy", async () => {
    const { config, codexPath } = await prepareRoot();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
    const stage = (0, configuration_1.createConfigurationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const policyPath = node_path_1.default.join(config.paths.application_dir, "policy-level1.json");
    await node_fs_1.default.promises.writeFile(policyPath, `${JSON.stringify({
        schema_version: 1,
        profile: "supervised",
        network_mode: "cloud-only",
        resource_profile: "standard",
        limits: {
            daily_budget: "daily3",
            run_timeout_sec: 300
        },
        providers: [{ id: "codex-cloud", package: "@openai/codex", enabled: true }],
        roles: { scout: { provider: "codex-cloud", max_parallelism: 1 } }
    }, null, 2)}\n`, { mode: 0o600 });
    const plan = stage.plan(config, await stage.observe(ctx(config)));
    await strict_1.default.rejects(async () => stage.apply(ctx(config), plan), (error) => error instanceof Error
        && "code" in error
        && error.code === "s06_policy_modified_requires_gate"
        && error.exitCode === types_1.ExitCode.ManualActionRequired);
    strict_1.default.equal(node_fs_1.default.existsSync(`${policyPath}.proposed`), true);
    strict_1.default.equal(node_fs_1.default.existsSync(`${policyPath}.proposed.diff`), true);
});
(0, node_test_1.default)("K08 real S06 verified lifecycle executes fresh no-op apply/status/resume", async () => {
    const { root, config, codexPath } = await prepareRoot();
    const configPath = node_path_1.default.join(root, "config", "setup.json");
    await writeConfig(configPath, config);
    const fsAdapter = new filesystem_1.NodeFilesystemAdapter();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "1".repeat(64));
    const engine = new engine_1.SetupEngine({
        fsAdapter,
        processAdapter,
        httpAdapter: new TestHttpAdapter(),
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-23T14:00:00.000Z") }
    }, (0, plan_1.createRegistry)([makeNoopDependencyStage("S05"), (0, configuration_1.createConfigurationStage)(fsAdapter, processAdapter)]));
    const plan1 = await engine.run("plan", { configPath, stageId: "S06" });
    strict_1.default.equal(plan1.exitCode, types_1.ExitCode.Success, JSON.stringify(plan1.envelope));
    await approveRequiredGates(engine, configPath, plan1);
    const apply1 = await engine.run("apply", {
        configPath,
        planPath: plan1.envelope.data?.plan_path,
        nonInteractive: true
    });
    strict_1.default.equal(apply1.exitCode, types_1.ExitCode.Success, JSON.stringify(apply1.envelope));
    strict_1.default.equal(processAdapter.buildCalls, 1);
    const status1 = await engine.run("status", { configPath });
    strict_1.default.equal(status1.exitCode, types_1.ExitCode.Success, JSON.stringify(status1.envelope));
    const resume1 = await engine.run("resume", { configPath });
    strict_1.default.equal(resume1.exitCode, types_1.ExitCode.Success, JSON.stringify(resume1.envelope));
    const plan2 = await engine.run("plan", { configPath, stageId: "S06" });
    strict_1.default.equal(plan2.exitCode, types_1.ExitCode.Success, JSON.stringify(plan2.envelope));
    await approveRequiredGates(engine, configPath, plan2);
    const plan2File = plan2.envelope.data?.plan_path;
    const plan2Json = JSON.parse(await node_fs_1.default.promises.readFile(plan2File, "utf8"));
    const s06Plan = plan2Json.stages.find((entry) => entry.stage_id === "S06");
    strict_1.default.ok(s06Plan !== undefined);
    strict_1.default.equal(s06Plan.operations.length, 0);
    const apply2 = await engine.run("apply", {
        configPath,
        planPath: plan2File,
        nonInteractive: true
    });
    strict_1.default.equal(apply2.exitCode, types_1.ExitCode.Success, JSON.stringify(apply2.envelope));
    strict_1.default.equal(processAdapter.buildCalls, 1);
    const status2 = await engine.run("status", { configPath });
    strict_1.default.equal(status2.exitCode, types_1.ExitCode.Success, JSON.stringify(status2.envelope));
    const resume2 = await engine.run("resume", { configPath });
    strict_1.default.equal(resume2.exitCode, types_1.ExitCode.Success, JSON.stringify(resume2.envelope));
});
(0, node_test_1.default)("S06 fails closed on unknown policy fields", async () => {
    const { config, codexPath } = await prepareRoot();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A");
    const stage = (0, configuration_1.createConfigurationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const policyPath = node_path_1.default.join(config.paths.application_dir, "policy-level1.json");
    await node_fs_1.default.promises.writeFile(policyPath, `${JSON.stringify({
        schema_version: 1,
        profile: "supervised",
        network_mode: "cloud-only",
        resource_profile: "daily3",
        limits: {
            daily_budget: "daily3",
            run_timeout_sec: 300
        },
        providers: [{ id: "codex-cloud", package: "@openai/codex", enabled: true }],
        roles: { scout: { provider: "codex-cloud", max_parallelism: 1 } },
        extra_field: true
    }, null, 2)}\n`, { mode: 0o600 });
    const plan = stage.plan(config, await stage.observe(ctx(config)));
    await strict_1.default.rejects(async () => stage.apply(ctx(config), plan), (error) => error instanceof Error
        && "code" in error
        && error.code === "s06_policy_unknown_fields");
});
(0, node_test_1.default)("S06 treats image state from another machine as invalid and rebuilds", async () => {
    const { config, codexPath } = await prepareRoot();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-local");
    const stage = (0, configuration_1.createConfigurationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const imageStatePath = node_path_1.default.join(config.paths.setup_state_dir, "s06-agent-image.json");
    await node_fs_1.default.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
    await node_fs_1.default.promises.writeFile(imageStatePath, `${JSON.stringify({
        schema_version: 1,
        machine_id_hash: "machine-remote",
        image_digest: DIGEST_B,
        image_id: IMAGE_ID,
        build_context_hash: "bad-hash",
        codex_version: "0.32.0",
        base_image_digest: DIGEST_A,
        built_at: "2026-10-22T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");
    const plan = stage.plan(config, await stage.observe(ctx(config)));
    await stage.apply(ctx(config), plan);
    strict_1.default.equal(processAdapter.buildCalls, 1);
});
(0, node_test_1.default)("S06 blocks when codex login help probe fails", async () => {
    const { config, codexPath } = await prepareRoot();
    const processAdapter = new FakeProcessAdapter(codexPath, "0.32.0", DIGEST_B, "machine-A", false);
    const stage = (0, configuration_1.createConfigurationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const plan = stage.plan(config, await stage.observe(ctx(config)));
    await strict_1.default.rejects(async () => stage.apply(ctx(config), plan), (error) => error instanceof Error
        && "code" in error
        && error.code === "s06_codex_probe_failed"
        && error.exitCode === types_1.ExitCode.BlockedByMissingCapabilityOrEvidence);
});
