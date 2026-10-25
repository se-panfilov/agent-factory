'use strict';
// Each worker is owned by one test. Its caller-supplied cwd is fixed before loading setup.
// Only locally authored stdout/argv fixtures run; no network/privileged commands.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { commandFixture, reviewedBody } = require(path.join(process.argv[2], 'tests/helpers/r16-commands.js'));
const { r14Noop } = require(path.join(process.argv[2], 'tests/helpers/r14-engine.js'));
(async () => {
  const spec = JSON.parse(process.argv[3]);
  const q = await commandFixture(spec.entry, {real: true, direct: spec.direct});
  const manifest = q.a.release.manifest;
  const argv = spec.direct ? [spec.entry] : [spec.pinned ? q.pinned : 'node', spec.entry];
  argv.push(...(spec.args || []));
  manifest.commands = {runner_verify: [...argv], runner_stop: [...argv]};
  if (spec.mixed) {
    const name = 'bin/check';
    const body = `#!${process.execPath}\n${reviewedBody}`;
    q.files[name] = body;
    manifest.content_hashes[name] = require('node:crypto').createHash('sha256').update(body).digest('hex');
    manifest.commands.runner_stop = [name, ...(spec.args || [])];
  }
  const schema = q.schema(); assert.equal(schema.ok, true);
  if (spec.decoy) {
    const decoy = path.join(process.cwd(), spec.entry);
    await fs.mkdir(path.dirname(decoy), {recursive: true});
    await fs.writeFile(decoy, 'process.stdout.write("CWD_DECOY\\n");\n');
  }
  if (spec.engine) {
    const e = q.makeEngine(); await q.x.planAndApprove(e);
    assert.equal((await e.run('apply', q.x.applyOptions)).exitCode, 0);
    assert.equal((await e.run('plan', {configPath: q.x.configPath})).exitCode, 0);
    assert.equal((await e.run('verify', {configPath: q.x.configPath})).exitCode, 0);
    assert.equal((await e.run('status', {configPath: q.x.configPath, refresh: true})).exitCode, 0);
    assert.equal((await e.run('apply', q.x.applyOptions)).exitCode, 0);
    assert.equal((await e.run('resume', {configPath: q.x.configPath})).exitCode, 0);
    const before = q.invocations.length;
    const statePath = path.join(q.x.config.paths.setup_state_dir, 'state.json');
    const state = await fs.readFile(statePath);
    assert.equal((await e.run('status', {configPath: q.x.configPath})).exitCode, 0);
    assert.equal(q.invocations.length, before);
    assert.deepEqual(await fs.readFile(statePath), state);
  } else {
    await q.materialize(); const result = await q.probe();
    assert.equal(result.runnerVerifyHelpOk && result.runnerStopHelpOk, true);
  }
  process.send({ok: true, schema_valid: schema.ok, entry: spec.entry, hashed_path: path.join(q.x.config.paths.application_dir, spec.entry),
    pinned: q.pinned, spec, invocations: q.invocations});
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
