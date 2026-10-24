import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { type ProcessAdapter } from "../../src/adapters/process";
import { initConfig } from "../../src/core/config";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { type StageId, type StageModule, type SetupConfig } from "../../src/core/types";

export const r14Clock = { now: () => new Date("2026-10-24T10:00:00Z") };
export const r14Process: ProcessAdapter = {
  pid: () => process.pid, uid: () => 1000, username: () => "factory",
  bootId: async () => "f324dcd7-4035-4430-ab39-ce31f9e396bf", machineIdHash: async () => "a".repeat(64),
  processStartTicks: async () => 1, isPidAlive: () => true,
  runCommand: async () => { throw new Error("Real commands forbidden in R14 fixture"); }
};
export function r14Noop(id: StageId): StageModule {
  return { id, dependencies: [], supportedProfiles: ["supervised", "service"], optional: false, requiredCapabilities: [],
    observe: async () => ({ stageId: id, status: "verified", checks: {}, versions: {}, observedAt: r14Clock.now().toISOString() }),
    plan: () => ({ stageId: id, optional: false, requiredCapabilities: [], operations: [], requiredGates: [] }),
    apply: async () => [], verify: async () => [], recover: async () => [] };
}
export async function r14Fixture(stageId: StageId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "af-r14-"));
  const configPath = path.join(root, "config.json"), f = new NodeFilesystemAdapter();
  const config = await initConfig(f, configPath, "supervised", "factory");
  const paths: SetupConfig["paths"] = {
    setup_state_dir: path.join(root, "state"), setup_cache_dir: path.join(root, "cache"),
    setup_bin_dir: path.join(root, "bin"), setup_node_dir: path.join(root, "node"),
    application_dir: path.join(root, "app"), application_state_dir: path.join(root, "app/state"),
    application_auth_dir: path.join(root, "app/auth"), application_work_dir: path.join(root, "work")
  };
  config.paths = paths; config.secret_refs.auth_dir = paths.application_auth_dir;
  config.release.archive_path = path.join(root, "release.tar"); config.version_lock_path = path.join(root, "versions.json");
  config.selected_stages = [stageId];
  await fs.writeFile(configPath, JSON.stringify(config));
  const engine = (stages: StageModule[]) => new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: r14Clock }, createRegistry(stages));
  const planAndApprove = async (e: SetupEngine) => {
    const result = await e.run("plan", { configPath });
    if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
    const plan = JSON.parse(await fs.readFile(path.join(paths.setup_state_dir, "plan.json"), "utf8")) as import("../../src/core/types").InstallerPlan;
    for (const id of new Set(plan.stages.flatMap(s => [...s.required_gates, ...s.operations.flatMap(o => o.gate_ids)]))) {
      const approved = await e.run("gate-approve", { configPath, gateId: id, planHash: plan.plan_hash });
      if (approved.exitCode !== 0) throw new Error(JSON.stringify(approved));
    }
    return plan;
  };
  return { root, config, configPath, f, engine, planAndApprove,
    applyOptions: { configPath, planPath: path.join(paths.setup_state_dir, "plan.json") },
    state: async () => JSON.parse(await fs.readFile(path.join(paths.setup_state_dir, "state.json"), "utf8")) as import("../../src/core/types").SetupState };
}
