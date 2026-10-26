// Owned subprocess fixture: disk facts persist across all engine and process instances.
import { parseFixturePlan } from "./r22-context";
import fs from "node:fs/promises";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { accessEngine, type Phase } from "./r211-access";
import { type SetupConfig, type ExecutionPlan } from "../../src/core/types";

async function main() {
  const [root, command, pause, barrier] = process.argv.slice(2);
  if (!root || !command) throw Error("root and command required");
  const configPath = path.join(root, "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as SetupConfig;
  let hit = false;
  async function stop(phase: string, exactPath: string) {
    if (hit || phase !== barrier) return;
    hit = true;
    process.send?.({ type: "barrier", phase, path: exactPath, pid: process.pid });
    await new Promise<void>(resolve => process.once("message", () => resolve()));
  }
  const delegate = new NodeFilesystemAdapter();
  const proxy = new Proxy(delegate, { get(target, key) {
    if (key === "fsyncFile") return async (p: string) => {
      await target.fsyncFile(p);
      if (p.endsWith("events.jsonl")) {
        const events = (await fs.readFile(p, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {code: string});
        if (events.at(-1)?.code === "checkpoint") await stop("checkpoint", p);
      }
    };
    if (key === "fsyncDir") return async (p: string) => {
      await target.fsyncDir(p);
      const manifestPath = path.join(config.paths.setup_state_dir, "state-commit.json");
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {completed_operations?: unknown[]};
        if (manifest.completed_operations?.length === 1) await stop("binding", manifestPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = accessEngine(root, config, {
    fs: proxy,
    ...(pause && pause !== "none" ? { pause: pause as Phase } : {}),
    afterEffect: async phase => {
      if (barrier === phase) {
        await stop(phase, path.join(root, "facts.json"));
      }
    }
  });
  const result = await engine.run(command === "review" ? "plan" : command === "unlock" ? "recover" : command,
    { configPath, ...(command === "apply" ? { planPath: path.join(config.paths.setup_state_dir, "plan.json") } : {}),
      ...(command === "unlock" ? { lockOnly: true } : {}) });
  if (command === "review" && result.exitCode === 0) {
    const p = parseFixturePlan(await fs.readFile(path.join(config.paths.setup_state_dir, "plan.json"), "utf8"));
    for (const id of new Set(p.stages.flatMap(s => s.required_gates))) {
      const approved = await engine.run("gate-approve", { configPath, gateId: id, planHash: p.plan_hash });
      if (approved.exitCode !== 0) throw Error(JSON.stringify(approved));
    }
  }
  console.log(JSON.stringify({ pid: process.pid, result }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
