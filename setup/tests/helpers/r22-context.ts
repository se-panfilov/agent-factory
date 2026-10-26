// Explicit fixture inputs, never a production context bypass.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { type ExecutionPlan, type InstallerPlan, type SetupConfig } from "../../src/core/types";
import { decodePlan, encodePlan, nativePlanHash } from "../../src/core/plan-format";
export async function fixtureContextFiles(config: SetupConfig, release = false): Promise<void> {
  await fs.mkdir(path.dirname(config.version_lock_path), { recursive: true });
  try { await fs.access(config.version_lock_path); } catch { await fs.copyFile(path.resolve(__dirname, "../../../versions.lock.json"), config.version_lock_path); }
  if (release && !await fs.access(config.release.archive_path).then(() => true, () => false)) {
    const bytes = Buffer.from("owned synthetic release artifact; no build or host effects\n");
    await fs.mkdir(path.dirname(config.release.archive_path), { recursive: true });
    await fs.writeFile(config.release.archive_path, bytes);
    config.release.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
}
export function parseFixturePlan(raw: string): ExecutionPlan { return decodePlan(JSON.parse(raw) as InstallerPlan); }
export function stringifyFixturePlan(plan: ExecutionPlan): string { return JSON.stringify(encodePlan(plan)); }
export function rehashFixturePlan(plan: ExecutionPlan): void {
  const native = encodePlan(plan); plan.plan_hash = nativePlanHash(native);
}

export async function reviewAndFirstRefusal(x: { configPath: string; applyOptions: { planPath: string } }, engine: import("../../src/core/engine").SetupEngine) {
  const planned = await engine.run("plan", { configPath: x.configPath });
  if (planned.exitCode !== 0) return planned;
  const plan = parseFixturePlan(await fs.readFile(x.applyOptions.planPath, "utf8"));
  for (const gateId of new Set(plan.stages.flatMap(stage => [...stage.required_gates, ...stage.operations.flatMap(operation => operation.gate_ids)]))) {
    const approved = await engine.run("gate-approve", { configPath: x.configPath, gateId, planHash: plan.plan_hash });
    if (approved.exitCode !== 0) return approved;
  }
  return engine.run("apply", { configPath: x.configPath, planPath: x.applyOptions.planPath });
}
