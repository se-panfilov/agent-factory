"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.r14Process = exports.r14Clock = void 0;
exports.r14Noop = r14Noop;
exports.r14Fixture = r14Fixture;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const filesystem_1 = require("../../src/adapters/filesystem");
const config_1 = require("../../src/core/config");
const engine_1 = require("../../src/core/engine");
const plan_1 = require("../../src/core/plan");
exports.r14Clock = { now: () => new Date("2026-10-24T10:00:00Z") };
exports.r14Process = {
    pid: () => process.pid, uid: () => 1000, username: () => "factory",
    bootId: async () => "f324dcd7-4035-4430-ab39-ce31f9e396bf", machineIdHash: async () => "a".repeat(64),
    processStartTicks: async () => 1, isPidAlive: () => true,
    runCommand: async () => { throw new Error("Real commands forbidden in R14 fixture"); }
};
function r14Noop(id) {
    return { id, dependencies: [], supportedProfiles: ["supervised", "service"], optional: false, requiredCapabilities: [],
        observe: async () => ({ stageId: id, status: "verified", checks: {}, versions: {}, observedAt: exports.r14Clock.now().toISOString() }),
        plan: () => ({ stageId: id, optional: false, requiredCapabilities: [], operations: [], requiredGates: [] }),
        apply: async () => [], verify: async () => [], recover: async () => [] };
}
async function r14Fixture(stageId) {
    const root = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "af-r14-"));
    const configPath = node_path_1.default.join(root, "config.json"), f = new filesystem_1.NodeFilesystemAdapter();
    const config = await (0, config_1.initConfig)(f, configPath, "supervised", "factory");
    const paths = {
        setup_state_dir: node_path_1.default.join(root, "state"), setup_cache_dir: node_path_1.default.join(root, "cache"),
        setup_bin_dir: node_path_1.default.join(root, "bin"), setup_node_dir: node_path_1.default.join(root, "node"),
        application_dir: node_path_1.default.join(root, "app"), application_state_dir: node_path_1.default.join(root, "app/state"),
        application_auth_dir: node_path_1.default.join(root, "app/auth"), application_work_dir: node_path_1.default.join(root, "work")
    };
    config.paths = paths;
    config.secret_refs.auth_dir = paths.application_auth_dir;
    config.release.archive_path = node_path_1.default.join(root, "release.tar");
    config.version_lock_path = node_path_1.default.join(root, "versions.json");
    config.selected_stages = [stageId];
    await promises_1.default.writeFile(configPath, JSON.stringify(config));
    const engine = (stages) => new engine_1.SetupEngine({ fsAdapter: f, processAdapter: exports.r14Process, clock: exports.r14Clock }, (0, plan_1.createRegistry)(stages));
    const planAndApprove = async (e) => {
        const result = await e.run("plan", { configPath });
        if (result.exitCode !== 0)
            throw new Error(JSON.stringify(result));
        const plan = JSON.parse(await promises_1.default.readFile(node_path_1.default.join(paths.setup_state_dir, "plan.json"), "utf8"));
        for (const id of new Set(plan.stages.flatMap(s => [...s.required_gates, ...s.operations.flatMap(o => o.gate_ids)]))) {
            const approved = await e.run("gate-approve", { configPath, gateId: id, planHash: plan.plan_hash });
            if (approved.exitCode !== 0)
                throw new Error(JSON.stringify(approved));
        }
        return plan;
    };
    return { root, config, configPath, f, engine, planAndApprove,
        applyOptions: { configPath, planPath: node_path_1.default.join(paths.setup_state_dir, "plan.json") },
        state: async () => JSON.parse(await promises_1.default.readFile(node_path_1.default.join(paths.setup_state_dir, "state.json"), "utf8")) };
}
