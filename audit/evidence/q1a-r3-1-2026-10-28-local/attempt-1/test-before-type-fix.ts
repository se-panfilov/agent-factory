import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { aptFixture, evidence } from "../helpers/r21-admission";
import { r14Process, r14Noop } from "../helpers/r14-engine";
import { proxyFs, trustedEmergencyFixture, ok } from "../helpers/r3-protocol";
import { requestCancel } from "../../src/core/lock";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { createSystemStage } from "../../src/stages/system";
import { type EmergencyOutcome } from "../../src/operations/emergency";
const hash = async (file: string) => {
  const stat = await fs.lstat(file);
  const bytes = stat.isSymbolicLink() ? Buffer.from("symlink:" + await fs.readlink(file)) : await fs.readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
};
const emit = (id: string, data: Record<string, unknown>) => console.log("R31_EVIDENCE " + JSON.stringify({ id, actual_uid: process.getuid?.(), injected_uid: 1000, ...data }));

const cancelKinds = ["none", "matching", "stale", "foreign", "legacy", "legacy-null", "broken-json", "missing-ticks", "extra", "unknown-version", "owner-extra", "owner-type", "bad-pid", "bad-boot", "bad-nonce", "bad-date", "null", "array", "duplicate", "oversize", "utf8", "unsafe-mode", "symlink", "broken-symlink", "metadata-error", "invalid-legacy"];
for (const kind of cancelKinds) test(`R31 cancel strict format ${kind}`, async () => {
  const q = await aptFixture(); await q.x.planAndApprove(q.make());
  const dir = q.x.config.paths.setup_state_dir, file = path.join(dir, "cancel-request.json");
  let hits = 0, before: Awaited<ReturnType<typeof evidence>> | undefined, requestHash: string | undefined, generation: unknown;
  const f = proxyFs(q.x.f, { lstat: async p => {
    if (kind === "metadata-error" && hits && p === file) throw Object.assign(Error("unreadable cancellation metadata"), { code: "EACCES" });
    return q.x.f.lstat(p);
  }, fsyncDir: async p => {
    await q.x.f.fsyncDir(p);
    if (kind === "none" || hits || p !== dir || await q.x.f.exists(path.join(dir, "lock-protocol")) || !(await q.x.f.exists(path.join(dir, "lock/owner.json")))) return;
    hits++; assert.deepEqual(q.counts, { refresh: 0, simulate: 0, install: 0 });
    await requestCancel(q.x.f, q.x.config, r14Process);
    const raw = JSON.parse(await fs.readFile(file, "utf8")); generation = structuredClone(raw.owner);
    if (kind === "stale") raw.owner.nonce = "11111111-2222-4333-8444-555555555555";
    if (kind === "foreign") raw.owner.installation_id = "11111111-2222-4333-8444-555555555555";
    if (kind === "missing-ticks") delete raw.owner.process_start_ticks;
    if (kind === "extra") raw.extra = true;
    if (kind === "unknown-version") raw.schema_version = 99;
    if (kind === "owner-extra") raw.owner.extra = true;
    if (kind === "owner-type") raw.owner.process_start_ticks = "1";
    if (kind === "bad-pid") raw.owner.pid = -1;
    if (kind === "bad-boot") raw.owner.boot_id = "unknown";
    if (kind === "bad-nonce") raw.owner.nonce = "unknown";
    if (kind === "bad-date") raw.owner.created_at = "2026-02-31T00:00:00.000Z";
    let body = JSON.stringify(raw);
    if (["legacy", "legacy-null", "invalid-legacy"].includes(kind)) body = JSON.stringify({ requested_at: raw.owner.created_at, installation_id: q.x.config.installation_id,
      target_lock_nonce: kind === "legacy-null" ? null : raw.owner.nonce,
      target_lock_pid: kind === "legacy-null" ? null : raw.owner.pid,
      target_lock_boot_id: kind === "legacy-null" ? null : raw.owner.boot_id, ...(kind === "invalid-legacy" ? { extra: true } : {}) });
    if (kind === "broken-json") body = "{";
    if (kind === "null") body = "null";
    if (kind === "array") body = "[]";
    if (kind === "duplicate") body = body.replace('"schema_version":2', '"schema_version":2,"schema_version":2');
    if (kind === "oversize") body = " ".repeat(4097);
    await fs.writeFile(file, kind === "utf8" ? Buffer.from([0xff, 0xfe]) : body);
    if (kind === "unsafe-mode") await fs.chmod(file, 0o666);
    if (kind === "symlink") { await fs.rename(file, file + ".owned"); await fs.symlink(file + ".owned", file); }
    if (kind === "broken-symlink") { await fs.rename(file, file + ".owned"); await fs.symlink(file + ".missing", file); }
    if (kind !== "broken-symlink") await q.x.f.fsyncFile(file);
    await q.x.f.fsyncDir(dir);
    before = await evidence(q.x.config); requestHash = await hash(file);
  } });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: q.clock }, createRegistry([r14Noop("S01"), createSystemStage(q.apt)])).run("apply", q.x.applyOptions);
  const allowed = ["none", "stale", "foreign", "legacy", "legacy-null"].includes(kind);
  assert.equal(hits, kind === "none" ? 0 : 1);
  assert.equal(result.exitCode, allowed ? 0 : kind === "matching" ? 130 : 8, JSON.stringify(result));
  assert.deepEqual(q.counts, allowed ? { refresh: 1, simulate: 1, install: 1 } : { refresh: 0, simulate: 0, install: 0 });
  if (!allowed && kind !== "matching") assert.equal(result.envelope.error?.code, "cancel_evidence_unknown");
  const journal = await fs.readFile(path.join(dir, "events.jsonl"), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  const targetEvents = journal.split("\n").filter(Boolean).map(JSON.parse).filter(e => e.stage === "S02");
  assert.equal(targetEvents.length, allowed ? 12 : 0);
  if (!allowed) assert.deepEqual(await evidence(q.x.config), before);
  if (hits) assert.equal(await hash(file), requestHash);
  emit(`cancel-${kind}`, { hits, generation, exit: result.exitCode, error: result.envelope.error, before, after: await evidence(q.x.config), request_before: requestHash,
    request_after: hits ? await hash(file) : null, counts: q.counts, target_events: targetEvents.length });
});

for (const kind of ["present", "absent", "empty", "stale", "incomplete", "symlink", "live-empty", "daemon-reject", "daemon-failure", "inspect-malformed", "inspect-limit", "throw-stop", "throw-after-prefix", "return-after-prefix", "witness-after-prefix", "unknown-postcondition", "missing-status"]) test(`R31 emergency discovery/outcome ${kind}`, async () => {
  const q = await trustedEmergencyFixture({ status: kind !== "missing-status" });
  const invFile = path.join(q.x.config.paths.setup_state_dir, "s11-emergency-inventory.json");
  if (kind !== "absent") await q.inventory();
  if (kind === "empty" || kind === "stale" || kind === "incomplete") {
    const inv = JSON.parse(await fs.readFile(invFile, "utf8"));
    if (kind === "empty") inv.owned_container_labels = [];
    if (kind === "stale") inv.installation_id = "11111111-2222-4333-8444-555555555555";
    if (kind === "incomplete") delete inv.owned_container_labels;
    await fs.writeFile(invFile, JSON.stringify(inv));
  }
  if (kind === "symlink") { await fs.rename(invFile, invFile + ".owned"); await fs.symlink(invFile + ".owned", invFile); }
  let hits = 0;
  q.onCommand(async c => {
    if (kind === "live-empty" && c.args[0] === "ps") { hits++; return ok(""); }
    if (kind === "daemon-reject" && c.args[0] === "ps") { hits++; throw Object.assign(Error("private marker not for output"), { code: "EACCES" }); }
    if (kind === "daemon-failure" && c.args[0] === "ps") { hits++; return { ...ok(), exitCode: 1 }; }
    if (kind === "inspect-malformed" && c.args[0] === "inspect") { hits++; return ok("{"); }
    if (kind === "inspect-limit" && c.args[0] === "inspect") { hits++; return { ...ok(), outputLimitExceeded: true }; }
    if (kind === "throw-stop" && c.binary === q.pin) { hits++; throw Object.assign(Error("private marker not for output"), { code: "ENOENT" }); }
    if (["throw-after-prefix", "return-after-prefix"].includes(kind) && c.args[0] === "inspect" && c.args.at(-1)?.startsWith("b")) {
      assert.ok(q.stopped.has("a".repeat(12))); hits++;
      if (kind === "throw-after-prefix") throw Object.assign(Error("private marker not for output"), { code: "EIO" });
      return { ...ok(), exitCode: 1 };
    }
    if (kind === "witness-after-prefix" && c.args[0] === "inspect" && q.stopped.has("a".repeat(12))) {
      hits++; await fs.appendFile(path.join(q.x.config.paths.application_dir, "runner.cjs"), "drift after this postcondition");
    }
    if (kind === "unknown-postcondition" && c.binary === q.pin && c.args.at(-1) === "status") { hits++; return ok('{"status":"running"}'); }
    return undefined;
  });
  const before = await evidence(q.x.config);
  const result = await new SetupEngine({ fsAdapter: q.x.f, processAdapter: q.proc }, createRegistry([])).run("cancel", { configPath: q.x.configPath, emergency: true });
  const outcome = result.envelope.data?.emergency_outcome as EmergencyOutcome;
  const positive = ["present", "absent", "empty", "stale", "incomplete", "symlink", "live-empty"].includes(kind);
  assert.equal(result.exitCode, positive ? 0 : 8, JSON.stringify(result));
  assert.equal(outcome.paused.publication, "durable"); assert.equal(outcome.paused.exists, true);
  assert.deepEqual(await evidence(q.x.config), before);
  assert.equal(JSON.stringify(result).includes("private marker"), false);
  if (!positive && kind !== "missing-status") assert.ok(hits > 0);
  if (kind === "missing-status") { assert.equal(result.envelope.error?.code, "emergency_postcondition_missing"); assert.equal(q.calls.length, 1); }
  if (positive && kind !== "live-empty") {
    assert.deepEqual(outcome.stopped_containers, ["a".repeat(12)]); assert.deepEqual(outcome.skipped_foreign_containers, ["b".repeat(12)]);
    assert.equal(q.stopped.has("b".repeat(12)), false); assert.equal(q.calls.filter(c => c.binary === "/usr/bin/docker").length, 5);
  }
  if (kind === "live-empty") { assert.equal(outcome.docker_discovery, "verified_empty"); assert.deepEqual(outcome.stopped_containers, []); }
  if (["throw-after-prefix", "return-after-prefix", "witness-after-prefix"].includes(kind)) {
    assert.deepEqual(outcome.stopped_containers, ["a".repeat(12)]);
    assert.ok(outcome.confirmed_stopped.includes("container:" + "a".repeat(12))); assert.ok(outcome.unknown.includes("container:" + "b".repeat(12)));
  }
  if (!positive) { assert.equal(result.envelope.error?.retryable, false); assert.match(result.envelope.error!.next_action, /manually|Manually/); assert.doesNotMatch(result.envelope.error!.next_action, /fresh plan/); }
  emit(`emergency-${kind}`, { hits, before, after: await evidence(q.x.config), result, calls: q.calls, stopped: [...q.stopped] });
});

for (const phase of ["write", "file-fsync", "rename-before", "rename-after", "parent-fsync", "cleanup-after-sync"]) for (const old of [false, true]) test(`R31 PAUSED publication ${phase}/old=${old}`, async () => {
  const q = await trustedEmergencyFixture(), paused = path.join(q.x.config.paths.application_state_dir, "PAUSED");
  await fs.mkdir(path.dirname(paused), { recursive: true, mode: 0o700 });
  if (old) await fs.writeFile(paused, "old PAUSED evidence\n", { mode: 0o600 });
  const oldHash = old ? await hash(paused) : null; let hits = 0;
  const fail = () => { hits++; throw Object.assign(Error("publication failed"), { code: "ENOSPC" }); };
  const f = proxyFs(q.x.f, {
    writeText: async (p, b, m) => { if (phase === "write" && p.endsWith("/payload")) fail(); await q.x.f.writeText(p, b, m); },
    fsyncFile: async p => { if (phase === "file-fsync" && p.endsWith("/payload")) fail(); await q.x.f.fsyncFile(p); },
    rename: async (a, b) => { if (b === paused && phase === "rename-before") fail(); await q.x.f.rename(a, b); if (b === paused && phase === "rename-after") fail(); },
    fsyncDir: async p => { if (phase === "parent-fsync" && p === path.dirname(paused)) fail(); await q.x.f.fsyncDir(p); },
    remove: async (p, opts) => { if (phase === "cleanup-after-sync" && p.includes(".publish-")) fail(); await q.x.f.remove(p, opts); }
  });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: q.proc }, createRegistry([])).run("cancel", { configPath: q.x.configPath, emergency: true });
  const outcome = result.envelope.data?.emergency_outcome as EmergencyOutcome;
  assert.equal(hits, 1); assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "emergency_pause_unconfirmed"); assert.equal(q.calls.length, 0);
  const published = ["rename-after", "parent-fsync", "cleanup-after-sync"].includes(phase);
  assert.equal(outcome.paused.publication, phase === "cleanup-after-sync" ? "durable" : published ? "published_unconfirmed" : "not_published");
  assert.equal(outcome.paused.exists, old || published);
  if (old && !published) { assert.equal(await hash(paused), oldHash); assert.equal(outcome.paused.prior_preserved, true); }
  emit(`pause-${phase}-${old}`, { hits, result, old_hash: oldHash, new_hash: old || published ? await hash(paused) : null, calls: q.calls.length });
});
test("R31 emergency raw admission exception is typed before PAUSED or dispatch", async () => {
  const q = await trustedEmergencyFixture(), before = await evidence(q.x.config); let hits = 0;
  const f = proxyFs(q.x.f, { hashFile: async (p, bound, deadline) => {
    if (p === q.x.config.release.archive_path) { hits++; throw Object.assign(Error("private admission detail"), { code: "EIO" }); }
    return q.x.f.hashFile!(p, bound, deadline);
  } });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: q.proc }, createRegistry([])).run("cancel", { configPath: q.x.configPath, emergency: true });
  const outcome = result.envelope.data?.emergency_outcome as EmergencyOutcome;
  assert.equal(hits, 1); assert.equal(result.exitCode, 8); assert.equal(result.envelope.error?.code, "emergency_admission_unknown");
  assert.equal(outcome.phase, "pre_admission"); assert.equal(outcome.paused.publication, "not_attempted");
  assert.equal(q.calls.length, 0); assert.equal(await q.x.f.exists(outcome.paused.path), false);
  assert.equal(JSON.stringify(result).includes("private admission detail"), false); assert.deepEqual(await evidence(q.x.config), before);
});
