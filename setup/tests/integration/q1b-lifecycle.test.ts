import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { executionScope } from "../../src/adapters/process-lifecycle";
import { NodeProcessAdapter } from "../../src/adapters/process";
import { emergencyCancel, EmergencyFailure } from "../../src/operations/emergency";
import { AttemptDeadline } from "../../src/core/deadline";
import { counterFixture } from "../helpers/r21-admission";
import { r14Process, r14Noop } from "../helpers/r14-engine";
import { trustedEmergencyFixture, proxyFs, ok } from "../helpers/r3-protocol";
import { readStateCommitManifest } from "../../src/core/state";
import { requestCancel } from "../../src/core/lock";

for (const reason of ["SIGINT", "SIGTERM"] as const) test(`Q1B ${reason} before intent stops all effects`, async () => {
  const q = await counterFixture(2); const engine = q.make(); await q.x.planAndApprove(engine);
  q.stage.admitOperation = async () => { engine.cancel(reason); };
  const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, reason === "SIGTERM" ? 143 : 130); assert.deepEqual(q.counts, [0, 0]);
  const journal = await fs.readFile(path.join(q.x.config.paths.setup_state_dir, "events.jsonl"), "utf8").catch(e => { if (e.code !== "ENOENT") throw e; return ""; });
  assert.equal(journal.includes('"code":"intent"'), false);
  assert.equal(await q.x.f.exists(path.join(q.x.config.paths.setup_state_dir, "installation.lock")), false);
});
for (const reason of ["SIGINT", "SIGTERM"] as const) test(`Q1B ${reason} after confirmed prefix retains exact checkpoint and no replay`, async () => {
  const q = await counterFixture(2), original = q.stage.apply, engine = q.make();
  q.stage.apply = async (ctx, plan) => { const receipts = await original(ctx, plan); if (plan.operations[0]?.id === "owned-0") engine.cancel(reason); return receipts; };
  await q.x.planAndApprove(engine); const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, reason === "SIGTERM" ? 143 : 130); assert.deepEqual(q.counts, [1, 0]);
  const before = (await readStateCommitManifest(q.x.f, q.x.config))!.completed_operations!.find(e => e.receipt.operationId === "owned-0");
  const resumed = await q.make().run("resume", { configPath: q.x.configPath }); assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.deepEqual(q.counts, [1, 1]);
  assert.deepEqual((await readStateCommitManifest(q.x.f, q.x.config))!.completed_operations!.find(e => e.receipt.operationId === "owned-0"), before);
});
test("Q1B durable cancel reaches active interruptible supervisor; unknown operation is not replayed", async () => {
  const q = await counterFixture(2), actual = new NodeProcessAdapter(); let r: Awaited<ReturnType<typeof actual.runCommand>> | undefined;
  const barrier = path.join(q.x.root, "ready");
  q.stage.apply = async () => {
    const cancel = (async () => {
      const end = performance.now() + 4000;
      while (performance.now() < end) { if (await q.x.f.exists(barrier)) { await requestCancel(q.x.f, q.x.config, r14Process); return; } await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error("child readiness not reached");
    })();
    r = await actual.runCommand({ policy: "interruptible", binary: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(barrier)},'ready');setTimeout(()=>process.exit(0),5000)`], timeoutMs: 6000, maxOutputBytes: 1024 });
    await cancel;
    throw Error("Interrupted fake operation has no authoritative receipt");
  };
  const engine = q.make(); await q.x.planAndApprove(engine); const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 8); assert.equal(r?.cancelled, true); assert.equal(r?.cleanup, "confirmed");
  assert.ok((await q.x.state()).in_flight_operation); assert.deepEqual(q.counts, [0, 0]);
  const again = await q.make().run("resume", { configPath: q.x.configPath }); assert.equal(again.exitCode, 8); assert.deepEqual(q.counts, [0, 0]);
});
test("Q1B fake critical cancellation never kills/replays an unknown mutation", async () => {
  const q = await counterFixture(2), engine = q.make(); let started = 0;
  q.stage.apply = async () => { started++; engine.cancel("SIGINT"); throw Error("critical outcome unknown"); };
  await q.x.planAndApprove(engine); const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 8); assert.equal(started, 1); assert.ok((await q.x.state()).in_flight_operation);
  assert.equal((await q.make().run("resume", { configPath: q.x.configPath })).exitCode, 8); assert.equal(started, 1);
});
test("Q1B unknown process cleanup retains lock and blocks overlapping apply", async () => {
  const q = await counterFixture(1), engine = q.make(); let calls = 0;
  q.stage.apply = async () => { calls++; executionScope.getStore()!.cleanupUnknown = true; throw Error("injected unknown group observation"); };
  await q.x.planAndApprove(engine); const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 8); assert.ok((await q.x.state()).in_flight_operation);
  const owner = path.join(q.x.config.paths.setup_state_dir, "lock", "owner.json");
  assert.equal(await q.x.f.exists(owner), true);
  const marker = JSON.parse(await fs.readFile(path.join(q.x.config.paths.setup_state_dir, "process-cleanup-required.json"), "utf8"));
  assert.equal(marker.cleanup, "unknown"); assert.equal(marker.installation_id, q.x.config.installation_id);
  assert.deepEqual(marker.lock_owner, JSON.parse(await fs.readFile(owner, "utf8")));
  assert.equal((await q.make().run("apply", q.x.applyOptions)).exitCode, 7); assert.equal(calls, 1);
});
for (const boundary of ["admission", "before-first", "between-targets", "during-command"]) test(`Q1B emergency total deadline ${boundary} preserves actual prefix`, async () => {
  const q = await trustedEmergencyFixture(); let now = 0, hits = 0;
  const deadline = new AttemptDeadline(1000, () => now);
  let f: import("../../src/adapters/filesystem").FilesystemAdapter = q.x.f;
  if (boundary === "admission") f = proxyFs(f, { hashFile: async (...args) => { const r = await q.x.f.hashFile!(...args); hits++; now = 1001; return r; } });
  if (boundary === "before-first") f = proxyFs(f, { fsyncDir: async p => { await q.x.f.fsyncDir(p); if (p === q.x.config.paths.application_state_dir) { hits++; now = 1001; } } });
  q.onCommand(async cmd => {
    if (boundary === "between-targets" && cmd.args[0] === "inspect" && cmd.args.at(-1)?.startsWith("b")) { hits++; now = 1001; }
    if (boundary === "during-command" && cmd.args[0] === "stop") { hits++; now = 1001; return ok(); }
    return undefined;
  });
  let failure: EmergencyFailure | undefined;
  try { await emergencyCancel({ fsAdapter: f, processAdapter: q.proc, deadline }, q.x.config); } catch (e) { failure = e as EmergencyFailure; }
  assert.equal(hits, 1); assert.equal(failure?.exitCode, 8); assert.equal(failure.code, "emergency_deadline_or_cancel");
  const out = failure.outcome; assert.notEqual(out.phase, "complete");
  if (boundary === "admission") { assert.equal(out.paused.publication, "not_attempted"); assert.equal(q.calls.length, 0); }
  if (boundary === "before-first") { assert.equal(q.calls.length, 0); assert.ok(["published_unconfirmed", "durable"].includes(out.paused.publication)); }
  if (boundary === "between-targets") { assert.ok(out.confirmed_stopped.includes("container:" + "a".repeat(12))); assert.equal(q.stopped.has("b".repeat(12)), false); }
  if (boundary === "during-command") { assert.deepEqual(out.confirmed_stopped, ["application:" + q.x.config.installation_id]); assert.ok(out.unknown.includes("container:" + "a".repeat(12))); }
});

test("Q1B cancellation plus failed checkpoint persistence retains in-flight and requires recovery8", async () => {
  const q = await counterFixture(2); let hits = 0;
  const f = proxyFs(q.x.f, { rename: async (from, to) => {
    if (to === path.join(q.x.config.paths.setup_state_dir, "state.json") && q.counts[0] === 1 && hits === 0) {
      hits++; throw Object.assign(Error("injected checkpoint publication failure"), { code: "EIO" });
    }
    await q.x.f.rename(from, to);
  } });
  const engine = new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: q.clock }, createRegistry([r14Noop("S01"), q.stage]));
  const original = q.stage.apply;
  q.stage.apply = async (ctx, plan) => { const receipts = await original(ctx, plan); engine.cancel("SIGINT"); return receipts; };
  await q.x.planAndApprove(engine); const result = await engine.run("apply", q.x.applyOptions);
  assert.equal(hits, 1); assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "cleanup_unconfirmed");
  assert.deepEqual(q.counts, [1, 0]); assert.ok((await q.x.state()).in_flight_operation);
  const resumed = await q.make().run("resume", { configPath: q.x.configPath });
  assert.equal(resumed.exitCode, 8); assert.deepEqual(q.counts, [1, 0]);
});
