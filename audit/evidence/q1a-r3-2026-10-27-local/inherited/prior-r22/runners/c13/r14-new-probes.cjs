// C13 fixture/input adapter. Original counters/oracles preserved; see adapter-map.md.
const __c13=require('../c13-fixture-compat.cjs')(process.argv[2]);
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const rawfs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const repo = path.resolve(process.argv[2]);
const from = n => require(path.join(repo, 'setup/dist/src', n + '.js'));
const fixtureDir = path.resolve(process.argv[3] || path.join(__dirname, 'frozen-r14-fixtures'));
const helperFilename = path.join(repo, 'setup/dist/tests/helpers/r14-engine.js');
const helperModule = new Module(helperFilename, module);
helperModule.filename = helperFilename;
helperModule.paths = Module._nodeModulePaths(path.dirname(helperFilename));
helperModule._compile(rawfs.readFileSync(path.join(fixtureDir, 'r14-engine.js'), 'utf8'), helperFilename);
const { r14Fixture, r14Noop } = helperModule.exports;
function helpers(file, names) {
  const filename = path.join(repo, 'setup/dist/tests/integration', file + '.test.js');
  const raw = rawfs.readFileSync(path.join(fixtureDir, file + '.test.js'), 'utf8');
  const at = raw.indexOf('(0, node_test_1.default)(');
  assert.ok(at > 0, 'Only fixture definitions, never test callbacks, are loaded');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(raw.slice(0, at) + '\nmodule.exports = {' + names.join(',') + '};', filename);
  return m.exports;
}
const results = [];
async function run(id, fn) {
  try { const row = { id, harness_ok: true, ...await fn() }; results.push(row); console.log(__c13.stringify(row)); }
  catch (e) { console.log(__c13.stringify({ id, harness_ok: false, error: e.stack })); process.exitCode = 1; }
}
function brief(r) { return { exit: r.exitCode, code: r.envelope.error?.code ?? null }; }
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('Review harness timeout'); process.exit(2); }, 45000);
(async () => {
  const ahelp = helpers('application', ['makeCheckout', 'makeRelease', 'FakeApplicationAdapter']);
  for (const command of ['plan', 'verify', 'status-refresh']) {
    await run('N01_hash_mismatch_' + command, async () => {
      const x = await r14Fixture('S05');
      const adapter = new ahelp.FakeApplicationAdapter(ahelp.makeCheckout(x.config), ahelp.makeRelease(x.config));
      const e = x.engine([r14Noop('S04'), from('stages/application').createApplicationStage(adapter)]);
      await x.planAndApprove(e);
      const applied = await e.run('apply', x.applyOptions);
      assert.equal(applied.exitCode, 0, __c13.stringify(applied));
      const before = adapter.probeCalls;
      assert.ok(before > 0, 'Positive control actually executes mandatory probes');
      // Previously reviewed, journal-bound checkout has changed after deployment.
      adapter.hashMismatches = ['runner.js:hash-mismatch'];
      const observed = await e.run(command === 'status-refresh' ? 'status' : command,
        { configPath: x.configPath, ...(command === 'status-refresh' ? { refresh: true } : {}) });
      const after = adapter.probeCalls;
      const state = await x.state();
      return { command, fixture: x.root, applied: brief(applied), observed: brief(observed),
        hash_mismatches: adapter.hashMismatches, probes_before: before, probes_after: after,
        probes_after_known_hash_failure: after - before, stage_status: state.stages.find(s => s.id === 'S05')?.status,
        acceptance: after === before, real_commands: 0 };
    });
  }
  const dh = helpers('docker-host', ['baseObservation', 'FakeDockerAdapter']);
  await run('N02a_real_adapter_permission_mapping', async () => {
    const commands = [];
    const fakeProcess = { pid: () => process.pid, uid: () => 1000, username: () => 'factory',
      runCommand: async ({ binary, args }) => {
        commands.push({ binary, args });
        let exitCode = 0, stdout = '', stderr = '';
        if (binary === '/usr/bin/docker') {
          if (args[0] === 'context' && args[1] === 'show') stdout = 'default\n';
          else if (args[0] === 'context') stdout = '"unix:///var/run/docker.sock"\n';
          else { exitCode = 1; stderr = 'permission denied while trying to connect to the Docker daemon socket'; }
        } else if (binary === '/usr/bin/id') stdout = 'factory\n';
        else if (binary === '/usr/bin/getent') stdout = 'docker:x:998:\n';
        return { exitCode, stdout, stderr, timedOut: false };
      } };
    const f = { exists: async () => false,
      stat: async p => { assert.equal(p, '/var/run/docker.sock'); return { uid: 0, gid: 998, mode: 0o140660 }; } };
    const adapter = new (from('adapters/docker').NodeDockerAdapter)(fakeProcess, f);
    const observed = await adapter.observe({ installationId: 'fixture', config: {} });
    assert.equal(observed.daemonReachable, false);
    assert.equal(observed.apiCompatible, false);
    assert.equal(observed.dockerGroup.currentUserInGroup, false);
    assert.equal(observed.dockerSocket.worldWritable, false);
    return { daemon_reachable: observed.daemonReachable, api_compatible: observed.apiCompatible,
      active_group: observed.dockerGroup.currentUserInGroup, socket_mode: observed.dockerSocket.mode,
      daemon_commands: commands.filter(c => c.binary === '/usr/bin/docker'),
      acceptance: true, scope: 'Actual NodeDockerAdapter.observe; all commands intercepted by fake ProcessAdapter', real_commands: 0 };
  });
  await run('N02_docker_without_active_group', async () => {
    const x = await r14Fixture('S04');
    const o = dh.baseObservation();
    o.dockerGroup = { exists: false, currentUserInGroup: false, accountUserInGroup: false };
    const adapter = new dh.FakeDockerAdapter(o);
    adapter.changeGroupMembership = true;
    const originalObserve = adapter.observe.bind(adapter);
    adapter.observe = async () => {
      const observed = await originalObserve();
      // NodeDockerAdapter uses ordinary-owner docker info/version. A secure
      // root:docker 0660 socket cannot be used before the group's activation.
      if (!observed.dockerGroup.currentUserInGroup) {
        observed.daemonReachable = false; observed.apiCompatible = false;
        observed.serverVersion = null;
      }
      return observed;
    };
    const e = x.engine([r14Noop('S03'), from('stages/docker').createDockerStage(adapter)]);
    await x.planAndApprove(e);
    const applied = await e.run('apply', x.applyOptions);
    const state = await x.state();
    const journal = (await fs.readFile(path.join(x.config.paths.setup_state_dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(__c13.parse);
    return { fixture: x.root, applied: brief(applied), install_calls: adapter.installCalls,
      restart_calls: adapter.restartCalls, group_calls: adapter.groupCalls, probe_calls: adapter.probeCalls,
      inflight: state.in_flight_operation, stage_status: state.stages.find(s => s.id === 'S04')?.status,
      journal_tail: journal.slice(-4).map(r => ({ operation: r.operation_id, code: r.code })),
      acceptance: applied.exitCode === 4 && adapter.groupCalls === 1 && state.in_flight_operation === null,
      real_commands: 0 };
  });
  await run('N03_ssh_include_outside_default_directory', async () => {
    const { observeAccessInputProof } = from('stages/access');
    const files = new Map([
      ['/etc/ssh/sshd_config', 'Include /etc/ssh/extra/access.conf\n'],
      ['/etc/ssh/extra/access.conf', 'Match User factory\n  PasswordAuthentication no\n']
    ]);
    const reads = [];
    const missing = () => Object.assign(new Error('fixture absent'), { code: 'ENOENT' });
    const f = {
      lstat: async p => {
        if (!files.has(p)) throw missing();
        return { uid: 0, gid: 0, mode: 0o100644, isFile: () => true,
          isDirectory: () => false, isSymbolicLink: () => false };
      },
      readTextBounded: async (p, limit) => {
        reads.push(p); if (!files.has(p)) throw missing();
        const body = Buffer.from(files.get(p));
        return { text: body.subarray(0, limit).toString(), bytesRead: Math.min(body.length, limit), truncated: body.length > limit };
      },
      readdir: async () => { throw new Error('No fixture directories are present'); }
    };
    let before, after, refused = null;
    try {
      before = await observeAccessInputProof(f, 1000, '/fixture/manual');
      files.set('/etc/ssh/extra/access.conf', 'Match User factory\n  PasswordAuthentication yes\n');
      after = await observeAccessInputProof(f, 1000, '/fixture/manual');
    } catch (e) { refused = e.code ?? String(e); }
    const changed = before && after && __c13.stringify(before) !== __c13.stringify(after);
    return { included_file: '/etc/ssh/extra/access.conf', before, after, refused,
      include_read: reads.includes('/etc/ssh/extra/access.conf'), proof_changed: !!changed,
      acceptance: refused !== null || !!changed, real_commands: 0 };
  });
  console.log(__c13.stringify({ id: 'META', node: process.version, repo, cases: results.length,
    accepted: results.filter(r => r.acceptance).length, note: 'harness_ok only means measured; acceptance is the product expectation', real_commands: 0 }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });
