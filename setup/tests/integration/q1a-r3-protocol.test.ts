import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock, requestCancel, consumeCancelRequest, recoverLockOnly, lockLiveness } from "../../src/core/lock";
import { parseProcStartTicks, probePidLiveness } from "../../src/adapters/process";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { createSystemStage } from "../../src/stages/system";
import { emergencyCancel } from "../../src/operations/emergency";
import { r14Process, r14Fixture, r14Noop } from "../helpers/r14-engine";
import { aptFixture, counterFixture, evidence } from "../helpers/r21-admission";
import { proxyFs, trustedEmergencyFixture, ok } from "../helpers/r3-protocol";
import { type FilesystemAdapter } from "../../src/adapters/filesystem";
import { createHash } from "node:crypto";
const dead = { ...r14Process, isPidAlive: () => false };
const checksum = async (p: string) => fs.readFile(p).then(b => createHash("sha256").update(b).digest("hex"), () => null);
const ownerPath = (x: Awaited<ReturnType<typeof r14Fixture>>) => path.join(x.config.paths.setup_state_dir, "lock/owner.json");
const record = (id: string, data: Record<string, unknown>) => console.log("R3_EVIDENCE " + JSON.stringify({ id, actual_uid: process.getuid?.(), injected_uid: 1000, ...data }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

for (const fault of ["array", "empty", "oversize", "unknown-field", "null-ticks", "unsafe-mode", "symlink", "foreign-installation"])
  test(`R3 lock rejects unsafe metadata ${fault}`, async () => {
    const x = await r14Fixture("S02"), held = await acquireLock(x.f, r14Process, x.config), file = ownerPath(x);
    if (fault === "array") await fs.writeFile(file, "[]");
    if (fault === "empty") await fs.writeFile(file, "{}");
    if (fault === "oversize") await fs.writeFile(file, " ".repeat(4097));
    if (fault === "unknown-field") await fs.writeFile(file, JSON.stringify({ ...held.owner, extra: true }));
    if (fault === "null-ticks") await fs.writeFile(file, JSON.stringify({ ...held.owner, process_start_ticks: null }));
    if (fault === "foreign-installation") await fs.writeFile(file, JSON.stringify({ ...held.owner, installation_id: "11111111-2222-4333-8444-555555555555" }));
    if (fault === "unsafe-mode") await fs.chmod(file, 0o666);
    if (fault === "symlink") { await fs.rename(file, file + ".saved"); await fs.symlink(file + ".saved", file); }
    const before = await checksum(file), beforeState = await evidence(x.config);
    await assert.rejects(recoverLockOnly(x.f, dead, x.config), { exitCode: 7, code: "lock_owner_incomplete" });
    assert.equal(await checksum(file), before); assert.deepEqual(await evidence(x.config), beforeState);
    record(`metadata-${fault}`, { barrier: true, before, after: await checksum(file), generation: held.owner, code: "lock_owner_incomplete", exit: 7, effects: 0 });
  });
for (const kind of ["alive", "dead", "EPERM", "null", "malformed", "reuse", "boot", "boot-unavailable"]) test(`R3 liveness distinguishes ${kind}`, async () => {
  const x = await r14Fixture("S02"), held = await acquireLock(x.f, r14Process, x.config), before = await checksum(ownerPath(x));
  const proc = { ...r14Process,
    pidLiveness: () => kind === "dead" ? "dead" as const : kind === "EPERM" ? "unknown" as const : "alive" as const,
    processStartTicks: async () => kind === "null" ? null : kind === "malformed" ? NaN : kind === "reuse" ? 2 : 1,
    bootId: async () => { if (kind === "boot-unavailable") throw Error("unavailable"); return kind === "boot" ? "11111111-2222-4333-8444-555555555555" : held.owner.boot_id; }
  };
  const live = await lockLiveness(proc, held.owner);
  if (kind === "dead") { assert.equal(live, "dead"); assert.equal((await recoverLockOnly(x.f, proc, x.config)).quarantined, true); }
  else { await assert.rejects(recoverLockOnly(x.f, proc, x.config), { exitCode: 7 }); assert.equal(await checksum(ownerPath(x)), before); }
  record(`liveness-${kind}`, { barrier: true, before, after: await checksum(ownerPath(x)), generation: held.owner, liveness: live, effects: 0, exit: kind === "dead" ? 0 : 7 });
});
test("R3 proc stat handles comm parentheses/spaces and numeric bounds; only ESRCH proves absence", () => {
  const stat = (ticks: string) => `123 (a b (nested) ending)) S ${Array(18).fill("0").join(" ")} ${ticks} 0`;
  assert.equal(parseProcStartTicks(stat("123456"), 123), 123456);
  for (const raw of [stat("1x"), stat("9007199254740992"), stat("-1"), "123 broken", stat("12").replace("123 (", "124 (")]) assert.equal(parseProcStartTicks(raw, 123), null);
  assert.equal(probePidLiveness(123, () => true), "alive");
  for (const code of ["EPERM", "EIO", "ESRCH"]) assert.equal(probePidLiveness(123, () => { throw Object.assign(Error(code), { code }); }), code === "ESRCH" ? "dead" : "unknown");
});
test("R3 unknown own identity never publishes a usable lock", async () => {
  const x = await r14Fixture("S02");
  await assert.rejects(acquireLock(x.f, { ...r14Process, processStartTicks: async () => null }, x.config), { code: "lock_identity_unknown", exitCode: 8 });
  assert.equal(await checksum(ownerPath(x)), null);
});
test("R3 actual FS competing recover/acquire serialize at rename and stale release cannot remove new generation", async () => {
  const x = await r14Fixture("S02"), old = await acquireLock(x.f, r14Process, x.config), entered = deferred(), proceed = deferred();
  let hits = 0;
  const wrapped = proxyFs(x.f, { rename: async (a, b) => { if (a === path.dirname(ownerPath(x))) { hits++; entered.resolve(); await proceed.promise; } await x.f.rename(a, b); } });
  const first = recoverLockOnly(wrapped, dead, x.config); await entered.promise;
  await assert.rejects(recoverLockOnly(x.f, dead, x.config), { exitCode: 7, code: "lock_protocol_busy" });
  await assert.rejects(acquireLock(x.f, r14Process, x.config), { exitCode: 7, code: "lock_protocol_busy" });
  proceed.resolve(); assert.equal((await first).quarantined, true); assert.equal(hits, 1);
  const fresh = await acquireLock(x.f, r14Process, x.config), before = await checksum(ownerPath(x));
  await assert.rejects(old.release(), { code: "lock_owner_changed", exitCode: 8 });
  assert.equal(await checksum(ownerPath(x)), before); await fresh.release();
  record("recover-acquire-race", { barrier: hits, old: old.owner, fresh: fresh.owner, before, after_stale_release: before, competing_recover: 7, competing_acquire: 7, stale_release: 8 });
});
test("R3 actual FS release holds protocol until removal completes", async () => {
  const x = await r14Fixture("S02"), entered = deferred(), proceed = deferred(); let hits = 0;
  const f = proxyFs(x.f, { remove: async (p, opts) => { if (p === path.dirname(ownerPath(x))) { hits++; entered.resolve(); await proceed.promise; } await x.f.remove(p, opts); } });
  const held = await acquireLock(f, r14Process, x.config), release = held.release(); await entered.promise;
  await assert.rejects(acquireLock(x.f, r14Process, x.config), { code: "lock_protocol_busy" });
  proceed.resolve(); await release; assert.equal(hits, 1);
  const next = await acquireLock(x.f, r14Process, x.config); await next.release();
});
for (const phase of ["mkdir", "owner-write", "owner-fsync", "directory-fsync", "before-rename", "after-rename", "parent-fsync", "guard-write"])
 test(`R3 publication/quarantine failure preserves evidence ${phase}`, async () => {
  const x = await r14Fixture("S02"); let hits = 0, renamed = false;
  const recovering = ["before-rename", "after-rename", "parent-fsync"].includes(phase);
  if (recovering) await acquireLock(x.f, r14Process, x.config);
  const fail = () => { hits++; throw Object.assign(Error("injected ENOSPC"), { code: "ENOSPC" }); };
  const f = proxyFs(x.f, {
    mkdir: async (p, o) => { await x.f.mkdir(p, o); if (phase === "mkdir" && p.endsWith("/lock")) fail(); },
    writeText: async (p, b, m) => { if ((phase === "owner-write" && p.endsWith("/owner.json")) || (phase === "guard-write" && p.endsWith("/participant.json"))) fail(); await x.f.writeText(p, b, m); },
    fsyncFile: async p => { if (phase === "owner-fsync" && p.endsWith("/owner.json")) fail(); await x.f.fsyncFile(p); },
    fsyncDir: async p => { if ((phase === "directory-fsync" && p.endsWith("/lock")) || (phase === "parent-fsync" && renamed)) fail(); await x.f.fsyncDir(p); },
    rename: async (a, b) => { if (phase === "before-rename") fail(); await x.f.rename(a, b); renamed = true; if (phase === "after-rename") fail(); }
  });
  await assert.rejects(recovering ? recoverLockOnly(f, dead, x.config) : acquireLock(f, r14Process, x.config), { exitCode: 8 });
  assert.ok(hits > 0);
  const files = await fs.readdir(x.config.paths.setup_state_dir);
  assert.ok(files.some(n => n === "lock" || n === "lock-protocol" || n.startsWith("lock.quarantine-")));
  if (!recovering) await assert.rejects(acquireLock(x.f, r14Process, x.config));
  record(`crash-${phase}`, { barrier: hits, renamed, files, exit: 8, physical_power_loss: "NOT RUN" });
});
test("R3 unsupported FS and unresolved resources block before quarantine", async () => {
  const q = await aptFixture(); await q.x.planAndApprove(q.make());
  const held = await acquireLock(q.x.f, r14Process, q.x.config), before = await checksum(ownerPath(q.x));
  await assert.rejects(recoverLockOnly(proxyFs(q.x.f, { localLockSemantics: async () => false }), dead, q.x.config), { code: "lock_filesystem_unsupported" });
  const state = await q.x.state(); state.in_flight_operation = { id: "unknown", stage_id: "S02", kind: "mutate", started_at: new Date().toISOString() };
  // Real engine publication creates unresolved resource evidence, not a mock refusal.
  const { saveState } = await import("../../src/core/state"); await saveState(q.x.f, q.x.config, state);
  await assert.rejects(recoverLockOnly(q.x.f, dead, q.x.config), { exitCode: 8 });
  assert.equal(await checksum(ownerPath(q.x)), before); assert.ok(held.owner.nonce);
});
for (const fault of ["write", "fsync", "rename", "parent-fsync"]) test(`R3 repeated cancellation preserves accepted request after ${fault} failure`, async () => {
  const x = await r14Fixture("S02"), held = await acquireLock(x.f, r14Process, x.config), file = await requestCancel(x.f, x.config, r14Process), before = await checksum(file); let hits = 0;
  const fail = () => { hits++; throw Object.assign(Error("ENOSPC"), { code: "ENOSPC" }); };
  const f = proxyFs(x.f, {
    writeText: async (p, b, m) => { if (fault === "write" && p.endsWith("/payload")) { await x.f.writeText(p, "{", m); fail(); } await x.f.writeText(p, b, m); },
    fsyncFile: async p => { if (fault === "fsync" && p.endsWith("/payload")) fail(); await x.f.fsyncFile(p); },
    rename: async (a, b) => { if (fault === "rename" && b === file) fail(); await x.f.rename(a, b); },
    fsyncDir: async p => { if (fault === "parent-fsync" && p === x.config.paths.setup_state_dir && new Error().stack?.includes("publishControl")) fail(); await x.f.fsyncDir(p); }
  });
  await assert.rejects(requestCancel(f, x.config, r14Process), { exitCode: 8 }); assert.equal(hits, 1);
  assert.equal(await checksum(file), before); assert.equal(await consumeCancelRequest(x.f, x.config, held.owner), true);
  record(`cancel-fault-${fault}`, { barrier: hits, before, after: await checksum(file), generation: held.owner, matching: true, exit: 8 });
});
test("R3 cancel consumer never deletes concurrent/new generation request; no active run refuses publication", async () => {
  const x = await r14Fixture("S02"), old = await acquireLock(x.f, r14Process, x.config); await requestCancel(x.f, x.config, r14Process);
  const file = path.join(x.config.paths.setup_state_dir, "cancel-request.json"); let hits = 0;
  const f = proxyFs(x.f, { readTextBounded: async (p, n) => { const result = await x.f.readTextBounded(p, n); if (p === file && hits++ === 0) await requestCancel(x.f, x.config, r14Process); return result; } });
  // Repeated request has identical payload; consumer is read-only and retains it.
  let observation: boolean | undefined, observedError: { code?: string; exitCode?: number } | undefined;
  try { observation = await consumeCancelRequest(f, x.config, old.owner); } catch (error) { observedError = error as typeof observedError; }
  if (observedError) { assert.equal(observedError.code, "cancel_evidence_unknown"); assert.equal(observedError.exitCode, 8); }
  else assert.equal(observation, true);
  assert.equal(hits, 1);
  assert.equal(await consumeCancelRequest(x.f, x.config, old.owner), true);
  await old.release(); const next = await acquireLock(x.f, r14Process, x.config);
  assert.equal(await consumeCancelRequest(x.f, x.config, next.owner), false);
  await requestCancel(x.f, x.config, r14Process); const after = await checksum(file);
  assert.equal(await consumeCancelRequest(x.f, x.config, old.owner), false); assert.equal(await checksum(file), after);
  await next.release(); await assert.rejects(requestCancel(x.f, x.config, r14Process), { exitCode: 7 }); assert.equal(await checksum(file), after);
});
test("R3 concurrent cancellation writer and generation swap obey same protocol", async () => {
  const x = await r14Fixture("S02"), held = await acquireLock(x.f, r14Process, x.config), entered = deferred(), proceed = deferred(); let hits = 0;
  const file = path.join(x.config.paths.setup_state_dir, "cancel-request.json");
  const f = proxyFs(x.f, { rename: async (a, b) => { if (b === file) { hits++; entered.resolve(); await proceed.promise; } await x.f.rename(a, b); } });
  const publication = requestCancel(f, x.config, r14Process); await entered.promise;
  await assert.rejects(requestCancel(x.f, x.config, r14Process), { code: "lock_protocol_busy" });
  await assert.rejects(held.release(), { code: "lock_protocol_busy" });
  proceed.resolve(); await publication; assert.equal(hits, 1); assert.equal(await consumeCancelRequest(x.f, x.config, held.owner), true);
  await held.release(); const next = await acquireLock(x.f, r14Process, x.config); assert.equal(await consumeCancelRequest(x.f, x.config, next.owner), false); await next.release();
});
for (const kind of ["none", "early", "admission", "cancel-and-context-drift", "cleanup-failed"]) test(`R3 final cancellation boundary ${kind}`, async () => {
  const q = await aptFixture(); await q.x.planAndApprove(q.make()); let hits = 0;
  const submit = async () => { hits++; await requestCancel(q.x.f, q.x.config, r14Process); if (kind === "cancel-and-context-drift") await fs.appendFile(q.x.configPath, "\n"); };
  const f = proxyFs(q.x.f, {
    fsyncDir: async p => {
      await q.x.f.fsyncDir(p);
      if ((kind === "early" || kind === "cleanup-failed") && hits === 0 && p === q.x.config.paths.setup_state_dir
        && !(await q.x.f.exists(path.join(p, "lock-protocol"))) && await q.x.f.exists(ownerPath(q.x))) await submit();
    },
    readTextBounded: async (p, n) => {
      const result = await q.x.f.readTextBounded(p, n);
      if ((kind === "admission" || kind === "cancel-and-context-drift") && hits === 0 && p === q.x.config.version_lock_path && new Error().stack?.includes("finalPlanAdmission")) await submit();
      return result;
    },
    remove: async (p, o) => { if (kind === "cleanup-failed" && p === path.dirname(ownerPath(q.x))) throw Error("cleanup failed"); await q.x.f.remove(p, o); }
  });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)])).run("apply", q.x.applyOptions);
  assert.equal(hits, kind === "none" ? 0 : 1);
  assert.equal(result.exitCode, kind === "none" ? 0 : ["cleanup-failed", "cancel-and-context-drift"].includes(kind) ? 8 : 130, JSON.stringify(result));
  assert.deepEqual(q.counts, kind === "none" ? { refresh: 1, simulate: 1, install: 1 } : { refresh: 0, simulate: 0, install: 0 });
  const journal = await fs.readFile(path.join(q.x.config.paths.setup_state_dir, "events.jsonl"), "utf8").catch(() => "");
  if (kind !== "none") assert.equal(journal.split("\n").filter(line => line.includes('"stage":"S02"')).length, 0);
  record(`admission-${kind}`, { barrier: hits, exit: result.exitCode, code: result.envelope.error?.code, counts: q.counts, state: await evidence(q.x.config), target_events: kind === "none" ? "completed" : 0 });
});
test("R3 cancel checkpoint prefix resumes without replay and retains exact publication", async () => {
  const q = await counterFixture(2); const original = q.stage.apply;
  q.stage.apply = async (ctx, p) => { const receipts = await original(ctx, p); if (p.operations[0]!.id === "owned-0") await requestCancel(q.x.f, q.x.config, r14Process); return receipts; };
  await q.x.planAndApprove(q.make()); const result = await q.make().run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 130); assert.deepEqual(q.counts, [1, 0]);
  const { readStateCommitManifest } = await import("../../src/core/state");
  const before = (await readStateCommitManifest(q.x.f, q.x.config))!.completed_operations!.find(e => e.receipt.operationId === "owned-0")!;
  const resumed = await q.make().run("resume", { configPath: q.x.configPath }); assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); assert.deepEqual(q.counts, [1, 1]);
  const after = (await readStateCommitManifest(q.x.f, q.x.config))!.completed_operations!.find(e => e.receipt.operationId === "owned-0");
  assert.deepEqual(after, before);
});
for (const verb of ["cancel", "recover", "emergency"] as const) for (const user of ["root", "foreign"]) test(`R3 ordinary owner refusal ${verb}/${user}`, async () => {
  const q = await aptFixture(), before = await evidence(q.x.config), calls: unknown[] = [];
  const proc = { ...r14Process, uid: () => user === "root" ? 0 : 1234, username: () => user === "root" ? "root" : "other", runCommand: async (cmd: unknown) => { calls.push(cmd); return ok(); } };
  const result = await new SetupEngine({ fsAdapter: q.x.f, processAdapter: proc, clock: q.clock }, createRegistry([])).run(verb === "emergency" ? "cancel" : verb, { configPath: q.x.configPath, ...(verb === "emergency" ? { emergency: true } : { lockOnly: true }) });
  assert.equal(result.exitCode, 3); assert.equal(calls.length, 0); assert.deepEqual(await evidence(q.x.config), before);
  record(`owner-${verb}-${user}`, { barrier: "entrypoint-owner", exit: result.exitCode, code: result.envelope.error?.code, before, after: await evidence(q.x.config), calls: calls.length, counters: q.counts });
  assert.equal(await q.x.f.exists(path.join(q.x.config.paths.application_state_dir, "PAUSED")), false);
});
for (const kind of ["valid", "tamper", "traversal", "symlink", "cwd-symlink", "node-pin", "node-symlink", "sudo", "shell", "unknown-inspect", "invalid-label", "inspect-timeout", "inspect-limit", "invalid-ids", "timeout", "output-limit", "failed-stop", "partial-stop", "postcondition", "missing-status"]) test(`R3 trusted emergency ${kind}`, async () => {
  const q = await trustedEmergencyFixture(); await q.inventory();
  const manifestFile = path.join(q.x.config.paths.application_dir, "deployment-manifest.json"), entry = path.join(q.x.config.paths.application_dir, "runner.cjs"), paused = path.join(q.x.config.paths.application_state_dir, "PAUSED");
  if (kind === "tamper") await fs.appendFile(entry, "drift");
  if (kind === "traversal" || kind === "sudo" || kind === "shell" || kind === "missing-status") {
    if (kind === "missing-status") delete q.manifest.commands.app_status;
    else q.manifest.commands.runner_stop = kind === "traversal" ? ["node", "../runner.cjs"] : [kind === "sudo" ? "/usr/bin/sudo" : "/bin/sh", "runner.cjs"];
    await fs.writeFile(manifestFile, JSON.stringify(q.manifest));
  }
  if (kind === "symlink" || kind === "node-symlink") { const file = kind === "symlink" ? entry : q.pin; await fs.rename(file, file + ".safe"); await fs.symlink(file + ".safe", file); }
  if (kind === "cwd-symlink") { const dir = q.x.config.paths.application_dir; await fs.rename(dir, dir + ".safe"); await fs.symlink(dir + ".safe", dir); }
  if (kind === "node-pin") q.proc.nodeRuntime = async () => ({ executable: q.pin, version: "24.0.0", binarySha256: "0".repeat(64) });
  let hits = 0;
  q.onCommand(async cmd => {
    if (kind === "unknown-inspect" && cmd.args[0] === "inspect") { hits++; return ok("malformed"); }
    if (kind === "invalid-label" && cmd.args[0] === "inspect") { hits++; return ok(JSON.stringify({ Id: "a".repeat(64), Config: { Labels: { "agent-factory.installation_id": "-".repeat(36) } }, State: { Running: false } })); }
    if (["inspect-timeout", "inspect-limit"].includes(kind) && cmd.args[0] === "inspect") { hits++; return { ...ok(), timedOut: kind === "inspect-timeout", outputLimitExceeded: kind === "inspect-limit" }; }
    if (kind === "invalid-ids" && cmd.args[0] === "ps") { hits++; return ok("--all\n"); }
    if (["timeout", "output-limit", "failed-stop"].includes(kind) && cmd.binary === q.pin) { hits++; return { ...ok(), timedOut: kind === "timeout", outputLimitExceeded: kind === "output-limit", exitCode: kind === "failed-stop" ? 1 : 0 }; }
    if (kind === "partial-stop" && cmd.args[0] === "inspect" && q.stopped.size) { hits++; return { ...ok(), exitCode: 1 }; }
    if (kind === "postcondition" && cmd.args.at(-1) === "status") { hits++; return ok('{"status":"running"}'); }
    return undefined;
  });
  // Emergency cannot depend on acquiring an ordinary installation lock.
  const held = await acquireLock(q.x.f, r14Process, q.x.config), before = await evidence(q.x.config);
  let result: unknown, error: { code?: string; exitCode?: number } | undefined;
  try { result = await emergencyCancel({ fsAdapter: q.x.f, processAdapter: q.proc }, q.x.config); } catch (e) { error = e as typeof error; }
  if (kind === "valid") {
    assert.equal(error, undefined); assert.deepEqual([...q.stopped], ["a".repeat(12)]); assert.deepEqual((result as { skippedForeignContainers: string[] }).skippedForeignContainers, ["b".repeat(12)]);
    assert.ok(q.calls.filter(c => c.binary === q.pin).every(c => c.cwd === q.x.config.paths.application_dir));
  } else {
    assert.ok(error?.exitCode && error.exitCode !== 0, JSON.stringify(error));
    const late = ["unknown-inspect", "invalid-label", "inspect-timeout", "inspect-limit", "invalid-ids", "timeout", "output-limit", "failed-stop", "partial-stop", "postcondition"].includes(kind);
    assert.equal(await q.x.f.exists(paused), late);
    if (late) assert.ok(hits > 0); else assert.equal(q.calls.length, 0);
  }
  assert.deepEqual(await evidence(q.x.config), before); assert.equal(JSON.parse(await fs.readFile(ownerPath(q.x), "utf8")).nonce, held.owner.nonce);
  record(`emergency-${kind}`, { barrier: hits || "current-bytes-read", generation: held.owner, before, after: await evidence(q.x.config), calls: q.calls, paused: await q.x.f.exists(paused), error, stopped: [...q.stopped] });
  await held.release();
});
for (const signalExit of [130, 143]) test(`R3 in-flight injected ${signalExit} never claims confirmed cleanup`, async () => {
  const q = await counterFixture();
  q.stage.apply = async () => { q.counts[0] = q.counts[0]! + 1; const { setupError } = await import("../../src/core/errors"); throw setupError({ exitCode: signalExit, code: "injected_signal", publicMessage: "unknown effect", nextAction: "reconcile" }); };
  await q.x.planAndApprove(q.make()); const result = await q.make().run("apply", q.x.applyOptions);
  assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "cleanup_unconfirmed"); assert.deepEqual(q.counts, [1]); assert.ok((await q.x.state()).in_flight_operation);
});
test("R3 cancel read cannot reopen frozen context fence on a nonmatching request", async () => {
  const q = await aptFixture(); await q.x.planAndApprove(q.make());
  const old = await acquireLock(q.x.f, r14Process, q.x.config); await requestCancel(q.x.f, q.x.config, r14Process); await old.release();
  let before = await evidence(q.x.config); let hits = 0;
  const f = proxyFs(q.x.f, { readTextBounded: async (p, n) => { const r = await q.x.f.readTextBounded(p, n); if (p.endsWith("cancel-request.json") && new Error().stack?.includes("sealAdmissionInputs") && hits++ === 0) { before = await evidence(q.x.config); await fs.appendFile(q.x.configPath, "\n"); } return r; } });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)])).run("apply", q.x.applyOptions);
  assert.equal(hits, 1); assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "admission_file_changed"); assert.deepEqual(q.counts, { refresh: 0, simulate: 0, install: 0 }); assert.deepEqual(await evidence(q.x.config), before);
});
test("R3 normal cancel of a dead or unknown run does not publish a request", async () => {
  const x = await r14Fixture("S02"); await acquireLock(x.f, r14Process, x.config);
  for (const proc of [dead, { ...r14Process, processStartTicks: async () => null }]) {
    await assert.rejects(requestCancel(x.f, x.config, proc), { exitCode: 7, code: "cancel_run_unproven" });
    assert.equal(await x.f.exists(path.join(x.config.paths.setup_state_dir, "cancel-request.json")), false);
  }
});
test("R3 emergency runtime bytes changed after bootstrap cannot dispatch", async () => {
  const q = await trustedEmergencyFixture(); await fs.appendFile(q.pin, "tampered runtime");
  await assert.rejects(emergencyCancel({ fsAdapter: q.x.f, processAdapter: q.proc }, q.x.config), { code: "emergency_node_pin_unproven" });
  assert.equal(q.calls.length, 0); assert.equal(await q.x.f.exists(path.join(q.x.config.paths.application_state_dir, "PAUSED")), false);
});
for (const signalExit of [130, 143]) test(`R3 injected signal ${signalExit} before any intent has confirmed release`, async () => {
  const q = await counterFixture(); await q.x.planAndApprove(q.make()); let hits = 0;
  q.stage.admitOperation = async () => { hits++; const { setupError } = await import("../../src/core/errors"); throw setupError({ exitCode: signalExit, code: "injected_signal_at_safe_boundary", publicMessage: "no operation started", nextAction: "inspect" }); };
  const result = await q.make().run("apply", q.x.applyOptions);
  assert.ok(hits > 0); assert.equal(result.exitCode, signalExit); assert.deepEqual(q.counts, [0]);
  assert.equal(await q.x.f.exists(path.join(q.x.config.paths.setup_state_dir, "lock")), false);
});
