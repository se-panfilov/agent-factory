import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { aptFixture, evidence } from "../helpers/r21-admission";
import { r14Process, r14Noop, r14Fixture, r14Clock } from "../helpers/r14-engine";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry, loadPlan, validatePlanConsistency } from "../../src/core/plan";
import { createSystemStage } from "../../src/stages/system";
import { validateContractSchema } from "../../src/core/validators";
import { nativePlanHash, canonicalHash, encodePlan } from "../../src/core/plan-format";
import { type InstallerPlan } from "../../src/core/types";
import { FakeApplicationAdapter, makeCheckout, makeRelease } from "../helpers/r15-application";
import { createApplicationStage } from "../../src/stages/application";

async function fixture() {
  const q = await aptFixture();
  const identity = { machine: await r14Process.machineIdHash(), boot: await r14Process.bootId(), session: "owner-login-one", uid: 1000, user: "factory", os: "ubuntu-24.04", arch: "amd64" };
  const proc = { ...r14Process, machineIdHash: async () => identity.machine, bootId: async () => identity.boot,
    loginSessionId: async () => identity.session, uid: () => identity.uid, username: () => identity.user,
    hostIdentity: async () => ({ os: identity.os, arch: identity.arch }) };
  const make = () => new SetupEngine({ fsAdapter: q.x.f, processAdapter: proc, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)]));
  return { ...q, identity, proc, make };
}
async function native(q: Awaited<ReturnType<typeof fixture>>): Promise<InstallerPlan> {
  return JSON.parse(await fs.readFile(q.x.applyOptions.planPath, "utf8")) as InstallerPlan;
}
async function write(q: Awaited<ReturnType<typeof fixture>>, plan: InstallerPlan) { plan.plan_hash = nativePlanHash(plan); await fs.writeFile(q.x.applyOptions.planPath, JSON.stringify(plan)); }
async function refuseWithoutEffects(q: Awaited<ReturnType<typeof fixture>>, command: "apply" | "gate-approve" | "resume" = "apply") {
  const before = await evidence(q.x.config), counts = { ...q.counts }, plan = await native(q);
  const result = await q.make().run(command, command === "apply" ? q.x.applyOptions : command === "resume" ? { configPath: q.x.configPath }
    : { configPath: q.x.configPath, gateId: "s02-sudo-apt-update", planHash: plan.plan_hash });
  assert.notEqual(result.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(q.counts, counts); assert.deepEqual(await evidence(q.x.config), before, "no intent/evidence mutation on pre-admission refusal");
  console.log("R22_REFUSAL " + JSON.stringify({ command, exit: result.exitCode, code: result.envelope.error?.code, counts, before, after: await evidence(q.x.config) }));
  return result;
}
test("A22-01 native C13 is the complete serialized source; canonical round-trip and closed concrete operations", async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); const plan = await native(q);
  assert.equal(validateContractSchema("plan", plan).ok, true); assert.equal("stages" in plan, false); assert.equal("created_at" in plan, false);
  assert.deepEqual(plan.operations.map(operation => operation.kind), ["apt.refresh", "apt.simulate", "apt.install"]);
  assert.deepEqual(plan.stage_scope.map(stage => stage.stage_id), ["S01", "S02"]);
  const parsed = await loadPlan(q.x.f, q.x.applyOptions.planPath); validatePlanConsistency(q.x.config, parsed);
  assert.deepEqual(encodePlan(parsed), plan); assert.equal(nativePlanHash(plan), plan.plan_hash);
  assert.equal(canonicalHash({ b: { z: 1, a: 2 }, a: 3 }), canonicalHash({ a: 3, b: { a: 2, z: 1 } }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0); assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
});
test("A22-01/08 native action/operation/target tampering with recomputed hash never authorizes APT", async () => {
  const edits: Array<[string, (plan: InstallerPlan) => void]> = [
    ["duplicate", p => { p.operations.push(structuredClone(p.operations[0]!)); }],
    ["foreign stage", p => { p.operations[0]!.stage_id = "S03"; }],
    ["different action", p => { p.operations[0]!.kind = "access.install"; p.operations[0]!.expected_after.action = "access.install"; }],
    ["wrong postcondition", p => { p.operations[0]!.expected_after.action = "apt.install"; }],
    ["both gate lists", p => { p.stage_scope.forEach(stage => { stage.requires_gates = []; }); p.operations.forEach(operation => { operation.requires_gates = []; }); }],
    ["resource", p => { p.operations[0]!.resources = ["other"]; }], ["skip simulation", p => { p.operations.splice(1, 1); }],
    ["subset/noop dependency", p => { p.stage_scope.shift(); }], ["order", p => { p.stage_scope.reverse(); }],
    ["target", p => { p.target = { mode: "explicit", stage_id: "S02" }; }]
  ];
  for (const [name, edit] of edits) {
    const q = await fixture(); await q.x.planAndApprove(q.make()); const p = await native(q); edit(p); await write(q, p);
    const result = await refuseWithoutEffects(q); assert.ok([2, 8].includes(result.exitCode), name);
  }
});
test("A22-01 schema unknown field/action and duplicate/invalid dates are not execution extensions", async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); const plan = await native(q);
  for (const edit of [ (p: Record<string, unknown>) => { p.extra = true; }, (p: Record<string, unknown>) => { p.operations = [{ ...plan.operations[0], kind: "shell.exec" }]; } ]) {
    const bad = structuredClone(plan) as unknown as Record<string, unknown>; edit(bad); assert.equal(validateContractSchema("plan", bad).ok, false);
  }
});
for (const change of ["machine", "boot", "login", "uid", "user", "os", "arch", "missing-machine", "missing-session"] as const) test(`A22-03/04/09 ${change}: old approval cannot authorize another context`, async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make());
  if (change === "machine") q.identity.machine = "b".repeat(64);
  if (change === "boot") q.identity.boot = "fe6d5e7a-2737-4898-9c8b-97f09a7a54a7";
  if (change === "login") q.identity.session = "owner-login-two";
  if (change === "uid") q.identity.uid = 0;
  if (change === "user") q.identity.user = "foreign";
  if (change === "os") q.identity.os = "other-os";
  if (change === "arch") q.identity.arch = "arm64";
  if (change === "missing-machine") q.identity.machine = "";
  if (change === "missing-session") q.identity.session = "";
  await refuseWithoutEffects(q); await refuseWithoutEffects(q, "gate-approve");
  if (["boot", "login"].includes(change)) {
    await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0);
    assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
  }
});
for (const change of ["replace", "missing", "invalid", "truncated", "symlink"] as const) test(`A22-05 actual reviewed version lock ${change} refuses before intent`, async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); const file = q.x.config.version_lock_path;
  if (change === "replace") { const lock = JSON.parse(await fs.readFile(file, "utf8")) as {docker: {ce: string}}; lock.docker.ce += ".review-change"; await fs.writeFile(file, JSON.stringify(lock)); }
  if (change === "missing") await fs.rename(file, file + ".preserved");
  if (change === "invalid") await fs.writeFile(file, "{");
  if (change === "truncated") await fs.writeFile(file, " ".repeat(1024 * 1024 + 1));
  if (change === "symlink") { await fs.rename(file, file + ".preserved"); await fs.symlink(file + ".preserved", file); }
  await refuseWithoutEffects(q); await refuseWithoutEffects(q, "gate-approve");
  if (change === "replace") {
    await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0);
    assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
  }
});
test("A22-06 host-only scope needs a valid lock but no absent M0 artifact", async () => {
  const q = await fixture(); assert.equal(await q.x.f.exists(q.x.config.release.archive_path), false);
  await q.x.planAndApprove(q.make()); assert.equal((await native(q)).release_context.applicable, false);
  assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0);
});
test("A22-06 applicable S05 actual archive substitution cannot execute commands or publish intent", async () => {
  const x = await r14Fixture("S05"), adapter = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
  const engine = () => x.engine([r14Noop("S04"), createApplicationStage(adapter)]);
  await x.planAndApprove(engine()); const before = await evidence(x.config), probes = adapter.probeCalls;
  await fs.writeFile(x.config.release.archive_path, "foreign archive bytes");
  const result = await engine().run("apply", x.applyOptions);
  assert.equal(result.exitCode, 9); assert.equal(result.envelope.error?.code, "context_release_integrity");
  assert.equal(adapter.probeCalls, probes); assert.equal(adapter.extractCalls, 0); assert.deepEqual(await evidence(x.config), before);
});
for (const age of [30 * 60_000 - 1, 30 * 60_000, 30 * 60_000 + 1, -1]) test(`A22-10 native independent TTL boundary ${age}`, async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); q.advance(age);
  const valid = age >= 0 && age < 30 * 60_000;
  if (valid) { assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0); assert.equal(q.counts.install, 1); }
  else await refuseWithoutEffects(q);
});
test("A22-10 expiry shape, impossible/future timestamps, wrong duration reject a self-hashed plan", async () => {
  for (const value of ["2026-02-30T10:00:00.000Z", "2026-10-25T10:00:00Z", "2026-10-25T10:30:00.001Z"]) {
    const q = await fixture(); await q.x.planAndApprove(q.make()); const plan = await native(q); plan.expires_at = value; await write(q, plan);
    const result = await refuseWithoutEffects(q); assert.equal(result.exitCode, 2);
  }
});
test("A22-07/10 own verified APT refresh remains known when clock crosses TTL inside action", async () => {
  const q = await fixture(), original = q.apt.refreshMetadata;
  q.apt.refreshMetadata = async () => { await original(); q.advance(30 * 60_000); };
  await q.x.planAndApprove(q.make()); const result = await q.make().run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 4); assert.deepEqual(q.counts, { refresh: 1, simulate: 0, install: 0 });
  assert.equal((await q.x.state()).in_flight_operation, null);
  await refuseWithoutEffects(q, "resume");
  await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("resume", { configPath: q.x.configPath })).exitCode, 0);
  assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
});

import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { REVIEW_KEY } from "../../src/core/plan-context";
import { saveState } from "../../src/core/state";
import { accessFixture, accessEngine, readFacts } from "../helpers/r211-access";

test("A22-04/11/12 new S03 login after checkpoint needs fresh review; original effects never replay", async () => {
  const x = await accessFixture(); let session = "login-one";
  const proc = { ...r14Process, loginSessionId: async () => session };
  const make = (pause?: "cutover") => accessEngine(x.root, x.config, { process: proc, ...(pause ? { pause } : {}) });
  await x.planAndApprove(make()); assert.equal((await make("cutover").run("apply", x.applyOptions)).exitCode, 130);
  const before = await evidence(x.config), counts = (await readFacts(x.root)).counts; session = "login-two";
  const denied = await make().run("resume", { configPath: x.configPath });
  assert.equal(denied.exitCode, 4); assert.equal(denied.envelope.error?.code, "context_session_changed");
  assert.deepEqual(await evidence(x.config), before); assert.deepEqual((await readFacts(x.root)).counts, counts);
  await x.planAndApprove(make()); assert.equal((await make().run("resume", { configPath: x.configPath })).exitCode, 0);
  assert.deepEqual((await readFacts(x.root)).counts, { install: 1, stage: 1, arm: 1, cutover: 1, tailnet: 1, disarm: 1, rollback: 0 });
});
test("A22-13 real lock barrier detects same-path context swap without target intent", async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); let enabled = true, hits = 0;
  const wrapped = new Proxy(q.x.f, { get(target, key) {
    if (key === "mkdir") return async (p: string, options?: {recursive?: boolean; mode?: number}) => {
      if (enabled && p === path.join(q.x.config.paths.setup_state_dir, "lock")) {
        enabled = false; hits++;
        const lock = JSON.parse(await fs.readFile(q.x.config.version_lock_path, "utf8")) as {docker: {ce: string}};
        lock.docker.ce += ".changed-at-lock"; await fs.writeFile(q.x.config.version_lock_path, JSON.stringify(lock));
      }
      return target.mkdir(p, options);
    };
    const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SetupEngine({ fsAdapter: wrapped, processAdapter: q.proc, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)]));
  const before = await evidence(q.x.config), result = await engine.run("apply", q.x.applyOptions);
  assert.equal(hits, 1, "actual acquisition reached controlled barrier"); assert.equal(result.exitCode, 8);
  assert.deepEqual(q.counts, { refresh: 0, simulate: 0, install: 0 }); assert.deepEqual(await evidence(q.x.config), before);
});
test("A22-07/13 version lock changes inside a completed bounded refresh: next effect denied, progress retained", async () => {
  const q = await fixture(), refresh = q.apt.refreshMetadata;
  q.apt.refreshMetadata = async () => {
    await refresh(); const lock = JSON.parse(await fs.readFile(q.x.config.version_lock_path, "utf8")) as {docker: {ce: string}};
    lock.docker.ce += ".after-effect"; await fs.writeFile(q.x.config.version_lock_path, JSON.stringify(lock));
  };
  await q.x.planAndApprove(q.make()); const result = await q.make().run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 8); assert.deepEqual(q.counts, { refresh: 1, simulate: 0, install: 0 });
  assert.equal((await q.x.state()).in_flight_operation, null);
  q.apt.refreshMetadata = refresh;
  await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("resume", { configPath: q.x.configPath })).exitCode, 0);
  assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
});
test("A22-09/14 malformed or foreign core review is never authorization and readonly diagnostics never repair it", async () => {
  for (const mutation of ["missing", "malformed", "future", "foreign-plan", "foreign-context"] as const) {
    const q = await fixture(); await q.x.planAndApprove(q.make()); const state = await q.x.state(), holder = state.stages.find(stage => stage.id === "S00")!;
    const record = JSON.parse(holder.versions[REVIEW_KEY]!) as Record<string, unknown>;
    if (mutation === "missing") delete holder.versions[REVIEW_KEY];
    else { if (mutation === "future") record.version = 2; if (mutation === "foreign-plan") record.plan_hash = "f".repeat(64); if (mutation === "foreign-context") record.context_hash = "e".repeat(64);
      holder.versions[REVIEW_KEY] = mutation === "malformed" ? "{" : JSON.stringify(record); }
    await saveState(q.x.f, q.x.config, state); const before = await evidence(q.x.config);
    await q.make().run("status", { configPath: q.x.configPath }); await q.make().run("gate-list", { configPath: q.x.configPath });
    assert.deepEqual(await evidence(q.x.config), before);
    assert.equal((await refuseWithoutEffects(q)).exitCode, 8); assert.equal((await refuseWithoutEffects(q, "gate-approve")).exitCode, 8);
  }
});
for (const fault of [true, false]) test(`A22-14 actual core review publication write fault ${fault ? "on" : "off"}`, async () => {
  const q = await fixture(); let hits = 0;
  const wrapped = new Proxy(q.x.f, { get(target, key) {
    if (key === "writeText") return async (p: string, body: string, mode?: number) => {
      if (fault && hits === 0 && p.includes("state.json.tmp-") && body.includes(REVIEW_KEY)) { hits++; throw Object.assign(Error("review publication ENOSPC"), { code: "ENOSPC" }); }
      return target.writeText(p, body, mode);
    };
    const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SetupEngine({ fsAdapter: wrapped, processAdapter: q.proc, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)]));
  const planned = await engine.run("plan", { configPath: q.x.configPath });
  if (fault) {
    assert.equal(hits, 1); assert.ok([6,8].includes(planned.exitCode), JSON.stringify(planned)); assert.ok(planned.envelope.error?.code);
    const proposedHash = await fs.readFile(q.x.applyOptions.planPath, "utf8").then(raw => (JSON.parse(raw) as InstallerPlan).plan_hash, () => "0".repeat(64));
    const approved = await q.make().run("gate-approve", { configPath: q.x.configPath, gateId: "s02-sudo-apt-update", planHash: proposedHash });
    assert.notEqual(approved.exitCode, 0); assert.notEqual((await q.make().run("apply", q.x.applyOptions)).exitCode, 0);
    assert.deepEqual(q.counts, { refresh: 0, simulate: 0, install: 0 });
  } else { await q.x.planAndApprove(engine); assert.equal((await engine.run("apply", q.x.applyOptions)).exitCode, 0); assert.equal(q.counts.install, 1); }
});

test("A22-03 production host parser and real loginSessionId method: Linux audit identity is not PID or environment", async () => {
  const { NodeProcessAdapter, parseSupportedHost } = await import("../../src/adapters/process");
  assert.deepEqual(parseSupportedHost('ID=ubuntu\nVERSION_ID="24.04"\n', "linux", "x64"), { os: "ubuntu-24.04", arch: "amd64" });
  for (const [text, platform, arch] of [ ['ID=ubuntu\nVERSION_ID="24.04"', "darwin", "arm64"], ["ID=ubuntu\nVERSION_ID=22.04", "linux", "x64"], ["ID=ubuntu\nID=other\nVERSION_ID=24.04", "linux", "x64"], ["ID=ubuntu\nVERSION_ID=24.04", "linux", "ia32"] ]) {
    assert.throws(() => parseSupportedHost(text!, platform!, arch!), { code: "context_host_unsupported" });
  }
  class IdentityFixture extends NodeProcessAdapter {
    session = "42"; login = "1000";
    override uid() { return 1000; }
    protected override async identityText(file: string, _limit: number) {
      if (file === "/proc/self/sessionid") return this.session;
      if (file === "/proc/self/loginuid") return this.login;
      throw Error("unexpected identity read");
    }
  }
  const a = new IdentityFixture(), b = new IdentityFixture();
  assert.equal(await a.loginSessionId(), await b.loginSessionId(), "separate adapter/process identity must not use PID");
  b.session = "43"; assert.notEqual(await a.loginSessionId(), await b.loginSessionId());
  for (const [session, login] of [["4294967295", "1000"], ["99999999999999999999", "1000"], ["42", "0"], ["", "1000"]]) {
    a.session = session!; a.login = login!; await assert.rejects(() => a.loginSessionId(), { code: "context_login_session_unavailable" });
  }
});
test("A22-03 missing fresh identity never initializes an installation", async () => {
  const q = await fixture(); q.identity.machine = "";
  const before = await evidence(q.x.config), result = await q.make().run("plan", { configPath: q.x.configPath });
  assert.notEqual(result.exitCode, 0); assert.deepEqual(await evidence(q.x.config), before); assert.deepEqual(q.counts, { refresh: 0, simulate: 0, install: 0 });
});
test("A22-06 S05 manifest/entry drift also blocks gate approval before any executable probe", async () => {
  for (const change of ["manifest", "content"] as const) {
    const x = await r14Fixture("S05"), adapter = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
    const engine = () => x.engine([r14Noop("S04"), createApplicationStage(adapter)]);
    const p = await x.planAndApprove(engine());
    assert.equal((await engine().run("apply", x.applyOptions)).exitCode, 0);
    const before = await evidence(x.config), calls = adapter.probeCalls, extracted = adapter.extractCalls; assert.ok(calls > 0);
    if (change === "manifest") adapter.release.manifest!.commands.runner_verify = ["node", "different-entry.cjs"];
    else adapter.hashMismatches = ["runner.js:detected-current-tamper"];
    const denied = await engine().run("gate-approve", { configPath: x.configPath, gateId: p.stages.find(stage => stage.stage_id === "S05")!.required_gates[0]!, planHash: p.plan_hash });
    assert.notEqual(denied.exitCode, 0); assert.equal(adapter.probeCalls, calls); assert.equal(adapter.extractCalls, extracted); assert.deepEqual(await evidence(x.config), before);
  }
});

test("A22-01 duplicate decoded JSON keys cannot disappear before C13 schema/hash validation", async () => {
  const q = await fixture(); await q.x.planAndApprove(q.make()); const p = await native(q);
  const raw = JSON.stringify(p).replace('"schema_version":1', '"schema_version":1,"schema_version":1');
  await fs.writeFile(q.x.applyOptions.planPath, raw); assert.equal((await refuseWithoutEffects(q)).exitCode, 2);
  const { parseStrictJson } = await import("../../src/core/strict-json");
  assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), /duplicate/);
  assert.deepEqual(parseStrictJson('{"a":[{"b":"escaped \\\" string"}]}'), { a: [{ b: 'escaped " string' }] });
});

import { requestCancel } from "../../src/core/lock";
import { POLICY_BASIS_KEY, type PolicyBasis } from "../../src/core/policy";

test("A22-14 generic completed flags require exact checkpoint publication, not just valid metadata strings", async () => {
  for (const mutation of ["none", "attempt", "receipt", "catalog"] as const) {
    const q = await fixture(), refresh = q.apt.refreshMetadata;
    q.apt.refreshMetadata = async () => { await refresh(); await requestCancel(q.x.f, q.x.config); };
    await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 130);
    const state = await q.x.state(), holder = state.stages.find(stage => stage.id === "S02")!;
    const basis = JSON.parse(holder.versions[POLICY_BASIS_KEY]!) as PolicyBasis;
    assert.equal(basis.version, 3); assert.equal(basis.completed.length, 1);
    if (mutation === "attempt") basis.progress![0]!.attemptId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    if (mutation === "receipt") basis.progress![0]!.receiptHash = "0".repeat(64);
    if (mutation === "catalog") basis.catalog!.operations[0]!.resourceId = "foreign-resource";
    if (mutation !== "none") { holder.versions[POLICY_BASIS_KEY] = JSON.stringify(basis); await saveState(q.x.f, q.x.config, state); }
    if (mutation === "none") {
      assert.equal((await q.make().run("resume", { configPath: q.x.configPath })).exitCode, 0);
      assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
    } else {
      const before = await evidence(q.x.config); const result = await q.make().run("resume", { configPath: q.x.configPath });
      assert.equal(result.exitCode, 8); assert.deepEqual(await evidence(q.x.config), before);
      assert.deepEqual(q.counts, { refresh: 1, simulate: 0, install: 0 });
    }
  }
});
test("A22-14 prepared review cannot authorize a gate/action after final review-state publication fails", async () => {
  const q = await fixture(); let hits = 0;
  const wrapped = new Proxy(q.x.f, { get(target, key) {
    if (key === "writeText") return async (p: string, body: string, mode?: number) => {
      if (p.includes("state.json.tmp-")) {
        const payload = JSON.parse(body) as import("../../src/core/types").SetupState;
        const raw = payload.stages.find(stage => stage.id === "S00")?.versions[REVIEW_KEY];
        if (raw && (JSON.parse(raw) as {phase:string}).phase === "committed") { hits++; throw Object.assign(Error("commit review ENOSPC"), { code: "ENOSPC" }); }
      }
      return target.writeText(p, body, mode);
    };
    const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new SetupEngine({ fsAdapter: wrapped, processAdapter: q.proc, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)]));
  const planned = await engine.run("plan", { configPath: q.x.configPath });
  assert.equal(hits, 1); assert.notEqual(planned.exitCode, 0);
  const state = await q.x.state(), record = JSON.parse(state.stages.find(stage => stage.id === "S00")!.versions[REVIEW_KEY]!) as {phase:string};
  assert.equal(record.phase, "prepared"); const before = await evidence(q.x.config);
  assert.equal((await refuseWithoutEffects(q, "gate-approve")).exitCode, 8);
  assert.equal((await refuseWithoutEffects(q)).exitCode, 8); assert.deepEqual(await evidence(q.x.config), before);
  await q.x.planAndApprove(q.make()); assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 0);
  assert.deepEqual(q.counts, { refresh: 1, simulate: 1, install: 1 });
});

import { baseObservation, SessionDockerAdapter } from "../helpers/r15-docker";
import { createDockerStage } from "../../src/stages/docker";

test("A22-04/12 Docker effective-group login invalidates old approvals; fresh remaining review never replays package/group effects", async () => {
  const x = await r14Fixture("S04"), o = baseObservation();
  o.dockerGroup = {exists:false, currentUserInGroup:false, accountUserInGroup:false};
  o.reloginRequired = false;
  const adapter = new SessionDockerAdapter(o); adapter.changeGroupMembership = true;
  let session = "docker-login-one";
  const proc = {...r14Process, loginSessionId:async () => session};
  const make = () => new SetupEngine({fsAdapter:x.f,processAdapter:proc}, createRegistry([r14Noop("S03"),createDockerStage(adapter)]));
  await x.planAndApprove(make());
  assert.equal((await make().run("apply",x.applyOptions)).exitCode,4);
  assert.equal(adapter.installCalls,1); assert.equal(adapter.groupCalls,1);
  assert.equal(adapter.restartCalls,0); assert.equal(adapter.probeCalls,0);
  assert.equal((await x.state()).in_flight_operation,null);
  const paused = await evidence(x.config);
  assert.equal((await make().run("resume",{configPath:x.configPath})).exitCode,4);
  assert.equal(adapter.installCalls,1); assert.equal(adapter.groupCalls,1);
  session="docker-login-two"; adapter.observation.dockerGroup.currentUserInGroup=true; adapter.observation.reloginRequired=false;
  assert.equal((await make().run("resume",{configPath:x.configPath})).envelope.error?.code,"context_session_changed");
  assert.deepEqual(await evidence(x.config),paused);
  await x.planAndApprove(make());
  assert.equal((await make().run("resume",{configPath:x.configPath})).exitCode,0);
  assert.equal((await make().run("resume",{configPath:x.configPath})).exitCode,0);
  assert.equal(adapter.installCalls,1); assert.equal(adapter.groupCalls,1);
  assert.equal(adapter.restartCalls,1); assert.equal(adapter.probeCalls,1);
});

test("A22-13 release substitution at actual lock acquisition refuses without target proof", async () => {
  const x = await r14Fixture("S05"), adapter = new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config));
  const stages = () => [r14Noop("S04"),createApplicationStage(adapter)];
  await x.planAndApprove(x.engine(stages())); let hits=0;
  const wrapped = new Proxy(x.f,{get(target,key){
    if(key==="mkdir") return async (p:string,options?:{recursive?:boolean;mode?:number}) => {
      await target.mkdir(p,options);
      if(p===path.join(x.config.paths.setup_state_dir,"lock") && hits===0) {hits++;await fs.writeFile(x.config.release.archive_path,"replaced-at-lock");}
    };
    const value:unknown=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});
  const before=await evidence(x.config), probes=adapter.probeCalls;
  const result=await new SetupEngine({fsAdapter:wrapped,processAdapter:r14Process,clock:r14Clock},createRegistry(stages())).run("apply",x.applyOptions);
  assert.equal(hits,1);assert.equal(result.exitCode,9);assert.equal(adapter.probeCalls,probes);assert.equal(adapter.extractCalls,0);
  assert.deepEqual(await evidence(x.config),before);
});
