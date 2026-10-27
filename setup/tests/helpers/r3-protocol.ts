import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { type FilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { r14Fixture, r14Noop, r14Process } from "./r14-engine";
import { FakeApplicationAdapter, makeCheckout, makeRelease } from "./r15-application";
import { createApplicationStage } from "../../src/stages/application";

export function proxyFs(f: FilesystemAdapter, overrides: Partial<FilesystemAdapter>): FilesystemAdapter {
  return new Proxy(f, { get(t, key) {
    if (key in overrides) return Reflect.get(overrides, key);
    const v: unknown = Reflect.get(t, key);
    return typeof v === "function" ? v.bind(t) : v;
  } });
}
export const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, durationMs: 0 });
/** Current files + genuine engine/journal/checkpoint S05 publication; no hand-drawn deployment receipt. */
export async function trustedEmergencyFixture() {
  const x = await r14Fixture("S05"), a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
  const body = "// owned synthetic stop/status entry; only injected process adapter executes\n";
  const manifest = a.release.manifest!;
  manifest.content_hashes = { "runner.cjs": createHash("sha256").update(body).digest("hex") };
  manifest.capabilities = ["runner-readonly", "app-status"];
  manifest.commands = { runner_verify: ["node", "runner.cjs", "verify"], runner_stop: ["node", "runner.cjs", "stop"], app_status: ["node", "runner.cjs", "status"] };
  const write = async (root: string) => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, "runner.cjs"), body, { mode: 0o600 });
    await fs.writeFile(path.join(root, "deployment-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  };
  a.extractArchive = async (_config, target) => { await write(path.join(target, "release")); a.extractCalls++; };
  a.materializeRelease = async () => { await write(x.config.paths.application_dir); a.checkout.exists = true; a.checkout.deployedSourceCommit = x.config.release.source_commit; a.materializeCalls++; };
  const e = x.engine([r14Noop("S04"), createApplicationStage(a)]);
  await x.planAndApprove(e);
  const applied = await e.run("apply", x.applyOptions);
  if (applied.exitCode !== 0) throw Error(JSON.stringify(applied));
  const pin = path.join(x.config.paths.setup_node_dir, "bin", "node");
  await fs.mkdir(path.dirname(pin), { recursive: true, mode: 0o700 });
  await fs.writeFile(pin, "owned synthetic installed Node pin; never executed\n", { mode: 0o700 });
  const lock = JSON.parse(await fs.readFile(x.config.version_lock_path, "utf8")) as { node: { version: string; sha256: string } };
  await fs.writeFile(path.join(x.config.paths.setup_state_dir, "bootstrap-receipt.json"), JSON.stringify({ contract_version: "1.0.0", stage_id: "S00", node_prefix: x.config.paths.setup_node_dir, node_version: lock.node.version, node_sha256: lock.node.sha256 }), { mode: 0o600 });
  const calls: CommandOptions[] = [], stopped = new Set<string>();
  let hook: ((command: CommandOptions) => Promise<CommandResult | undefined>) | undefined;
  const proc: ProcessAdapter = { ...r14Process, nodeRuntime: async () => ({ executable: pin, version: lock.node.version, binarySha256: createHash("sha256").update("owned synthetic installed Node pin; never executed\n").digest("hex") }), runCommand: async command => {
    calls.push(command);
    const overridden = await hook?.(command);
    if (overridden) return overridden;
    if (command.binary === pin) return ok(command.args.at(-1) === "status" ? JSON.stringify({ status: "stopped", installation_id: x.config.installation_id }) : "");
    if (command.binary === "/usr/bin/docker") {
      const id = command.args.at(-1)!;
      if (command.args[0] === "ps") return ok("a".repeat(12) + "\n" + "b".repeat(12) + "\n");
      if (command.args[0] === "inspect") return ok(JSON.stringify({ Id: id.padEnd(64, id[0]), Config: { Labels: { "agent-factory.installation_id": id[0] === "a" ? x.config.installation_id : "11111111-2222-4333-8444-555555555555" } }, State: { Running: !stopped.has(id) } }));
      if (command.args[0] === "stop") { stopped.add(id); return ok(id); }
    }
    throw Error("Unapproved fixture command");
  } };
  const inventory = async () => fs.writeFile(path.join(x.config.paths.setup_state_dir, "s11-emergency-inventory.json"), JSON.stringify({ schema_version: 1, installation_id: x.config.installation_id, owned_container_labels: [`agent-factory.installation_id=${x.config.installation_id}`], service_unit: null }), { mode: 0o600 });
  return { x, proc, pin, calls, manifest, a, inventory, stopped, onCommand: (value: typeof hook) => { hook = value; } };
}
