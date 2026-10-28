'use strict';
// Harmless owned Node children only. No sudo, Docker, network, credentials or product writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const repo = path.resolve(process.argv[2]);
const { NodeProcessAdapter } = require(path.join(repo, 'setup/dist/src/adapters/process.js'));
const proc = new NodeProcessAdapter();
let complete = false;
process.on('beforeExit', () => { if (!complete) { console.error('INCOMPLETE Q1B collector'); process.exitCode = 70; } });
const rows = [];
const emit = row => { rows.push(row); console.log(JSON.stringify(row)); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async p => fs.access(p).then(() => true, () => false);
async function invoke(options) {
  try { return { returned: await proc.runCommand({ policy: "interruptible", binary: process.execPath, args: [], timeoutMs: 2000, maxOutputBytes: 4096, ...options }) }; }
  catch (e) { return { rejected: { code: e.code ?? null, exitCode: e.exitCode ?? null, name: e.name } }; }
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r31-review-q1b-'));
  const args = ['two words', '--eval', 'literal"quote', 'semi;colon'];
  const positive = await invoke({ args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] });
  emit({ id: 'B01-argv-control', ...positive, expected_args: args,
    desired_pass: positive.returned?.exitCode === 0 && positive.returned.stdout.trim() === JSON.stringify(args) });

  const flood = await invoke({ args: ['-e', `process.on('SIGTERM',()=>{});let n=0;const t=setInterval(()=>{process.stdout.write('X'.repeat(4096));process.stderr.write('Y'.repeat(4096));if(++n===24){clearInterval(t);setTimeout(()=>process.exit(0),25);}},2);`], maxOutputBytes: 64 });
  const stdoutBytes = Buffer.byteLength(flood.returned?.stdout ?? ''), stderrBytes = Buffer.byteLength(flood.returned?.stderr ?? '');
  emit({ id: 'B02-output-budget', ...flood, limit: 64, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
    finite_child_output_bound: 196608, desired_pass: stdoutBytes + stderrBytes <= 64 && (Boolean(flood.rejected) || flood.returned?.outputLimitExceeded === true) });

  const ready = path.join(root, 'grandchild-ready.json'), late = path.join(root, 'grandchild-late.json');
  const grand = `const f=require('node:fs');f.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,time:Date.now()}));setTimeout(()=>f.writeFileSync(${JSON.stringify(late)},JSON.stringify({pid:process.pid,time:Date.now()})),600);setTimeout(()=>process.exit(0),900);`;
  const parent = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:['ignore','inherit','inherit']});console.log(JSON.stringify({parent:process.pid,grandchild:c.pid}));c.once('exit',()=>process.exit(0));`;
  const started = Date.now();
  const tree = await invoke({ args: ['-e', parent], timeoutMs: 250 });
  // The bounded fixture exits on its own in < 1s. Observe after that bound; no orphan left running.
  await wait(Math.max(0, 1150 - (Date.now() - started)));
  const reached = await exists(ready), lateExists = await exists(late);
  assert.equal(reached, true, 'grandchild fixture must actually start');
  const pid = JSON.parse(await fs.readFile(ready, 'utf8')).pid;
  let finalState = 'absent';
  try { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); finalState = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; }
  catch (e) { if (e.code !== 'ENOENT') finalState = 'unknown'; }
  assert.ok(['absent','Z'].includes(finalState), 'owned finite child must no longer run');
  emit({ id: 'B03-owned-tree-term', ...tree, timeout_ms: 250, grandchild_started: reached,
    grandchild_effect_after_deadline: lateExists, final_grandchild_state: finalState,
    desired_pass: !lateExists && (Boolean(tree.rejected) || tree.returned?.timedOut === true) });

  const hookFile = path.join(root, 'owned-preload.cjs'), marker = path.join(root, 'preload-marker');
  await fs.writeFile(hookFile, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'OWNED_SYNTHETIC_MARKER');`);
  const env = await invoke({ args: ['-e', "console.log('owned-env-probe')"], env: { NODE_OPTIONS: `--require=${hookFile}` } });
  const executed = await exists(marker);
  emit({ id: 'B04-explicit-preload-env', ...env, preload_executed: executed,
    scope: 'explicit internal API env; not a demonstrated public config exploit', desired_pass: !executed });

  process.env.Q1B_SYNTHETIC_AMBIENT = 'owned-canary';
  const ambient = await invoke({ args: ['-e', "console.log(JSON.stringify({ambient:!!process.env.Q1B_SYNTHETIC_AMBIENT,path:process.env.PATH,locale:process.env.LC_ALL}))"], env: { PATH: '/owned-decoy' } });
  delete process.env.Q1B_SYNTHETIC_AMBIENT;
  const observed = ambient.returned ? JSON.parse(ambient.returned.stdout) : null;
  emit({ id: 'B05-ambient-env-control', ...ambient, observed,
    desired_pass: ambient.returned?.exitCode === 0 && observed?.ambient === false && observed?.path === '/usr/bin:/bin:/usr/sbin:/sbin' && observed?.locale === 'C' });
  complete = true;
  console.log(JSON.stringify({ id: 'META', cases: rows.length, desired_pass: rows.filter(r => r.desired_pass).length,
    desired_fail: rows.filter(r => !r.desired_pass).length, real_privileged_commands: 0, external_network_calls: 0,
    actual_uid: process.getuid(), node: process.version, platform: process.platform, fixture_root: root }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
