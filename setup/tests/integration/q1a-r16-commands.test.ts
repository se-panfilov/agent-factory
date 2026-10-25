import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { commandFixture } from "../helpers/r16-commands";

for (const entry of ["runner.cjs", "runner"]) {
  test(`W02/W03 prepared Node entry is the checked absolute deployment file: ${entry}`, async () => {
    const q = await commandFixture(entry); await q.materialize();
    assert.equal(q.schema().ok, true);
    const result = await q.probe();
    assert.equal(result.runnerVerifyHelpOk && result.runnerStopHelpOk, true);
    assert.equal(q.invocations.length, 2);
    for (const call of q.invocations) assert.equal(call.args[0], path.join(q.x.config.paths.application_dir, entry));
  });
}
test("W04 hashed --eval filename is refused before executable child", async () => {
  const q = await commandFixture("--eval"); await q.materialize();
  q.a.release.manifest!.commands.runner_verify = ["node", "--eval", 'process.stdout.write("INLINE_TRAP")', "--"];
  assert.equal(q.schema().ok, true);
  await assert.rejects(q.probe(), {exitCode:9});
  assert.equal(q.invocations.length, 0); assert.equal(q.calls(), 0);
});

import fs from "node:fs/promises";
import os from "node:os";
import { fork } from "node:child_process";
import { type Invocation, digest, reviewedBody, success } from "../helpers/r16-commands";
import { prepareOfflineCommands } from "../../src/adapters/git";
import { r14Noop } from "../helpers/r14-engine";

interface ChildSpec { entry: string; pinned?: boolean; decoy?: boolean; args?: string[]; direct?: boolean; mixed?: boolean; engine?: boolean }
interface ChildResult { ok: boolean; schema_valid: boolean; entry: string; hashed_path: string; pinned: string; spec: ChildSpec; invocations: Invocation[] }
async function realChild(spec: ChildSpec): Promise<ChildResult> {
  const caller = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "r16-caller-")));
  const dist = path.resolve(__dirname, "../..");
  const child = fork(path.resolve(__dirname, "../../../tests/helpers/r16-command-child.cjs"), [dist, JSON.stringify(spec)],
    {cwd: caller, env: {PATH: "/usr/bin:/bin", LC_ALL: "C"}, stdio: ["ignore", "pipe", "pipe", "ipc"]});
  let stderr = "", result: ChildResult | undefined;
  child.stderr!.on("data", b => {stderr += String(b);});
  child.stdout!.on("data", b => {stderr += String(b);});
  child.on("message", message => {result = message as ChildResult;});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {child.kill("SIGKILL"); reject(Error("Owned Node fixture exceeded 20s deadline"));}, 20_000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("exit", code => {clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Owned child exit ${code}: ${stderr}`));});
  });
  assert.ok(result?.ok, stderr); assert.equal(result.schema_valid, true);
  assert.ok(result.invocations.length >= 2);
  for (const call of result.invocations) {
    assert.equal(call.result.exitCode, 0, call.result.stderr);
    assert.equal(call.cwd, caller);
    const output = JSON.parse(call.result.stdout) as {marker: string; entry: string; args: string[]};
    assert.equal(output.marker, "REVIEWED_ENTRY");
    assert.deepEqual(output.args, [...(spec.args ?? []), "--help"]);
    if (call.binary === result.pinned) {
      assert.equal(call.args[0], result.hashed_path);
      assert.equal(output.entry, result.hashed_path);
    } else {
      assert.equal(call.binary, path.join(path.dirname(result.hashed_path), spec.mixed ? "bin/check" : path.basename(result.hashed_path)));
      assert.deepEqual(call.args, [...(spec.args ?? []), "--help"]);
    }
    assert.notEqual(path.dirname(result.hashed_path), caller);
  }
  console.log("R16_REAL_COMMAND " + JSON.stringify(result));
  return result;
}
for (const entry of ["runner.js", "runner.mjs", "runner.ts"]) for (const pinned of [false, true]) {
  test(`W01 real Node checked ${entry}, ${pinned ? "exact pinned path" : "short node"}`, async () => {await realChild({entry, pinned, decoy: true});});
}
for (const pinned of [false, true]) test(`W02 real Node cjs CWD decoy never runs (${pinned ? "pinned" : "short"})`, async () => {await realChild({entry: "runner.cjs", pinned, decoy: true});});
for (const decoy of [false, true]) test(`W03 real Node extensionless remains functional, CWD decoy=${decoy}`, async () => {await realChild({entry: "runner", decoy});});
test("W07 real Node nested dash filename and application argv boundaries", async () => {
  await realChild({entry: "bin/-runner.cjs", decoy: true, args: ["two words", 'literal"quote', "--eval", "--require", "x.js", "--"]});
});
for (const mixed of [false, true]) test(`W10 real confined native executable and preserved native args, mixed=${mixed}`, async () => {
  await realChild({entry: mixed ? "runner.cjs" : "bin/check", direct: !mixed, mixed, args: ["relative.js", "--eval", "two words"]});
});
test("W09 real S05 engine-created evidence with cjs and CWD decoy supports full lifecycle", async () => {
  const result = await realChild({entry: "runner.cjs", decoy: true, engine: true});
  assert.ok(result.invocations.length > 2, "observe/verify/replan probes must remain mandatory");
});

const optionEntries = ["--eval", "-e", "-p", "--eval=1", "--print", "--require", "--import", "--inspect", "--input-type=module", "--env-file=fixture", "-", "--"];
for (const key of ["runner_verify", "runner_stop"] as const) {
  test(`W05 every option-shaped entry is rejected before any executable (${key})`, async () => {
    for (const entry of optionEntries) {
      const q = await commandFixture(entry); await q.materialize();
      q.files["runner.js"] = reviewedBody; q.a.release.manifest!.content_hashes["runner.js"] = digest(reviewedBody);
      await fs.writeFile(path.join(q.x.config.paths.application_dir, "runner.js"), reviewedBody, {mode:0o600});
      q.a.release.manifest!.commands = {runner_verify: ["node", "runner.js"], runner_stop: ["node", "runner.js"]};
      q.a.release.manifest!.commands[key] = ["node", entry, "harmless never executed", "--"];
      assert.equal(q.schema().ok, true);
      await assert.rejects(q.probe(), {exitCode: 9, code: "s05_command_content_unbound"});
      assert.equal(q.invocations.length, 0, `${key}/${entry}`);
      console.log("R16_REFUSAL " + JSON.stringify({key, entry, executable_calls: q.invocations.length, schema_valid: true, exit: 9}));
    }
  });
}
test("W06 grammar refuses unlisted, absolute, traversal, separators, NUL and external executables", async () => {
  const q = await commandFixture(); await q.materialize();
  for (const argv of [["node", "unlisted.cjs"], ["node", "/tmp/foreign"], ["node", "../runner.cjs"], ["node", "a//b"], ["node", "./runner.cjs"], ["node", "a/../b"], ["node", "a\\b"], ["node", "a\0b"], ["/usr/bin/env", "node", "runner.cjs"], ["sudo", "node", "runner.cjs"], ["/bin/sh", "runner.cjs"], ["node", ""]]) {
    q.a.release.manifest!.commands = {runner_verify: argv, runner_stop: argv};
    await assert.rejects(q.probe(), {exitCode:9,code:"s05_command_content_unbound"}); assert.equal(q.calls(), 0); assert.equal(q.invocations.length, 0, JSON.stringify(argv));
  }
});
for (const fault of ["missing", "symlink", "unsafe-mode", "wrong-owner", "special"]) test(`W06 bound entry metadata ${fault} refuses before executable`, async () => {
  const q = await commandFixture(); await q.materialize(); const target = path.join(q.x.config.paths.application_dir, "runner.cjs");
  if (fault === "missing") await fs.unlink(target);
  if (fault === "symlink") {await fs.rename(target, target + ".safe"); await fs.symlink(target + ".safe", target);}
  if (fault === "unsafe-mode") await fs.chmod(target, 0o666);
  if (fault === "wrong-owner" || fault === "special") {
    const lstat = q.x.f.lstat.bind(q.x.f);
    q.x.f.lstat = async file => {const stat = await lstat(file); if (file === target) Object.defineProperty(stat, fault === "wrong-owner" ? "uid" : "isFile", {value: fault === "wrong-owner" ? 99999 : () => false}); return stat;};
  }
  await assert.rejects(q.probe(), {exitCode: 9, code: "s05_deployed_integrity_failed"}); assert.equal(q.invocations.length, 0); assert.equal(q.calls(), 0);
});
test("W07 prepared identity has extension-independent absolute entry and immutable exact argv", async () => {
  const q = await commandFixture("bin/-runner.cjs");
  const args = ["space value", 'literal"quote', "--eval", "x.js"];
  q.a.release.manifest!.commands.runner_verify = [q.pinned, "bin/-runner.cjs", ...args];
  const prepared = prepareOfflineCommands(q.x.config.paths.application_dir, q.a.release.manifest!, q.x.config).runner_verify;
  assert.equal(prepared.kind, "node"); assert.equal(prepared.contentEntry, "bin/-runner.cjs"); assert.equal(prepared.executable, q.pinned);
  assert.deepEqual(prepared.args, [path.join(q.x.config.paths.application_dir, "bin/-runner.cjs"), ...args, "--help"]);
  assert.equal(Object.isFrozen(prepared) && Object.isFrozen(prepared.args), true);
});
test("W08 bytes drift after first help refuses second help without overall success", async () => {
  const q = await commandFixture(); await q.materialize();
  q.onCommand(async () => {await fs.writeFile(path.join(q.x.config.paths.application_dir, "runner.cjs"), "tampered"); return success();});
  await assert.rejects(q.probe(), {exitCode: 9, code: "s05_deployed_integrity_failed"});
  assert.equal(q.invocations.length, 1);
});

import { createApplicationStage } from "../../src/stages/application";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { r14Process, r14Clock } from "../helpers/r14-engine";
import { type StageContext } from "../../src/core/types";
for (const key of ["runner_verify", "runner_stop"] as const) test(`W09 engine-bound invalid ${key}: no command, successful probe proof or downstream`, async () => {
  const q = await commandFixture("--eval", {downstream: true});
  q.files["runner.js"] = reviewedBody; q.a.release.manifest!.content_hashes["runner.js"] = digest(reviewedBody);
  q.a.release.manifest!.commands = {runner_verify:["node","runner.js"], runner_stop:["node","runner.js"]};
  q.a.release.manifest!.commands[key] = ["node", "--eval", 'process.stdout.write("INLINE_TRAP")', "--"];
  assert.equal(q.schema().ok, true);
  const actualStage = createApplicationStage(q.a);
  let boundContext: StageContext | undefined;
  const apply = actualStage.apply.bind(actualStage);
  actualStage.apply = async (ctx, plan) => {if (plan.operations.some(o => o.id.includes("probe-release"))) boundContext = ctx; return apply(ctx, plan);};
  const trap = r14Noop("S06"); trap.dependencies = ["S05"];
  let downstreamCalls = 0;
  trap.plan = () => ({stageId:"S06",optional:false,requiredCapabilities:[],requiredGates:[],operations:[{id:"downstream",stageId:"S06",kind:"mutate",resourceId:"trap",risk:"low",gateIds:[],preconditions:[],sideEffects:["trap"],timeoutSec:1,retryable:false}]});
  trap.apply = async () => {downstreamCalls++; throw Error("Forbidden downstream");};
  const e = new SetupEngine({fsAdapter:q.x.f,processAdapter:r14Process,clock:r14Clock}, createRegistry([r14Noop("S04"), actualStage, trap]));
  await q.x.planAndApprove(e);
  const applied = await e.run("apply", q.x.applyOptions);
  assert.equal(applied.exitCode, 9, JSON.stringify(applied));
  assert.equal(applied.envelope.error?.code, "s05_command_content_unbound");
  assert.ok(boundContext?.completedOperationReceipts?.some(r => r.resourceId === "application-checkout"), "must come from completed engine checkpoint, not a drawn receipt");
  for (const call of [() => actualStage.observe(boundContext!), () => actualStage.verify(boundContext!)]) {
    await assert.rejects(call(), {exitCode:9,code:"s05_command_content_unbound"});
  }
  const journal = (await fs.readFile(path.join(q.x.config.paths.setup_state_dir,"events.jsonl"),"utf8")).trim().split("\n").map(l => JSON.parse(l) as {operation_id?:string; code?:string});
  assert.equal(journal.some(r => r.operation_id?.includes("materialize-checkout") && r.code === "checkpoint"), true);
  assert.equal(journal.some(r => r.operation_id?.includes("probe-release") && r.code === "intent"), true);
  assert.equal(journal.some(r => r.operation_id?.includes("probe-release") && ["verify","checkpoint"].includes(r.code ?? "")), false);
  assert.notEqual((await q.x.state()).stages.find(s => s.id === "S05")?.status, "verified");
  for (const command of ["plan", "verify", "status", "apply", "resume"] as const) {
    const result = await e.run(command, command === "apply" ? q.x.applyOptions : {configPath:q.x.configPath,...(command === "status" ? {refresh:true} : {})});
    assert.notEqual(result.exitCode, 0, `${command} cannot bypass failed probe/unknown journal`);
  }
  assert.equal(q.invocations.length, 0); assert.equal(q.calls(), 0); assert.equal(downstreamCalls, 0);
  const statePath = path.join(q.x.config.paths.setup_state_dir,"state.json");
  const before = await fs.readFile(statePath);
  await e.run("status", {configPath:q.x.configPath});
  assert.deepEqual(await fs.readFile(statePath), before); assert.equal(q.invocations.length, 0); assert.equal(q.calls(), 0);
});
for (const mode of ["false", "timeout", "throw", "missing"] as const) test(`W11 real S05 producer preserves typed ${mode} probe failure`, async () => {
  const q = await commandFixture();
  if (mode === "missing") delete q.a.release.manifest!.commands.runner_stop;
  else q.onCommand(async () => {
    if (mode === "throw") throw Error("owned synthetic process failure");
    return {...success(), exitCode:mode === "false" ? 1 : 0, timedOut: mode === "timeout"};
  });
  const e = q.makeEngine(); await q.x.planAndApprove(e);
  const result = await e.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, mode === "throw" ? 6 : 5, JSON.stringify(result));
  assert.equal(q.calls(), mode === "missing" ? 0 : mode === "throw" ? 1 : 2);
  console.log("R16_PROBE_CONTROL " + JSON.stringify({mode, exit:result.exitCode, executable_calls:q.calls()}));
  assert.notEqual((await q.x.state()).stages.find(s => s.id === "S05")?.status, "verified");
});
