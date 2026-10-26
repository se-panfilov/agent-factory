// C13 adapter: only flat plan gate enumeration; oracle/counters unchanged. Fixture provides explicit OS/session/valid lock.
'use strict';
// Reviewer measurements: actual engine + S02; APT and host identity are injected.
// Changes only owned temporary files. No sudo, network, credentials, daemon or reboot.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const repo = path.resolve(process.argv[2]);
const { r14Fixture, r14Noop, r14Process } = require(path.join(repo, 'setup/dist/tests/helpers/r14-engine.js'));
const { SetupEngine } = require(path.join(repo, 'setup/dist/src/core/engine.js'));
const { createRegistry } = require(path.join(repo, 'setup/dist/src/core/plan.js'));
const { createSystemStage } = require(path.join(repo, 'setup/dist/src/stages/system.js'));
const { hashConfig } = require(path.join(repo, 'setup/dist/src/core/config.js'));
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const rows = [];
async function measure(id, change, approve = true) {
  const x = await r14Fixture('S02');
  const lock = JSON.parse(await fs.readFile(path.join(repo, 'setup/versions.lock.json'), 'utf8'));
  await fs.writeFile(x.config.version_lock_path, JSON.stringify(lock));
  const counts = { refresh: 0, simulate: 0, install: 0 };
  let metadataFresh = false, installed = false;
  const apt = {
    observe: async names => ({ metadataFresh, metadataUpdatedAt: metadataFresh ? '2026-10-26T10:00:00Z' : null,
      sudoAvailable: true, dpkgAuditClean: true, dpkgAuditOutput: '', rebootRequired: false,
      packages: names.map(name => ({ name, candidateVersion: '1.0.0', installedVersion: installed ? '1.0.0' : null })) }),
    refreshMetadata: async () => { counts.refresh++; metadataFresh = true; },
    simulateInstall: async () => { counts.simulate++; },
    installPinned: async () => { counts.install++; installed = true; }
  };
  const clock = { now: () => new Date('2026-10-26T10:00:00Z') };
  let boot = await r14Process.bootId(), machine = await r14Process.machineIdHash();
  const proc = { ...r14Process, bootId: async () => boot, machineIdHash: async () => machine };
  const engine = () => new SetupEngine({ fsAdapter: x.f, processAdapter: proc, clock },
    createRegistry([r14Noop('S01'), createSystemStage(apt)]));
  const first = engine();
  assert.equal((await first.run('plan', { configPath: x.configPath })).exitCode, 0);
  const planBytes = await fs.readFile(x.applyOptions.planPath), plan = JSON.parse(planBytes);
  const gateIds = [...new Set([...plan.stage_scope.flatMap(s => s.requires_gates), ...plan.operations.flatMap(o => o.requires_gates)])];
  assert.ok(gateIds.length > 0);
  if (approve) for (const gateId of gateIds) {
    const r = await first.run('gate-approve', { configPath: x.configPath, gateId, planHash: plan.plan_hash });
    assert.equal(r.exitCode, 0, JSON.stringify(r));
  }
  const stateBefore = await x.state(), beforeLock = digest(await fs.readFile(x.config.version_lock_path));
  const configHash = hashConfig(x.config);
  if (change === 'machine') machine = 'b'.repeat(64);
  if (change === 'boot') boot = 'fe6d5e7a-2737-4898-9c8b-97f09a7a54a7';
  if (change === 'lock') {
    lock.docker.ce = '5:29.9.3-1~ubuntu.24.04~noble';
    await fs.writeFile(x.config.version_lock_path, JSON.stringify(lock));
  }
  const result = await engine().run('apply', { ...x.applyOptions, nonInteractive: true });
  const stateAfter = await x.state();
  const permitted = change === 'none' && approve;
  const acceptance = permitted ? result.exitCode === 0 && counts.install === 1
    : result.exitCode !== 0 && Object.values(counts).every(n => n === 0);
  assert.equal(hashConfig(JSON.parse(await fs.readFile(x.configPath, 'utf8'))), configHash);
  assert.equal(digest(await fs.readFile(x.applyOptions.planPath)), digest(planBytes));
  rows.push({ id, fixture: 'actual engine + real S02; S01 noop, APT and process identity injected',
    change, approved: approve, gate_ids: gateIds, serialized_gate_fields: Object.keys(stateBefore.pending_gates[0]),
    recorded_host: stateBefore.host_fingerprint, current_machine: machine, current_boot: boot,
    lock_hash_before: beforeLock, lock_hash_after: digest(await fs.readFile(x.config.version_lock_path)),
    submitted_plan_unchanged: true, config_unchanged: true,
    exit: result.exitCode, error: result.envelope.error?.code ?? null, counts,
    s02_status: stateAfter.stages.find(s => s.id === 'S02').status, acceptance,
    real_privileged_or_network_commands: 0 });
  console.log(JSON.stringify(rows.at(-1)));
}
(async () => {
  await measure('B01_same_context_positive', 'none');
  await measure('B02_foreign_machine', 'machine');
  await measure('B03_new_boot_old_approval', 'boot');
  await measure('B04_same_path_changed_version_lock', 'lock');
  await measure('B05_unapproved_control', 'none', false);
  console.log(JSON.stringify({ id: 'META', cases: rows.length, desired_pass: rows.filter(r => r.acceptance).length,
    note: 'No physical host clone/reboot/privileged effect. Do not count harness exit 0 as product PASS.' }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
