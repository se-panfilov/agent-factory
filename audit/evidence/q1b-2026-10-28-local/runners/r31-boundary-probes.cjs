'use strict';
// Reviewer measurements on exact R3 sources. Real owned FS; fake external effects.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(process.argv[2]);
const req = p => require(path.join(repo, 'setup/dist', p));
const { aptFixture } = req('tests/helpers/r21-admission.js');
const { r14Process, r14Noop } = req('tests/helpers/r14-engine.js');
const { proxyFs, trustedEmergencyFixture, ok } = req('tests/helpers/r3-protocol.js');
const { SetupEngine } = req('src/core/engine.js');
const { createRegistry } = req('src/core/plan.js');
const { createSystemStage } = req('src/stages/system.js');
const { requestCancel } = req('src/core/lock.js');
const rows = [];
let complete = false;
process.on('beforeExit', () => {
  if (!complete) { console.error('INCOMPLETE reviewer R31 probes'); process.exitCode = 70; }
});
const emit = row => { rows.push(row); console.log(JSON.stringify(row)); };

async function cancelCase(kind) {
  const q = await aptFixture();
  await q.x.planAndApprove(q.make());
  const stateDir = q.x.config.paths.setup_state_dir;
  const file = path.join(stateDir, 'cancel-request.json');
  let hits = 0, beforeCounts = null, original = null, published = null;
  const f = proxyFs(q.x.f, { fsyncDir: async p => {
    await q.x.f.fsyncDir(p);
    if (kind === 'none' || hits || p !== stateDir
      || await q.x.f.exists(path.join(p, 'lock-protocol'))
      || !(await q.x.f.exists(path.join(p, 'lock/owner.json')))) return;
    hits++;
    beforeCounts = { ...q.counts };
    await requestCancel(q.x.f, q.x.config, r14Process);
    original = JSON.parse(await fs.readFile(file, 'utf8'));
    const payload = structuredClone(original);
    if (kind === 'stale') payload.owner.nonce = '11111111-2222-4333-8444-555555555555';
    if (kind === 'v2-missing-field') delete payload.owner.process_start_ticks;
    if (kind === 'v2-extra-field') payload.extra = true;
    if (kind === 'unknown-version') payload.schema_version = 99;
    published = kind === 'broken-json' ? '{' : kind === 'legacy'
      ? JSON.stringify({ requested_at: original.owner.created_at, installation_id: q.x.config.installation_id,
          target_lock_nonce: original.owner.nonce, target_lock_pid: original.owner.pid, target_lock_boot_id: original.owner.boot_id })
      : JSON.stringify(payload);
    if (kind !== 'valid') await fs.writeFile(file, published);
  } });
  const result = await new SetupEngine({ fsAdapter: f, processAdapter: r14Process, clock: q.clock },
    createRegistry([r14Noop('S01'), createSystemStage(q.apt)])).run('apply', q.x.applyOptions);
  const rawJournal = await fs.readFile(path.join(stateDir, 'events.jsonl'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  });
  const events = rawJournal.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.stage === 'S02').map(e => e.code);
  assert.equal(hits, kind === 'none' ? 0 : 1);
  if (hits) assert.deepEqual(beforeCounts, { refresh: 0, simulate: 0, install: 0 });
  const allowed = ['none', 'stale', 'legacy'].includes(kind);
  const wantedExit = allowed ? 0 : kind === 'valid' ? 130 : 8;
  const desired = allowed
    ? result.exitCode === 0 && Object.values(q.counts).every(n => n === 1)
    : result.exitCode === wantedExit && Object.values(q.counts).every(n => n === 0) && events.length === 0;
  emit({ id: 'C-' + kind, hits, before_counts: beforeCounts, original, published,
    exit: result.exitCode, error: result.envelope.error, counts: q.counts, target_events: events,
    request_retained: await q.x.f.exists(file), desired_pass: desired, real_external_commands: 0 });
}

async function emergencyCase(kind) {
  const q = await trustedEmergencyFixture();
  if (kind !== 'no-inventory') await q.inventory();
  if (kind === 'empty-inventory') {
    const file = path.join(q.x.config.paths.setup_state_dir, 's11-emergency-inventory.json');
    const inv = JSON.parse(await fs.readFile(file, 'utf8'));
    inv.owned_container_labels = [];
    await fs.writeFile(file, JSON.stringify(inv));
  }
  let hits = 0;
  q.onCommand(async c => {
    if (kind === 'throw-stop' && c.binary === q.pin) {
      hits++; throw Object.assign(Error('owned injected spawn ENOENT'), { code: 'ENOENT' });
    }
    if (kind === 'throw-after-prefix' && c.binary === '/usr/bin/docker' && c.args[0] === 'inspect' && c.args.at(-1).startsWith('b')) {
      assert.ok(q.stopped.has('a'.repeat(12))); hits++;
      throw Object.assign(Error('owned injected inspection EIO after confirmed owned stop'), { code: 'EIO' });
    }
    if (kind === 'return-failure' && c.binary === q.pin) { hits++; return { ...ok(), exitCode: 1 }; }
    return undefined;
  });
  const result = await new SetupEngine({ fsAdapter: q.x.f, processAdapter: q.proc }, createRegistry([]))
    .run('cancel', { configPath: q.x.configPath, emergency: true });
  const paused = await q.x.f.exists(path.join(q.x.config.paths.application_state_dir, 'PAUSED'));
  const dockerCalls = q.calls.filter(c => c.binary === '/usr/bin/docker');
  const liveOwnedAfter = !q.stopped.has('a'.repeat(12));
  let desired;
  if (kind === 'control') desired = result.exitCode === 0 && !liveOwnedAfter && paused;
  else if (['no-inventory', 'empty-inventory'].includes(kind)) desired = result.exitCode !== 0 || !liveOwnedAfter;
  else {
    assert.equal(hits, 1);
    desired = result.exitCode === 8 && paused;
  }
  emit({ id: 'E-' + kind, hits, exit: result.exitCode, error: result.envelope.error, data: result.envelope.data,
    calls: q.calls.map(c => ({ binary: c.binary === q.pin ? '<checked-node-pin>' : c.binary, args: c.args, cwd: c.cwd })),
    docker_calls: dockerCalls.length, fixture_owned_container_running_before: true, fixture_owned_container_running_after: liveOwnedAfter,
    stopped: [...q.stopped], paused, desired_pass: desired, real_external_commands: 0 });
}

(async () => {
  for (const kind of ['none', 'valid', 'stale', 'legacy', 'broken-json', 'v2-missing-field', 'v2-extra-field', 'unknown-version']) await cancelCase(kind);
  for (const kind of ['control', 'no-inventory', 'empty-inventory', 'return-failure', 'throw-stop', 'throw-after-prefix']) await emergencyCase(kind);
  complete = true;
  console.log(JSON.stringify({ id: 'META', cases: rows.length, desired_pass: rows.filter(r => r.desired_pass).length,
    node: process.version, actual_uid: process.getuid(), injected_uid: 1000, source: repo, real_external_commands: 0 }));
})().catch(e => { complete = true; console.error(e.stack); process.exitCode = 1; });
