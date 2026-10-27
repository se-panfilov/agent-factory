import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { accessFixture, accessEngine, readFacts, writeFacts, phases, target, type Phase } from "../helpers/r211-access";
import { evidence, readPlan, writePlan } from "../helpers/r21-admission";
import { type StageId } from "../../src/core/types";

const allOnce = { install: 1, stage: 1, arm: 1, cutover: 1, tailnet: 1, disarm: 1, rollback: 0 };
async function intents(x: Awaited<ReturnType<typeof accessFixture>>) {
  const body = await fs.readFile(path.join(x.config.paths.setup_state_dir, "events.jsonl"), "utf8");
  return body.split("\n").filter(line => line.includes('"code":"intent"')).length;
}
async function paused(phase: Phase) {
  const x = await accessFixture();
  await x.planAndApprove(accessEngine(x.root, x.config));
  const first = await accessEngine(x.root, x.config, { pause: phase }).run("apply", x.applyOptions);
  assert.equal(first.exitCode, 130, JSON.stringify(first));
  assert.equal((await x.state()).in_flight_operation, null);
  return x;
}
async function finished(x: Awaited<ReturnType<typeof accessFixture>>) {
  const facts = await readFacts(x.root);
  assert.deepEqual(facts.counts, allOnce);
  assert.equal(facts.observation.rollback.armed, false);
  assert.equal(facts.observation.securityInputs.contentHash, target.contentHash);
  assert.equal((await x.state()).stages.find(s => s.id === "S03")?.status, "verified");
  assert.equal(await intents(x), 6, "exactly six intents, no replay");
}
for (const mode of ["resume", "replan"] as const) test(`A211-02/03/04 actual S03 ${mode}, six checkpoint boundaries, staged raw hash cutover`, async () => {
  for (const phase of phases) {
    const x = await paused(phase), before = (await readFacts(x.root)).counts;
    if (mode === "replan") await x.planAndApprove(accessEngine(x.root, x.config));
    const result = await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath });
    assert.equal(result.exitCode, 0, `${phase}: ${JSON.stringify(result)}`);
    await finished(x);
    const snapshot = await evidence(x.config);
    assert.equal((await accessEngine(x.root, x.config).run("status", { configPath: x.configPath })).exitCode, 0);
    assert.deepEqual(await evidence(x.config), snapshot, "plain status read-only");
    assert.equal((await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath })).exitCode, 0);
    await finished(x);
    console.log("R211_BOUNDARY " + JSON.stringify({ phase, mode, exit: result.exitCode, before, after: (await readFacts(x.root)).counts, intents: await intents(x) }));
  }
});
test("A211-06 sequential stops accumulate a published prefix across re-plan and resume", async () => {
  const x = await paused("install");
  for (const [phase, review] of [["arm", false], ["cutover", true], ["tailnet", true]] as const) {
    if (review) await x.planAndApprove(accessEngine(x.root, x.config));
    assert.equal((await accessEngine(x.root, x.config, { pause: phase }).run("resume", { configPath: x.configPath })).exitCode, 130);
    assert.equal((await x.state()).in_flight_operation, null);
  }
  assert.equal((await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath })).exitCode, 0);
  await finished(x);
});
test("A211-07 checkpoint then plan TTL: refusal preserves progress, explicit review continues without replay", async () => {
  const x = await paused("cutover"), state = await x.state(), before = await evidence(x.config), counts = (await readFacts(x.root)).counts;
  const late = () => new Date("2026-10-26T10:30:00.000Z");
  const expired = await accessEngine(x.root, x.config, { now: late }).run("resume", { configPath: x.configPath });
  assert.equal(expired.exitCode, 4); assert.equal(expired.envelope.error?.code, "plan_expired");
  assert.deepEqual(await evidence(x.config), before); assert.deepEqual((await readFacts(x.root)).counts, counts);
  assert.deepEqual((await x.state()).pending_gates, state.pending_gates, "expiry cannot renew stored gates");
  await x.planAndApprove(accessEngine(x.root, x.config, { now: late }));
  assert.equal((await accessEngine(x.root, x.config, { now: late }).run("resume", { configPath: x.configPath })).exitCode, 0);
  await finished(x);
});
for (const mode of ["resume", "replan"] as const) test(`A211-08 ${mode}: external content/ownership/pin/manual drift never becomes own progress`, async () => {
  for (const change of ["content", "ownership", "pin", "manual", "diff"] as const) {
    const x = await paused("cutover"), facts = await readFacts(x.root);
    if (change === "content") facts.observation.ssh.configHash = "foreign bytes";
    if (change === "ownership") facts.observation.securityInputs.ownershipHash = "foreign owner";
    if (change === "pin") facts.observation.tailscale.candidateVersion = "2.0.0";
    if (change === "manual") facts.observation.manual.secondSessionHasSudo = false;
    if (change === "diff") facts.observation.diff.sshd += "foreign diff";
    await writeFacts(x.root, facts);
    const before = await evidence(x.config), initialIntents = await intents(x);
    const result = await accessEngine(x.root, x.config).run(mode === "replan" ? "plan" : "resume", { configPath: x.configPath });
    assert.notEqual(result.exitCode, 0, `${mode}/${change}`); assert.ok(result.envelope.error?.code);
    assert.deepEqual(await evidence(x.config), before); assert.deepEqual((await readFacts(x.root)).counts, facts.counts);
    assert.equal(await intents(x), initialIntents);
    console.log("R211_DRIFT " + JSON.stringify({ mode, change, exit: result.exitCode, code: result.envelope.error?.code, before, after: await evidence(x.config), counts: facts.counts }));
  }
});
test("A211-08 cutover target proof is narrow: unrelated ownership/content change triggers rollback, no next intent", async () => {
  for (const unsafeCutover of ["ownership", "content"] as const) {
    const x = await accessFixture(); await x.planAndApprove(accessEngine(x.root, x.config));
    const result = await accessEngine(x.root, x.config, { unsafeCutover }).run("apply", x.applyOptions);
    assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "s03_cutover_postcondition_unproven");
    const facts = await readFacts(x.root); assert.equal(facts.counts.rollback, 1); assert.equal(facts.counts.tailnet, 0);
    assert.notEqual((await x.state()).stages.find(s => s.id === "S03")?.status, "verified");
    const before = facts.counts;
    assert.notEqual((await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath })).exitCode, 0);
    assert.deepEqual((await readFacts(x.root)).counts, before);
  }
});
test("A211-11 submitted policy tampering after own progress preserves independent producer refusal", async () => {
  for (const edit of ["gates", "resource", "risk", "constraints"] as const) {
    const x = await paused("arm"), p = await readPlan(x), op = p.stages.find(s => s.stage_id === "S03")!.operations[3]!;
    if (edit === "gates") { op.gate_ids = []; p.stages.find(s => s.stage_id === "S03")!.required_gates = []; }
    if (edit === "resource") op.resource_id = "harmless";
    if (edit === "risk") op.risk = "low";
    if (edit === "constraints") op.preconditions = [];
    await writePlan(x, p); const before = await evidence(x.config), counts = (await readFacts(x.root)).counts;
    const result = await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath });
    assert.equal(result.exitCode, 2, JSON.stringify(result)); assert.deepEqual(await evidence(x.config), before);
    assert.deepEqual((await readFacts(x.root)).counts, counts);
  }
});

async function childCommand(root: string, command: string, pause: Phase | "none" = "none") {
  const child = fork(path.join(__dirname, "../helpers/r211-child.js"), [root, command, pause], { silent: true });
  let stdout = "", stderr = "";
  child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code, signal] = await once(child, "exit"); clearTimeout(timer);
  assert.equal(code, 0, `${command}: ${stderr}; ${stdout}; ${signal}`);
  const row = JSON.parse(stdout.trim()) as { pid: number; result: { exitCode: number } };
  console.log("R211_PROCESS " + JSON.stringify({ command, pause, ...row }));
  return row;
}
test("A211-05 separate owned processes plan/approve/apply-cancel/resume and explicit re-plan use only disk evidence", async () => {
  const pids = new Set<number>();
  for (const mode of ["resume", "replan"] as const) for (const phase of ["install", "cutover", "tailnet"] as const) {
    const x = await accessFixture();
    let row = await childCommand(x.root, "review"); assert.equal(row.result.exitCode, 0); pids.add(row.pid);
    row = await childCommand(x.root, "apply", phase); assert.equal(row.result.exitCode, 130); pids.add(row.pid);
    if (mode === "replan") { row = await childCommand(x.root, "review"); assert.equal(row.result.exitCode, 0); pids.add(row.pid); }
    row = await childCommand(x.root, "resume"); assert.equal(row.result.exitCode, 0); pids.add(row.pid);
    await finished(x);
  }
  assert.ok(pids.size >= 18, "distinct OS processes, no shared instance state");
});

test("A211-09 synthetic metadata corruption via real core writer cannot fabricate a predecessor or alias arm/disarm", async () => {
  const { saveState } = await import("../../src/core/state");
  const { POLICY_BASIS_KEY } = await import("../../src/core/policy");
  for (const mutation of ["missing", "stage", "config", "operation", "attempt", "receipt", "collision", "empty"] as const) {
    const x = await paused(mutation === "collision" ? "disarm" : "arm");
    const state = await x.state(), entry = state.stages.find(s => s.id === "S03")!;
    const basis = JSON.parse(entry.versions[POLICY_BASIS_KEY]!) as import("../../src/core/policy").PolicyBasis;
    if (mutation === "missing") delete entry.versions[POLICY_BASIS_KEY];
    else {
      if (mutation === "stage") basis.progress!.at(-1)!.operation.stageId = "S02" as StageId;
      if (mutation === "config") basis.configHash = "f".repeat(64);
      if (mutation === "attempt") basis.progress!.at(-1)!.attemptId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (mutation === "receipt") basis.progress!.at(-1)!.receiptHash = "0".repeat(64);
      if (mutation === "operation") basis.progress!.at(-1)!.operation.resourceId = "wrong";
      if (mutation === "collision") basis.progress!.at(-1)!.operation = structuredClone(basis.progress![2]!.operation);
      if (mutation === "empty") { basis.completed = []; basis.progress = []; }
      entry.versions[POLICY_BASIS_KEY] = JSON.stringify(basis);
    }
    // Deliberately corrupt only internal policy metadata, using genuine publication APIs.
    // All receipts/checkpoints stay engine-generated. This is synthetic negative evidence.
    await saveState(x.f, x.config, state);
    const before = await evidence(x.config), counts = (await readFacts(x.root)).counts;
    const result = await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath });
    assert.equal(result.exitCode, 8, `${mutation}: ${JSON.stringify(result)}`);
    assert.deepEqual(await evidence(x.config), before); assert.deepEqual((await readFacts(x.root)).counts, counts);
    console.log("R211_PROOF_NEGATIVE " + JSON.stringify({ mutation, exit: result.exitCode, code: result.envelope.error?.code, counts }));
  }
});
test("A211-09 synthetic legacy v1 metadata retains exact engine-created checkpoint prefix, including compacted arm", async () => {
  const { saveState } = await import("../../src/core/state");
  const { POLICY_BASIS_KEY } = await import("../../src/core/policy");
  for (const phase of ["arm", "cutover", "disarm"] as const) {
    const x = await paused(phase), state = await x.state(), entry = state.stages.find(s => s.id === "S03")!;
    const basis = JSON.parse(entry.versions[POLICY_BASIS_KEY]!) as import("../../src/core/policy").PolicyBasis;
    basis.version = 1; delete basis.progress; delete basis.catalog; delete basis.frontier; entry.versions[POLICY_BASIS_KEY] = JSON.stringify(basis);
    await saveState(x.f, x.config, state);
    assert.equal((await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath })).exitCode, 0);
    await finished(x);
  }
});
for (const barrier of ["install", "checkpoint", "binding"] as const) test(`A211-10 S03 owned child SIGKILL at ${barrier}: reader/lock/unknown controls`, async () => {
  const x = await accessFixture(); await x.planAndApprove(accessEngine(x.root, x.config));
  const child = fork(path.join(__dirname, "../helpers/r211-child.js"), [x.root, "apply", "none", barrier], { silent: true });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<{type: string; path: string; pid: number; phase: string}>((resolve, reject) => {
    deadline = setTimeout(() => reject(Error(`barrier timeout: ${barrier}: ${stderr}`)), 20_000);
    child.once("exit", code => reject(Error(`before barrier ${barrier}: ${code}: ${stderr}`)));
    child.on("message", value => { clearTimeout(deadline); resolve(value as {type: string; path: string; pid: number; phase: string}); });
  });
  try {
    const message = await reached; assert.equal(message.phase, barrier); assert.equal(message.pid, child.pid);
    const before = await evidence(x.config), counts = (await readFacts(x.root)).counts;
    await accessEngine(x.root, x.config).run("status", { configPath: x.configPath });
    assert.deepEqual(await evidence(x.config), before);
    assert.notEqual((await accessEngine(x.root, x.config).run("recover", { configPath: x.configPath })).exitCode, 0, "live foreign writer owns lock");
    assert.deepEqual(await evidence(x.config), before);
    const ended = once(child, "exit"); child.kill("SIGKILL"); const [code, signal] = await ended;
    assert.equal(code, null); assert.equal(signal, "SIGKILL");
    const unlocked = await accessEngine(x.root, x.config).run("recover", { configPath: x.configPath, lockOnly: true });
    assert.equal(unlocked.exitCode, 8, JSON.stringify(unlocked)); assert.deepEqual(await evidence(x.config), before);
    assert.equal(await fs.access(path.join(x.config.paths.setup_state_dir, "lock/owner.json")).then(() => true, () => false), true);
    // Explicit harness-only manual resource/lock reconciliation; automatic product takeover was refused.
    await fs.rename(path.join(x.config.paths.setup_state_dir, "lock"), path.join(x.config.paths.setup_state_dir, "lock.manual-a211"));
    const recovered = await accessEngine(x.root, x.config).run("recover", { configPath: x.configPath });
    const resumed = await accessEngine(x.root, x.config).run("resume", { configPath: x.configPath });
    if (barrier === "binding") {
      assert.equal(recovered.exitCode, 0, JSON.stringify(recovered)); assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); await finished(x);
    } else {
      assert.equal(resumed.exitCode, 8, JSON.stringify(resumed)); assert.deepEqual((await readFacts(x.root)).counts, counts);
      assert.notEqual((await x.state()).stages.find(s => s.id === "S03")?.status, "verified");
    }
    console.log("R211_CRASH " + JSON.stringify({ barrier, path: message.path, pid: message.pid, signal, before, after: await evidence(x.config), countsBefore: counts, countsAfter: (await readFacts(x.root)).counts, recover: recovered.exitCode, resume: resumed.exitCode }));
  } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
test("A211-10 fault-off control executes the same S03 publication route to completion", async () => {
  const x = await accessFixture(); await x.planAndApprove(accessEngine(x.root, x.config));
  assert.equal((await accessEngine(x.root, x.config).run("apply", x.applyOptions)).exitCode, 0); await finished(x);
});

test("A211-11 producer policy change after progress requires a new review and cannot transfer approvals", async () => {
  for (const field of ["gate", "resource", "risk", "constraint"] as const) {
    const x = await paused("arm"), counts = (await readFacts(x.root)).counts;
    const stagePolicy = (stage: import("../../src/core/types").StageModule) => {
      const original = stage.plan.bind(stage);
      stage.plan = (desired, observed) => {
        const p = original(desired, observed), cutover = p.operations[3];
        if (cutover) {
          if (field === "gate") { cutover.gateIds = [...cutover.gateIds, "s03-new-reviewed-policy"]; p.requiredGates.push("s03-new-reviewed-policy"); }
          if (field === "resource") cutover.resourceId = "different-cutover-resource";
          if (field === "risk") cutover.risk = "high";
          if (field === "constraint") cutover.preconditions = [...cutover.preconditions, "new-security-constraint:true"];
        }
        return p;
      };
    };
    const before = await evidence(x.config);
    const rejected = await accessEngine(x.root, x.config, { stagePolicy }).run("resume", { configPath: x.configPath });
    assert.equal(rejected.exitCode, 2); assert.deepEqual(await evidence(x.config), before);
    assert.deepEqual((await readFacts(x.root)).counts, counts);
    if (field === "gate") {
      const proposed = await accessEngine(x.root, x.config, { stagePolicy }).run("plan", { configPath: x.configPath });
      assert.equal(proposed.exitCode, 0, JSON.stringify(proposed));
      const notApproved = await accessEngine(x.root, x.config, { stagePolicy }).run("resume", { configPath: x.configPath });
      assert.equal(notApproved.exitCode, 4, "new plan cannot inherit old approvals");
      assert.deepEqual((await readFacts(x.root)).counts, counts);
      await x.planAndApprove(accessEngine(x.root, x.config, { stagePolicy }));
      assert.equal((await accessEngine(x.root, x.config, { stagePolicy }).run("resume", { configPath: x.configPath })).exitCode, 0);
      await finished(x);
    }
  }
});

test("A211-09 legacy v1 requires the exact bound plan; absent or recomputed policy is not proof", async () => {
  const { saveState } = await import("../../src/core/state");
  const { POLICY_BASIS_KEY } = await import("../../src/core/policy");
  for (const mutation of ["missing-plan", "changed-policy"] as const) {
    const x = await paused("arm"), state = await x.state(), entry = state.stages.find(s => s.id === "S03")!;
    const basis = JSON.parse(entry.versions[POLICY_BASIS_KEY]!) as import("../../src/core/policy").PolicyBasis;
    basis.version = 1; delete basis.progress; delete basis.catalog; delete basis.frontier; entry.versions[POLICY_BASIS_KEY] = JSON.stringify(basis);
    await saveState(x.f, x.config, state);
    if (mutation === "missing-plan") await fs.rename(x.applyOptions.planPath, x.applyOptions.planPath + ".preserved");
    else {
      const plan = await readPlan(x); plan.stages.find(s => s.stage_id === "S03")!.operations[0]!.risk = "low";
      await writePlan(x, plan);
    }
    const before = await evidence(x.config), counts = (await readFacts(x.root)).counts;
    const refused = await accessEngine(x.root, x.config).run("plan", { configPath: x.configPath });
    assert.equal(refused.exitCode, 8, JSON.stringify(refused)); assert.equal(refused.envelope.error?.code, "operation_progress_unproven");
    assert.deepEqual(await evidence(x.config), before); assert.deepEqual((await readFacts(x.root)).counts, counts);
  }
});
