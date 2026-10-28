import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeProcessAdapter, commandSucceeded, type CommandOptions } from "../../src/adapters/process";
import { executionScope, RunLifecycle, TERM_GRACE_MS } from "../../src/adapters/process-lifecycle";
import { AttemptDeadline } from "../../src/core/deadline";

const adapter = new NodeProcessAdapter();
const command = (args: string[], extra: Partial<CommandOptions> = {}): CommandOptions => ({
  policy: "interruptible", binary: process.execPath, args, timeoutMs: 3000, maxOutputBytes: 4096, ...extra
});
const code = (source: string, extra: Partial<CommandOptions> = {}) => adapter.runCommand(command(["-e", source], extra));
async function ready(file: string): Promise<void> {
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    try { await access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.fail("Readiness barrier not reached");
}

test("Q1B normal literal argv, cwd, shell=false, actual exit/signal and no ambient env", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "q1b-argv-"));
  try {
    process.env.Q1B_SYNTHETIC_AMBIENT = "synthetic-marker";
    const r = await adapter.runCommand(command(["-e", "console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),ambient:!!process.env.Q1B_SYNTHETIC_AMBIENT,path:process.env.PATH}))", "a b", ";literal", "$(literal)"], { cwd: dir, env: { PATH: "/decoy" } }));
    assert.equal(commandSucceeded(r), true); assert.equal(r.cleanup, "confirmed"); assert.equal(r.signal, null);
    const v = JSON.parse(r.stdout); assert.deepEqual(v.argv, ["a b", ";literal", "$(literal)"]); assert.equal(v.ambient, false);
    assert.equal(v.cwd, await import("node:fs/promises").then(fs => fs.realpath(dir)));
    assert.equal(v.path, "/usr/bin:/bin:/usr/sbin:/sbin"); assert.ok(r.owner?.pid);
  } finally { delete process.env.Q1B_SYNTHETIC_AMBIENT; await rm(dir, { recursive: true }); }
});
for (const [name, value] of Object.entries({ zero: 0, negative: -1, infinite: Infinity, nan: NaN, fractional: .5 })) {
  test(`Q1B invalid timeout ${name} refuses before spawn`, async () => {
    await assert.rejects(code("process.exit(99)", { timeoutMs: value }), { code: "process_bounds_invalid" });
  });
  test(`Q1B invalid output bound ${name} refuses before spawn`, async () => {
    await assert.rejects(code("process.exit(99)", { maxOutputBytes: value }), { code: "process_bounds_invalid" });
  });
}
for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "DOCKER_HOST", "DOCKER_CONTEXT", "NODE_TLS_REJECT_UNAUTHORIZED", "UNREVIEWED"]) {
  test(`Q1B explicit env ${key} refuses without running target`, async () => {
    await assert.rejects(code("process.exit(99)", { env: { [key]: "synthetic-never-executed" } }), { code: "process_env_forbidden" });
  });
}
test("Q1B documented proxy, CA and fixed dates env positives without network", async () => {
  const env = { HTTPS_PROXY: "http://proxy.invalid:8080", NO_PROXY: "localhost,127.0.0.1", SSL_CERT_FILE: "/owned/reference/ca.pem", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };
  const r = await code("console.log(JSON.stringify(process.env))", { env });
  assert.ok(commandSucceeded(r)); for (const [k, v] of Object.entries(env)) assert.equal(JSON.parse(r.stdout)[k], v);
});
test("Q1B proxy credentials, conflict and insecure URL are refused", async () => {
  for (const env of [{ HTTPS_PROXY: "http://user:synthetic@proxy.invalid" }, { HTTPS_PROXY: "file:///tmp/a" }, { HTTPS_PROXY: "http://a.invalid", https_proxy: "http://b.invalid" }]) {
    await assert.rejects(code("process.exit(99)", { env }));
  }
});
test("Q1B spawn ENOENT and EACCES preserve absent exit code and confirmed no child", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "q1b-spawn-"));
  try {
    const file = path.join(dir, "not-executable"); await writeFile(file, "fixture", { mode: 0o600 });
    for (const [binary, error] of [[path.join(dir, "missing"), "ENOENT"], [file, "EACCES"]]) {
      const r = await adapter.runCommand(command([], { binary: binary! }));
      assert.equal(r.spawnError, error); assert.equal(r.spawned, false); assert.equal(r.exitCode, null); assert.equal(r.cleanup, "confirmed");
    }
  } finally { await rm(dir, { recursive: true }); }
});
test("Q1B critical mutation is a typed blocker before any real spawn", async () => {
  await assert.rejects(code("process.exit(99)", { policy: "critical" }), { code: "process_critical_supervisor_unavailable", exitCode: 5 });
  await assert.rejects(adapter.runCommand(command(["-n", "/usr/bin/apt-get", "update"], { binary: "/usr/bin/sudo" })), { code: "process_critical_supervisor_unavailable" });
});
test("Q1B combined interleaved output budget includes marker and prevents verified success", async () => {
  const r = await code("for(let i=0;i<1000;i++){process.stdout.write('abcd');process.stderr.write('efgh')}setTimeout(()=>{},10000)", { maxOutputBytes: 64 });
  assert.ok(r.outputLimitExceeded); assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= 64);
  assert.equal(commandSucceeded(r), false); assert.equal(r.cleanup, "confirmed"); assert.ok(r.durationMs < 3000);
});
test("Q1B split UTF8 is reconstructed, malformed output never authenticates machine facts", async () => {
  const good = await code("const b=Buffer.from('€😃');for(const x of b)process.stdout.write(Buffer.from([x]));");
  assert.equal(good.stdout, "€😃"); assert.equal(commandSucceeded(good), true);
  const bad = await code("process.stdout.write(Buffer.from([0xff]));");
  assert.equal(bad.outputInvalid, true); assert.equal(commandSucceeded(bad), false);
  for (const maxOutputBytes of [1, 2, 3, 4, 8, 16]) {
    const r = await code("process.stdout.write('😃'.repeat(100));", { maxOutputBytes });
    assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= maxOutputBytes); assert.ok(!r.stdout.includes("�"));
  }
});
test("Q1B chunk split and truncated synthetic secrets do not leak", async () => {
  const r = await code("for(const s of ['tok','en=','SYNTHETIC_PRIVATE_MARKER','\\nBearer ','SYNTHETIC_BEARER_MARKER'])process.stdout.write(s)");
  assert.ok(!r.stdout.includes("SYNTHETIC_"));
  const truncated = await code("process.stdout.write('token=SYNTHETIC_PRIVATE_MARKER'.repeat(30))", { maxOutputBytes: 16 });
  assert.ok(!truncated.stdout.includes("SYNTHETIC")); assert.ok(Buffer.byteLength(truncated.stdout) <= 16);
});
test("Q1B cancel before spawn is registered, repeated abort settles once", async () => {
  const controller = new AbortController(); controller.abort();
  const r = await code("process.exit(99)", { signal: controller.signal });
  assert.equal(r.spawned, false); assert.equal(r.cancelled, true); assert.equal(r.cleanup, "confirmed"); assert.equal(r.exitCode, null);
});
test("Q1B own group TERM includes ready descendant; unrelated owned group is untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "q1b-term-"));
  const barrier = path.join(dir, "ready"), foreignReady = path.join(dir, "foreign");
  const controller = new AbortController(), foreign = new AbortController();
  const other = code(`require('fs').writeFileSync(${JSON.stringify(foreignReady)},'ready');setTimeout(()=>process.exit(0),1200);`, { signal: foreign.signal });
  try {
    const child = `require('fs').writeFileSync(${JSON.stringify(barrier)},'ready');setTimeout(()=>process.exit(0),4000);`;
    const running = code(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),4000);`, { signal: controller.signal });
    await Promise.all([ready(barrier), ready(foreignReady)]); controller.abort(); controller.abort();
    const r = await running; assert.equal(r.cancelled, true); assert.equal(r.signal, "SIGTERM"); assert.equal(r.cleanup, "confirmed");
    const f = await other; assert.equal(f.exitCode, 0); assert.equal(f.terminationReason, null); assert.equal(f.cleanup, "confirmed");
  } finally { foreign.abort(); await other; await rm(dir, { recursive: true }); }
});
test("Q1B production 10s escalation kills TERM-ignoring own group and held pipes", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "q1b-kill-")); const barrier = path.join(dir, "ready");
  const controller = new AbortController();
  try {
    const grand = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(barrier)},'ready');setTimeout(()=>process.exit(0),16000);`;
    const child = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),16000);`;
    const running = code(`process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),16000);`, { timeoutMs: 18000, signal: controller.signal });
    await ready(barrier); const at = performance.now(); controller.abort(); const r = await running;
    assert.equal(TERM_GRACE_MS, 10000); assert.ok(performance.now() - at >= 9900);
    assert.equal(r.signal, "SIGKILL"); assert.equal(r.cleanup, "confirmed"); assert.equal(r.cancelled, true);
  } finally { await rm(dir, { recursive: true }); }
});
test("Q1B parent exits with pipe-held descendant: finite residual cleanup is not ordinary success", async () => {
  const r = await code("require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),4000)'],{stdio:'inherit'});process.exit(0)");
  assert.equal(r.exitCode, 0); assert.equal(r.terminationReason, "descendant"); assert.equal(commandSucceeded(r), false); assert.equal(r.cleanup, "confirmed");
});
test("Q1B operation generation and timer isolation", async () => {
  const r = await code("setTimeout(()=>{},3000)", { timeoutMs: 40 });
  assert.equal(r.timedOut, true); assert.equal(r.cleanup, "confirmed");
  const next = await code("console.log('next-generation')");
  assert.ok(commandSucceeded(next)); assert.notEqual(r.owner?.generation, next.owner?.generation);
});
test("Q1B lifecycle first signal is stable and unknown cleanup dominates safe cancellation", async () => {
  const life = new RunLifecycle(); life.cancel("SIGTERM"); life.cancel("SIGINT"); assert.equal(life.reason, "SIGTERM");
  assert.throws(() => life.assertAdmission(), { exitCode: 143 }); life.cleanupUnknown = true;
  assert.throws(() => life.assertAdmission(), { exitCode: 8 });
  await assert.rejects(executionScope.run(life, () => code("process.exit(99)")), { exitCode: 8, code: "process_cleanup_unknown" });
  const cancelled = new RunLifecycle(); cancelled.cancel("SIGINT");
  const other = new AbortController();
  const r = await executionScope.run(cancelled, () => code("process.exit(99)", { signal: other.signal }));
  assert.equal(r.spawned, false); assert.equal(r.cancelled, true);
});
test("Q1B monotonic emergency deadline never renews and fences late awaits", async () => {
  let now = 100; const deadline = new AttemptDeadline(100, () => now);
  assert.equal(deadline.remaining(), 100); now = 150; assert.equal(await deadline.wait(async () => "ok"), "ok");
  await assert.rejects(deadline.wait(async () => { now = 201; return "late"; }), { exitCode: 8, code: "emergency_deadline_or_cancel" });
  assert.equal(deadline.remaining(), 0); let dispatch = 0;
  await assert.rejects(deadline.wait(async () => { dispatch++; }), { exitCode: 8 }); assert.equal(dispatch, 0);
});
test("Q1B mismatched generation and EPERM observer never authorize a signal", async () => {
  const { supervise } = await import("../../src/adapters/process-supervisor");
  for (const mode of ["reuse", "EPERM"]) {
    let hits = 0;
    const r = await supervise(command(["-e", "setTimeout(()=>process.exit(0),180)"], { timeoutMs: 40 }), {
      observe: async (_pid, generation) => {
        hits++;
        if (hits === 1) {
          if (mode === "EPERM") throw Object.assign(Error("injected"), { code: "EPERM" });
          return { generation: "another-generation", status: "alive" };
        }
        return { generation, status: "dead" };
      }
    });
    assert.ok(hits >= 2); assert.equal(r.signal, null); assert.equal(r.exitCode, 0); assert.equal(r.cleanup, "unknown");
  }
});
test("Q1B independent signal exit preserves actual signal and absent numeric exit", async () => {
  const r = await code("process.kill(process.pid,'SIGTERM')");
  assert.equal(r.exitCode, null); assert.equal(r.signal, "SIGTERM"); assert.equal(commandSucceeded(r), false); assert.equal(r.cleanup, "confirmed");
});

test("Q1B non-settling group observer has a finite unknown outcome without keepalive", async () => {
  const { supervise } = await import("../../src/adapters/process-supervisor"); let hits = 0;
  const r = await supervise(command(["-e", "setTimeout(()=>process.exit(0),180)"], { timeoutMs: 40 }), {
    observe: async (_pid, generation) => { hits++; return hits === 1 ? new Promise(() => {}) : { generation, status: "dead" }; }
  });
  assert.ok(hits >= 2); assert.equal(r.cleanup, "unknown"); assert.equal(r.signal, null); assert.equal(r.exitCode, 0);
  assert.ok(r.durationMs < 1500);
});
