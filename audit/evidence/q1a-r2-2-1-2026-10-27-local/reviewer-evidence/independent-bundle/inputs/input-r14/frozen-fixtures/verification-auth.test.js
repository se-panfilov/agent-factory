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
const auth_1 = require("../../src/stages/auth");
const verification_1 = require("../../src/stages/verification");
class FakeProcessAdapter {
    flags;
    sourceSha;
    dockerRunCount = 0;
    constructor(flags, sourceSha) {
        this.flags = flags;
        this.sourceSha = sourceSha;
    }
    async runCommand(options) {
        if (options.binary === "/usr/bin/git" && options.args[2] === "rev-parse" && options.args[3] === "HEAD") {
            return this.ok(`${this.sourceSha}\n`);
        }
        if (options.binary === "/usr/bin/docker") {
            if (options.args[0] === "run") {
                this.dockerRunCount += 1;
                if (this.flags.authLoginFails) {
                    return this.fail("the input device is not a TTY");
                }
                if (options.args.includes("login")) {
                    return this.ok("login ok");
                }
                return this.ok("");
            }
            if (options.args[0] === "create") {
                return this.ok("container-id");
            }
            if (options.args[0] === "inspect") {
                return this.ok('[{"Destination":"/workspace/toy"}]');
            }
            if (options.args[0] === "rm") {
                if (this.flags.dockerCleanupFails) {
                    return this.fail("rm failed");
                }
                return this.ok("removed");
            }
            return this.ok("");
        }
        if (options.binary.endsWith("/node")) {
            const outputIndex = options.args.indexOf("--output");
            const outputPath = outputIndex >= 0 ? options.args[outputIndex + 1] : null;
            const providerIndex = options.args.indexOf("--provider");
            const provider = providerIndex >= 0 ? options.args[providerIndex + 1] : "fake";
            if (typeof outputPath === "string") {
                const payload = {
                    schema_version: 1,
                    provider,
                    fixture: "toy",
                    task: "scout",
                    source_sha: this.sourceSha,
                    status: this.flags.runnerStatus ?? (provider === "live" ? "needs_review" : "runner_ready_offline"),
                    terminal_events: ["runner.started", "runner.completed"],
                    run_id: `${provider}-run-id`,
                    usage: { daily_consumed: provider === "live" ? 1 : 0 }
                };
                await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(outputPath), { recursive: true });
                await node_fs_1.default.promises.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            }
            const stdout = this.flags.leakSecret ? "SYNTHETIC_SECRET_MARKER\n" : "";
            return this.ok(stdout);
        }
        return this.ok("");
    }
    pid() {
        return 42;
    }
    uid() {
        return 1000;
    }
    username() {
        return "factory";
    }
    async bootId() {
        return "4d445fab-6491-4d34-8ad3-c4d2d29f140f";
    }
    async machineIdHash() {
        return "1".repeat(64);
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
function makeConfig(root) {
    return {
        schema_version: 1,
        contract_version: "1.0.0",
        installation_id: "d2fcd753-997f-4034-84dd-c5182471ce08",
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
            application_state_dir: node_path_1.default.join(root, "app", "state"),
            application_auth_dir: node_path_1.default.join(root, "app", "auth"),
            application_work_dir: node_path_1.default.join(root, "work")
        },
        release: {
            archive_path: node_path_1.default.join(root, "release.tar.xz"),
            sha256: "a".repeat(64),
            source_commit: "b".repeat(40)
        },
        version_lock_path: node_path_1.default.join(root, "versions.lock.json"),
        selected_stages: ["S07", "S08"],
        resource_profile: "daily3",
        network: {
            mode: "cloud-only",
            allow_paid_fallback: false
        },
        secret_refs: {
            auth_dir: node_path_1.default.join(root, "app", "auth")
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
async function writeConfig(configPath, config) {
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(configPath), { recursive: true });
    await node_fs_1.default.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
async function prepareScenario(flags = {}) {
    const root = await node_fs_1.default.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "p08-verify-auth-"));
    const config = makeConfig(root);
    const configPath = node_path_1.default.join(root, "config", "setup.json");
    await writeConfig(configPath, config);
    await node_fs_1.default.promises.mkdir(node_path_1.default.join(config.paths.application_work_dir, "factory-toy-fixture"), { recursive: true });
    await node_fs_1.default.promises.mkdir(config.paths.application_dir, { recursive: true });
    await node_fs_1.default.promises.mkdir(config.paths.application_auth_dir, { recursive: true });
    await node_fs_1.default.promises.mkdir(node_path_1.default.join(config.paths.setup_node_dir, "bin"), { recursive: true });
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(config.paths.setup_node_dir, "bin", "node"), "#!/bin/sh\n", { mode: 0o700 });
    await node_fs_1.default.promises.mkdir(config.paths.setup_state_dir, { recursive: true });
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(config.paths.setup_state_dir, "s06-agent-image.json"), `${JSON.stringify({
        schema_version: 1,
        machine_id_hash: "1".repeat(64),
        image_digest: `sha256:${"c".repeat(64)}`,
        image_id: `sha256:${"d".repeat(64)}`,
        build_context_hash: "e".repeat(64),
        codex_version: "0.32.0",
        base_image_digest: `sha256:${"f".repeat(64)}`,
        built_at: "2026-10-22T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(config.paths.application_dir, "deployment-manifest.json"), `${JSON.stringify({
        schema_version: 1,
        application_version: "m0.0.1",
        source_commit: config.release.source_commit,
        content_hashes: { "runner.js": "1".repeat(64) },
        node_range: ">=24.0.0 <25",
        capabilities: ["runner-readonly", "runner-live-smoke"],
        commands: {
            runner_verify: ["node", "runner.js"],
            runner_stop: ["node", "runner.js", "stop"]
        },
        config_schema_version: 1,
        state_schema_version: 1,
        migrations: { from: 1, to: 1 },
        security_evidence_refs: ["docs/security/m0.md"]
    }, null, 2)}\n`, "utf8");
    const sourceSha = "e".repeat(40);
    const processAdapter = new FakeProcessAdapter(flags, sourceSha);
    const s00 = {
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
            return { stageId: "S00", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
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
    const s01 = {
        id: "S01",
        dependencies: ["S00"],
        supportedProfiles: ["supervised", "service"],
        optional: false,
        requiredCapabilities: [],
        async observe() {
            return {
                stageId: "S01",
                status: "verified",
                checks: { preflight_ok: true },
                versions: {},
                observedAt: new Date().toISOString()
            };
        },
        plan() {
            return { stageId: "S01", optional: false, requiredCapabilities: [], operations: [], requiredGates: [] };
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
    const s06 = {
        id: "S06",
        dependencies: ["S01"],
        supportedProfiles: ["supervised", "service"],
        optional: false,
        requiredCapabilities: ["runner-readonly"],
        async observe() {
            return {
                stageId: "S06",
                status: "verified",
                checks: { s06_ready: true },
                versions: {},
                observedAt: new Date().toISOString()
            };
        },
        plan() {
            return { stageId: "S06", optional: false, requiredCapabilities: ["runner-readonly"], operations: [], requiredGates: [] };
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
    const registry = (0, plan_1.createRegistry)([
        s00,
        s01,
        s06,
        (0, verification_1.createVerificationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter),
        (0, auth_1.createAuthStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter)
    ]);
    const engine = new engine_1.SetupEngine({
        fsAdapter: new filesystem_1.NodeFilesystemAdapter(),
        processAdapter,
        httpAdapter: { get: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("") }) },
        installerVersion: "0.0.1",
        clock: { now: () => new Date("2026-10-22T10:00:00.000Z") }
    }, registry);
    return { root, config, configPath, engine, processAdapter };
}
function ctx(config) {
    return {
        installationId: config.installation_id,
        contractVersion: "1.0.0",
        profile: "supervised",
        desiredHash: "a".repeat(64),
        planHash: "b".repeat(64),
        config
    };
}
(0, node_test_1.default)("S07 applies offline verification with fake provider and no-secret docker boundary", async () => {
    const { config, processAdapter } = await prepareScenario();
    const stage = (0, verification_1.createVerificationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const observed = await stage.observe(ctx(config));
    const plan = stage.plan(config, observed);
    const receipts = await stage.apply(ctx(config), plan);
    strict_1.default.equal(receipts.length, 1);
    strict_1.default.equal(receipts[0]?.checks.runner_ready_offline, true);
    const reportPath = node_path_1.default.join(config.paths.setup_state_dir, "s07-offline-verification.json");
    strict_1.default.equal(node_fs_1.default.existsSync(reportPath), true);
});
(0, node_test_1.default)("S07 fails on synthetic secret marker leak", async () => {
    const { config, processAdapter } = await prepareScenario({ leakSecret: true });
    const stage = (0, verification_1.createVerificationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const observed = await stage.observe(ctx(config));
    const plan = stage.plan(config, observed);
    await strict_1.default.rejects(async () => stage.apply(ctx(config), plan), (error) => error instanceof Error && "code" in error && error.code === "s08_secret_leak_detected");
});
(0, node_test_1.default)("S07 cleanup failure returns drift/recovery error", async () => {
    const { config, processAdapter } = await prepareScenario({ dockerCleanupFails: true });
    const stage = (0, verification_1.createVerificationStage)(new filesystem_1.NodeFilesystemAdapter(), processAdapter);
    const observed = await stage.observe(ctx(config));
    const plan = stage.plan(config, observed);
    await strict_1.default.rejects(async () => stage.apply(ctx(config), plan), (error) => error instanceof Error
        && "code" in error
        && error.code === "s07_cleanup_failed"
        && error.exitCode === types_1.ExitCode.DriftOrRecoveryRequired);
});
(0, node_test_1.default)("auth status reports presence only and never claims quota health", async () => {
    const { configPath, config, engine } = await prepareScenario();
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(config.paths.application_auth_dir, "token.json"), "{\"token\":\"x\"}\n", "utf8");
    const result = await engine.run("auth-status", { configPath });
    strict_1.default.equal(result.exitCode, types_1.ExitCode.Success, JSON.stringify(result.envelope));
    strict_1.default.equal(result.envelope.data?.authenticated, true);
    strict_1.default.equal(result.envelope.data?.quota_healthy, "unknown");
});
(0, node_test_1.default)("smoke live requires explicit gate approvals and apply/resume do not auto-login", async () => {
    const { configPath, engine, processAdapter } = await prepareScenario();
    const planResult = await engine.run("plan", { configPath, stageId: "S08" });
    strict_1.default.equal(planResult.exitCode, types_1.ExitCode.Success, JSON.stringify(planResult.envelope));
    const smoke = await engine.run("smoke", { configPath, provider: "live", fixture: "toy" });
    strict_1.default.equal(smoke.exitCode, types_1.ExitCode.ManualActionRequired, JSON.stringify(smoke.envelope));
    const resume = await engine.run("resume", { configPath, nonInteractive: true });
    strict_1.default.equal(resume.exitCode, types_1.ExitCode.BlockedByMissingCapabilityOrEvidence, JSON.stringify(resume.envelope));
    strict_1.default.equal(resume.envelope.error?.code, "entrypoint_policy_blocked");
    strict_1.default.equal(processAdapter.dockerRunCount, 0);
});
