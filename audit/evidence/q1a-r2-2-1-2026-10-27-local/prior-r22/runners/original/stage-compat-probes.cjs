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

const Module=require('node:module'),rawFs=require('node:fs');
function helpers(file,names){
 const filename=path.join(repo,'setup/dist/tests/integration',file+'.test.js');const raw=rawFs.readFileSync(filename,'utf8');
 const at=raw.indexOf('(0, node_test_1.default)(');assert.ok(at>0,filename);
 const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m._compile(raw.slice(0,at)+'\nmodule.exports={'+names.join(',')+'};',filename);return m.exports;
}
async function runLifecycle(e,x,id){
 const p=await e.run('plan',{configPath:x.configPath,stageId:id});assert.equal(p.exitCode,0,JSON.stringify(p));
 const diskPlan=JSON.parse(await fs.readFile(path.join(x.c.paths.setup_state_dir,'plan.json'),'utf8'));
 for(const g of p.envelope.data.required_approvals){const a=await e.run('gate-approve',{configPath:x.configPath,gateId:g.id,planHash:p.envelope.plan_hash});assert.equal(a.exitCode,0,JSON.stringify(a));}
 const a=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});
 const s=await e.run('status',{configPath:x.configPath});
 const jPath=path.join(x.c.paths.setup_state_dir,'events.jsonl');const records=await f.exists(jPath)?(await fs.readFile(jPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];
 return {stage:id,plan_exit:p.exitCode,apply_exit:a.exitCode,error:a.envelope.error?.code??null,status_exit:s.exitCode,planned_operations:diskPlan.stages.find(s=>s.stage_id===id).operations.map(o=>({id:o.id,kind:o.kind,resource:o.resource_id})),journal:records.filter(r=>r.stage===id).map(r=>({operation:r.operation_id,phase:r.code})),inflight:(await readState(x)).in_flight_operation};
}
(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'af-r12-stage-compat-'));
 for(const id of ['S03','S04','S05']){
  const x=await fixture(id,[id]);let a,s,prereq;
  if(id==='S03') {const h=helpers('access',['FakeAccessAdapter','baseObservation']);a=new h.FakeAccessAdapter(h.baseObservation());s=from('stages/access.js').createAccessStage(a);prereq='S02';}
  if(id==='S04') {const h=helpers('docker-host',['FakeDockerAdapter','baseObservation']);a=new h.FakeDockerAdapter(h.baseObservation());s=from('stages/docker.js').createDockerStage(a);prereq='S03';}
  if(id==='S05') {const h=helpers('application',['FakeApplicationAdapter','makeCheckout','makeRelease']);a=new h.FakeApplicationAdapter(h.makeCheckout(x.c),h.makeRelease(x.c));s=from('stages/application.js').createApplicationStage(a);prereq='S04';}
  const result=await runLifecycle(engine([stage(prereq),s]),x,id);const counters=Object.fromEntries(Object.entries(a).filter(([k,v])=>k.endsWith('Calls')&&typeof v==='number'));
  emit(id,{...result,adapter_effect_counts:counters,real_commands:0});
 }
 const h=helpers('verification-auth',['prepareScenario']);const q=await h.prepareScenario();q.config.selected_stages=['S07'];await fs.writeFile(q.configPath,JSON.stringify(q.config));
 const result=await runLifecycle(q.engine,{c:q.config,configPath:q.configPath,primary:path.join(q.config.paths.setup_state_dir,'state.json')},'S07');
 emit('S07',{...result,offline_report_exists:await f.exists(path.join(q.config.paths.setup_state_dir,'s07-offline-verification.json')),real_commands:0});
 emit('META',{repo,node:process.version,temporary_root:root});
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
