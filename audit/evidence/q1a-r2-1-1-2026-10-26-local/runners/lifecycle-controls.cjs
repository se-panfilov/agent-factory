const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const repo = process.argv[2] || process.cwd();
const from = name => require(path.join(repo, 'setup/dist/src', name));
const { NodeFilesystemAdapter } = from('adapters/filesystem.js');
const { initConfig, stableStringify } = from('core/config.js');
const { loadState, initState, saveState, appendEvent, inspectJournalEvidence, stateHash } = from('core/state.js');
const { acquireLock, requestCancel } = from('core/lock.js');
const { SetupEngine } = from('core/engine.js');
const { createRegistry } = from('core/plan.js');
const { createSystemStage } = from('stages/system.js');
const { createAuthStage } = from('stages/auth.js');
const { createPreflightStage } = from('stages/preflight.js');

const f = new NodeFilesystemAdapter();
let instant = new Date('2026-10-23T10:00:00Z');
const clock = { now: () => new Date(instant) };
const proc = {
  pid: () => process.pid, uid: () => 1000, username: () => 'factory',
  bootId: async () => 'f324dcd7-4035-4430-ab39-ce31f9e396bf',
  machineIdHash: async () => 'a'.repeat(64), processStartTicks: async () => 1,
  isPidAlive: () => true,
  runCommand: async () => { throw new Error('No real commands permitted in review probes'); }
};
let root;
const emit = (id, result) => console.log(JSON.stringify({ id, ...result }));
function stage(id, dependencies = [], overrides = {}) {
  return {
    id, dependencies, supportedProfiles: ['supervised', 'service'], optional: false, requiredCapabilities: [],
    observe: async () => ({ stageId: id, status: 'verified', checks: {}, versions: {}, observedAt: clock.now().toISOString() }),
    plan: () => ({ stageId: id, optional: false, requiredCapabilities: [], operations: [], requiredGates: [] }),
    apply: async () => [], verify: async () => [], recover: async () => [], ...overrides
  };
}
const engine = (stages, extra = {}) => new SetupEngine({ fsAdapter: f, processAdapter: proc, clock, ...extra }, createRegistry(stages));
async function fixture(name, selected = ['S01']) {
  instant = new Date('2026-10-23T10:00:00Z');
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const c = await initConfig(f, configPath, 'supervised', 'factory');
  for (const [key, suffix] of Object.entries({ setup_state_dir: 'setup-state', setup_cache_dir: 'cache', setup_bin_dir: 'bin', setup_node_dir: 'node', application_dir: 'app', application_state_dir: 'app/state', application_auth_dir: 'app/auth', application_work_dir: 'app/work' })) c.paths[key] = path.join(dir, suffix);
  c.version_lock_path = path.join(dir, 'versions.lock.json');
  c.release.archive_path = path.join(dir, 'release.tar.xz');
  c.selected_stages = selected;
  await fs.writeFile(configPath, JSON.stringify(c));
  await fs.mkdir(c.paths.setup_state_dir, { recursive: true });
  return { c, configPath, dir, primary: path.join(c.paths.setup_state_dir, 'state.json'), marker: path.join(c.paths.setup_state_dir, 'recovery-required.json') };
}
async function initial(c) {
  const state = await initState(f, proc, clock, c, '0.0.1');
  await saveState(f, c, state);
  return state;
}
async function expectCode(action, expected) {
  let observed;
  try { await action(); } catch (error) { observed = error.code || error.message; }
  assert.equal(observed, expected);
}

const readOnly = { initializeIfMissing: false, persistConfigDrift: false, readOnly: true };
const ioError = code => Object.assign(new Error(`injected ${code}`), { code });
const pending = id => ({ id, stage_id: 'S08', kind: 'mutate', started_at: clock.now().toISOString() });
function eventLine(sequence, code, id, stageId = 'S01') {
  const record = { sequence, at: clock.now().toISOString(), operation_id: id, stage: stageId, code, message: `${code}:test` };
  record.checksum = createHash('sha256').update(`${record.sequence}|${record.at}|${record.operation_id}|${record.stage}|${record.code}|${record.message}`).digest('hex');
  return JSON.stringify(record) + '\n';
}
async function writeJournal(x, text) {
  await fs.writeFile(path.join(x.c.paths.setup_state_dir, 'events.jsonl'), text);
}
async function readState(x) { return JSON.parse(await fs.readFile(x.primary, 'utf8')); }
function fakeApt(initiallyInstalled) {
  let installed = initiallyInstalled;
  let installCalls = 0;
  return {
    count: () => installCalls,
    adapter: {
      observe: async names => ({ metadataFresh: true, metadataUpdatedAt: clock.now().toISOString(), sudoAvailable: true, dpkgAuditClean: true, dpkgAuditOutput: '', rebootRequired: false, packages: names.map(name => ({ name, installedVersion: installed ? '1.0' : null, candidateVersion: '1.0' })) }),
      refreshMetadata: async () => { throw new Error('unexpected refresh'); },
      simulateInstall: async () => {},
      installPinned: async () => { installed = true; installCalls++; }
    }
  };
}

// Review probes assert observed behavior at b0bc219. Defect assertions must be
// inverted into fail-closed regression expectations when implementing a fix.
const op = (id, kind = 'mutate') => ({id, stageId:'S01', kind, resourceId:`res-${id}`,risk:'low',gateIds:[],preconditions:[],sideEffects:kind==='mutate'?['temp fixture only']:[],timeoutSec:10,retryable:false});
const receipt = (o, overrides={}) => ({operationId:o.id,stageId:o.stageId,resourceId:o.resourceId,observedAt:clock.now().toISOString(),checks:{verified:true},versions:{},artifacts:[],...overrides});
const plannedStage = (ops, apply) => stage('S01', [], {plan:()=>({stageId:'S01',optional:false,requiredCapabilities:[],operations:ops,requiredGates:[]}),apply});
async function applyOnce(e,x) {
 const p=await e.run('plan',{configPath:x.configPath}); assert.equal(p.exitCode,0,JSON.stringify(p));
 const a=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});
 return a;
}
async function journal(x) {const p=path.join(x.c.paths.setup_state_dir,'events.jsonl');return await f.exists(p)?(await fs.readFile(p,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];}
async function preparedFixture(name) {
 const x=await fixture(name), s=await initial(x.c);
 await saveState(f,x.c,s); await fs.unlink(x.primary);
 let hits=0; const faulted=Object.create(f);
 faulted.writeText=async (p,body,mode)=>{if(p.includes('state.json.tmp-')&&hits===0){hits++;throw ioError('EIO');}return f.writeText(p,body,mode);};
 const first=await engine([stage('S01')],{fsAdapter:faulted}).run('recover',{configPath:x.configPath});
 assert.equal(hits,1); assert.notEqual(first.exitCode,0,JSON.stringify(first));
 const m=JSON.parse(await fs.readFile(x.marker,'utf8')); assert.equal(m.recovery_commit.phase,'prepared');
 assert.equal(await f.exists(x.primary),false); assert.equal(m.recovery_commit.candidate_state_hash,stateHash(s));
 return {...x,s,m,hits,firstExit:first.exitCode,firstCode:first.envelope.error?.code};
}
async function test(id,fn) {try {emit(id,{passed:true,...await fn()});}catch(e){emit(id,{passed:false,error:String(e.stack||e)});process.exitCode=1;}}
(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'af-r11-b0bc219-'));
 await test('P01_actual_S00_S01_lifecycle',async()=>{
  const x=await fixture('bootstrap'); const bf=Object.create(f); bf.exists=async p=>path.basename(p)==='bootstrap-receipt.json'?true:f.exists(p);
  const defaults=new SetupEngine({fsAdapter:bf,processAdapter:proc,clock}); const b=defaults.registry.byId.get('S00'); assert.ok(b);
  const preflight=createPreflightStage({readOnlyHostReport:async()=>({osRelease:'ubuntu-24.04',arch:'amd64',uid:1000,username:'factory',hasSystemd:true,cgroupVersion:'v2',freeDiskBytes:1e11,totalDiskBytes:2e11,freeInodes:1e5,cpuCount:4,totalMemBytes:16e9})});
  const e=engine([b,preflight],{fsAdapter:bf});const a=await applyOnce(e,x); assert.equal(a.exitCode,0,JSON.stringify(a));
  const status=await e.run('status',{configPath:x.configPath});assert.equal(status.exitCode,0);
  const resumed=await engine([b,preflight],{fsAdapter:bf}).run('resume',{configPath:x.configPath});assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
  return {apply:0,status:0,resume:0,actual_registry_S00:true,new_engine_same_process:true};
 });
 await test('P02_real_S02_lifecycle',async()=>{
  const x=await fixture('apt',['S02']);const apt=fakeApt(false);const e=engine([stage('S01'),createSystemStage(apt.adapter)]);
  const p=await e.run('plan',{configPath:x.configPath});assert.equal(p.exitCode,0);
  const gate=await e.run('gate-approve',{configPath:x.configPath,gateId:'s02-sudo-apt-install',planHash:p.envelope.plan_hash});assert.equal(gate.exitCode,0);
  const a=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});assert.equal(a.exitCode,0,JSON.stringify(a));
  const status=await e.run('status',{configPath:x.configPath});assert.equal(status.exitCode,0);
  const resume=await e.run('resume',{configPath:x.configPath});assert.equal(resume.exitCode,0);
  const repeat=await applyOnce(e,x);assert.equal(repeat.exitCode,0,JSON.stringify(repeat));assert.equal(apt.count(),1);
  return {apply:0,status:0,resume:0,repeat:0,install_calls:apt.count(),journal:await inspectJournalEvidence(f,x.c)};
 });
 emit('META',{node:process.version,repo,real_commands:0});
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
