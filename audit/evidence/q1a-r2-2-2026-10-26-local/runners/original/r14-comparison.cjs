const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const repo = process.argv[2] || process.cwd();
const from = name => require(path.join(repo, 'setup/dist/src', name));
const { NodeFilesystemAdapter } = from('adapters/filesystem.js');
const { initConfig, stableStringify } = from('core/config.js');
const { loadState, initState, saveState, appendEvent, inspectJournalEvidence, stateHash, readStateCommitManifest } = from('core/state.js');
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

// Shared deterministic fixture helpers. Actual cases below measure baseline and current outcomes.
const op = (id, kind = 'mutate') => ({id, stageId:'S01', kind, resourceId:`res-${id}`,risk:'low',gateIds:[],preconditions:[],sideEffects:kind==='mutate'?['temp fixture only']:[],timeoutSec:10,retryable:false});
const receipt = (o, overrides={}) => ({operationId:o.id,stageId:o.stageId,resourceId:o.resourceId,observedAt:clock.now().toISOString(),checks:{verified:true},versions:{},artifacts:[],...overrides});
const plannedStage = (ops, apply) => stage('S01', [], {plan:()=>({stageId:'S01',optional:false,requiredCapabilities:[],operations:ops,requiredGates:[]}),apply});
async function applyOnce(e,x) {
 const p=await e.run('plan',{configPath:x.configPath}); assert.equal(p.exitCode,0,JSON.stringify(p));
 const a=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});
 return a;
}
async function journal(x) {const p=path.join(x.c.paths.setup_state_dir,'events.jsonl');return await f.exists(p)?(await fs.readFile(p,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];}
// Runner success means scenarios executed, not product acceptance.
async function test(id,fn){try{emit(id,{harness_ok:true,...await fn()});}catch(e){emit(id,{harness_ok:false,error:String(e.stack||e)});process.exitCode=1;}}
async function completeEffect(name) {
 const x=await fixture(name);const o=op('completed-op');let calls=0;
 const e=engine([plannedStage([o],async()=>{calls++;return[receipt(o)];})]);
 const a=await applyOnce(e,x);assert.equal(a.exitCode,0,JSON.stringify(a));
 const state=await readState(x);const m=await readStateCommitManifest(f,x.c);const j=await journal(x);
 assert.equal(m.last_state_hash,stateHash(state));assert.equal(m.last_effect_checkpoint.state_hash,j.at(-1).state_hash);
 return {...x,e,state,m,calls};
}
async function provenMissing(name) {
 const x=await completeEffect(name);await saveState(f,x.c,x.state);await fs.unlink(x.primary);
 assert.equal(stateHash(JSON.parse(await fs.readFile(x.primary+'.previous','utf8'))),stateHash(x.state));
 return x;
}
async function prepareViaFault(name) {
 const x=await provenMissing(name);let hits=0;const faulty=Object.create(f);
 faulty.writeText=async(p,body,mode)=>{if(p.includes('state.json.tmp-')&&hits===0){hits++;throw ioError('EIO');}return f.writeText(p,body,mode);};
 const r=await engine([stage('S01')],{fsAdapter:faulty}).run('recover',{configPath:x.configPath});
 assert.equal(hits,1);assert.equal(r.exitCode,8,JSON.stringify(r));assert.equal(r.envelope.error.code,'recovery_primary_persist_failed');
 const marker=JSON.parse(await fs.readFile(x.marker,'utf8'));assert.equal(marker.recovery_commit.phase,'prepared');
 return {...x,markerRecord:marker,hits};
}

const Module=require('node:module'),rawFs=require('node:fs');
function helpers(file,names){
 const filename=path.join(repo,'setup/dist/tests/integration',file+'.test.js');const raw=rawFs.readFileSync(path.join(process.argv[3], file+'.test.js'),'utf8');
 const at=raw.indexOf('(0, node_test_1.default)(');assert.ok(at>0,filename);
 const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m._compile(raw.slice(0,at)+'\nmodule.exports={'+names.join(',')+'};',filename);return m.exports;
}
async function runLifecycle(e,x,id,beforeApply=async()=>{}){
 const p=await e.run('plan',{configPath:x.configPath,stageId:id});assert.equal(p.exitCode,0,JSON.stringify(p));
 const diskPlan=JSON.parse(await fs.readFile(path.join(x.c.paths.setup_state_dir,'plan.json'),'utf8'));
 for(const g of p.envelope.data.required_approvals){const a=await e.run('gate-approve',{configPath:x.configPath,gateId:g.id,planHash:p.envelope.plan_hash});assert.equal(a.exitCode,0,JSON.stringify(a));}
 await beforeApply();
 const a=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});
 const s=await e.run('status',{configPath:x.configPath});
 const jPath=path.join(x.c.paths.setup_state_dir,'events.jsonl');const records=await f.exists(jPath)?(await fs.readFile(jPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];
 return {stage:id,plan_exit:p.exitCode,apply_exit:a.exitCode,error:a.envelope.error?.code??null,status_exit:s.exitCode,planned_operations:diskPlan.stages.find(s=>s.stage_id===id).operations.map(o=>({id:o.id,kind:o.kind,resource:o.resource_id})),journal:records.filter(r=>r.stage===id).map(r=>({operation:r.operation_id,phase:r.code})),inflight:(await readState(x)).in_flight_operation};
}

const brief=r=>({exit:r.exitCode,code:r.envelope.error?.code??null,data:r.envelope.data??null});
const manifestFile=x=>path.join(x.c.paths.setup_state_dir,'state-commit.json');
async function maybeText(p){try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function evidenceSnapshot(x){const out={};for(const n of ['state.json','state.json.previous','state-commit.json','events.jsonl','recovery-required.json']){const t=await maybeText(path.join(x.c.paths.setup_state_dir,n));out[n]=t===null?null:createHash('sha256').update(t).digest('hex');}return out;}

const reviewKeepAlive=setInterval(()=>{},1000);
const reviewDeadline=setTimeout(()=>{console.error('Review harness deadline exceeded before META completion');process.exit(2);},45000);
(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'af-r13-review-'));
 await test('C01_engine_generated_safe_recovery',async()=>{
  const cases=[];
  for(const mode of ['direct','plan-first']){
   const x=await completeEffect('safe-'+mode);
   const previousBefore=JSON.parse(await fs.readFile(x.primary+'.previous','utf8'));
   const cleanHash=stateHash(x.state), checkpointHash=x.m.last_effect_checkpoint.state_hash;
   const checkpointingPlan=await x.e.run('plan',{configPath:x.configPath});assert.equal(checkpointingPlan.exitCode,0,JSON.stringify(checkpointingPlan));
   assert.equal(stateHash(JSON.parse(await fs.readFile(x.primary+'.previous','utf8'))),cleanHash);
   await fs.unlink(x.primary);
   const plan=mode==='plan-first'?await x.e.run('plan',{configPath:x.configPath}):null;
   const before=await evidenceSnapshot(x);
   const r=await x.e.run('recover',{configPath:x.configPath});
   const after=await evidenceSnapshot(x),m=await readStateCommitManifest(f,x.c);
   const retry=await x.e.run('recover',{configPath:x.configPath});
   cases.push({mode,fixture_proof:'apply then ordinary plan via engine; remove only primary',clean_hash_equals_checkpoint:cleanHash===checkpointHash,checkpoint_matches_previous_inflight:stateHash(previousBefore)===checkpointHash&&previousBefore.in_flight_operation!==null,plan:plan&&brief(plan),recover:brief(r),retry:brief(retry),before,after,last_effect_checkpoint_after:m.last_effect_checkpoint??null,primary_restored:await f.exists(x.primary)});
  }
  return {cases};
 });
 await test('C02_newer_unknown_manifest_old_checkpoint',async()=>{
  const x=await completeEffect('old-checkpoint');await saveState(f,x.c,{...x.state,in_flight_operation:pending('newer-unknown')});await fs.unlink(x.primary);
  const before=await evidenceSnapshot(x),r=await x.e.run('recover',{configPath:x.configPath}),after=await evidenceSnapshot(x);
  return {recover:brief(r),before,after,history_preserved:before['state-commit.json']===after['state-commit.json']};
 });
 await test('C03_manifest_only_not_fresh',async()=>{
  const x=await fixture('manifest-only');const s=await initial(x.c);await saveState(f,x.c,{...s,in_flight_operation:pending('lost-unknown')});
  await fs.unlink(x.primary);await fs.unlink(x.primary+'.previous');
  const before=await fs.readFile(manifestFile(x),'utf8');const e=engine([stage('S01')]);
  const r=await e.run('recover',{configPath:x.configPath}),p=await e.run('plan',{configPath:x.configPath});
  return {recover:brief(r),plan:brief(p),manifest_preserved:before===await fs.readFile(manifestFile(x),'utf8'),primary_exists:await f.exists(x.primary)};
 });
 await test('C04_markerless_primary_ignores_unknown_quarantine',async()=>{
  const x=await completeEffect('markerless-quarantine');const q=x.primary+'.corrupt-newer';
  await fs.writeFile(q,JSON.stringify({...x.state,in_flight_operation:pending('quarantined-unknown')}));
  const before=await evidenceSnapshot(x);const r=await x.e.run('recover',{configPath:x.configPath}),after=await evidenceSnapshot(x);
  const planned=await x.e.run('plan',{configPath:x.configPath});
  const a=planned.exitCode===0?await x.e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')}):planned;
  return {recover:brief(r),plan_exit:planned.exitCode,readonly_evidence_unchanged:JSON.stringify(before)===JSON.stringify(after),next_apply:brief(a),quarantine_still_exists:await f.exists(q),marker_exists:await f.exists(x.marker)};
 });
 await test('C05_S02_durable_progress_before_late_failure',async()=>{
  const x=await fixture('apt-failure',['S02']);let refreshed=false;const traces=[];
  const inspect=async where=>traces.push({at:where,journal:(await journal(x)).map(r=>({op:r.operation_id,phase:r.code}))});
  const apt={observe:async names=>({metadataFresh:refreshed,metadataUpdatedAt:clock.now().toISOString(),sudoAvailable:true,dpkgAuditClean:true,dpkgAuditOutput:'',rebootRequired:false,packages:names.map(name=>({name,installedVersion:null,candidateVersion:'1.0'}))}),refreshMetadata:async()=>{await inspect('refresh');refreshed=true;},simulateInstall:async()=>{await inspect('simulate');},installPinned:async()=>{await inspect('install');throw ioError('EIO');}};
  const e=engine([stage('S01'),createSystemStage(apt)]);const result=await runLifecycle(e,x,'S02');
  return {...result,traces,recover:brief(await e.run('recover',{configPath:x.configPath}))};
 });
 await test('C06_S05_failing_offline_probes_skipped',async()=>{
  const x=await fixture('application-probe',['S05']);const h=helpers('application',['FakeApplicationAdapter','makeCheckout','makeRelease']);
  const a=new h.FakeApplicationAdapter(h.makeCheckout(x.c),h.makeRelease(x.c),{runnerVerifyHelpOk:false,runnerStopHelpOk:false,details:['injected broken release']});
  const s=from('stages/application.js').createApplicationStage(a);const e=engine([stage('S04'),s]);
  const result=await runLifecycle(e,x,'S05');
  const recorded=(await readState(x)).stages.find(s=>s.id==='S05');
  return {...result,probe_configured_to_fail:true,probe_calls:a.probeCalls,extract_calls:a.extractCalls,materialize_calls:a.materializeCalls,recorded_status:recorded.status,verify:brief(await e.run('verify',{configPath:x.configPath,stageId:'S05'}))};
 });
 await test('C07_S04_first_install_group_prerequisite_cycle',async()=>{
  const x=await fixture('docker-relogin',['S04']);const h=helpers('docker-host',['FakeDockerAdapter','baseObservation']);
  const a=new h.FakeDockerAdapter(h.baseObservation());a.observation.dockerGroup.currentUserInGroup=false;a.changeGroupMembership=true;
  const s=from('stages/docker.js').createDockerStage(a);const e=engine([stage('S03'),s]);
  a.observation.dockerGroup.exists=false;
  const p=await e.run('plan',{configPath:x.configPath,stageId:'S04'});assert.equal(p.exitCode,0,JSON.stringify(p));
  const approvals=[];for(const g of p.envelope.data.required_approvals){const r=await e.run('gate-approve',{configPath:x.configPath,gateId:g.id,planHash:p.envelope.plan_hash});approvals.push({gate:g.id,...brief(r)});}
  const applied=await e.run('apply',{configPath:x.configPath,planPath:path.join(x.c.paths.setup_state_dir,'plan.json')});
  let resumeEvidence=null;
  if(applied.envelope.error?.code==='operation_manual_pause'){
    const newEngine=()=>engine([stage('S03'),from('stages/docker.js').createDockerStage(a)]);
    const oldSession=await newEngine().run('resume',{configPath:x.configPath});
    a.observation.dockerGroup.currentUserInGroup=true;a.observation.reloginRequired=false;
    const activeSession=await newEngine().run('resume',{configPath:x.configPath});
    const repeat=await newEngine().run('resume',{configPath:x.configPath});
    resumeEvidence={old_session:brief(oldSession),active_session:brief(activeSession),repeat:brief(repeat),install_calls:a.installCalls,group_calls:a.groupCalls,probe_calls:a.probeCalls};
  }
  return {plan_exit:p.exitCode,rejected_approvals:approvals.filter(a=>a.exit!==0),apply:brief(applied),install_calls:a.installCalls,group_calls:a.groupCalls,group_absent:!a.observation.dockerGroup.exists,current_owner_member:a.observation.dockerGroup.currentUserInGroup,resume_evidence:resumeEvidence};
 });
 await test('C08_S03_failed_tailnet_keeps_rollback',async()=>{
  const x=await fixture('access-failure',['S03']);const h=helpers('access',['FakeAccessAdapter','baseObservation']);const a=new h.FakeAccessAdapter(h.baseObservation());a.verifyPrivateResult=false;
  const s=from('stages/access.js').createAccessStage(a);const result=await runLifecycle(engine([stage('S02'),s]),x,'S03');
  return {...result,rollback_calls:a.rollbackCalls,disarm_calls:a.disarmCalls,rollback_armed:a.observation.rollback.armed};
 });
 await test('C09_prepared_conflicting_checkpoint_mutates_before_rejection',async()=>{
  const x=await prepareViaFault('prepared-checkpoint');const m=await readStateCommitManifest(f,x.c);
  m.last_effect_checkpoint.attempt_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';await fs.writeFile(manifestFile(x),JSON.stringify(m));
  const before=await evidenceSnapshot(x);const r=await x.e.run('recover',{configPath:x.configPath});const after=await evidenceSnapshot(x);
  return {recover:brief(r),before,after,primary_written:before['state.json']===null&&after['state.json']!==null,manifest_changed:before['state-commit.json']!==after['state-commit.json'],decision_changed:before['recovery-required.json']!==after['recovery-required.json']};
 });
 await test('C10_empty_verify_only_apply_traps',async()=>{
  const cases=[];
  for(const ops of [[],[op('verify-only','verify')]]){const x=await fixture('trap-'+ops.length);let calls=0;const r=await applyOnce(engine([plannedStage(ops,async()=>{calls++;throw Error('apply must not run');})]),x);assert.equal(r.exitCode,0,JSON.stringify(r));assert.equal(calls,0);cases.push({operations:ops.length,apply:brief(r),apply_calls:calls});}
  return {cases};
 });
 await test('C11_S03_approved_input_drift_not_rejected',async()=>{
  const x=await fixture('access-drift',['S03']);const h=helpers('access',['FakeAccessAdapter','baseObservation']);const a=new h.FakeAccessAdapter(h.baseObservation());
  const s=from('stages/access.js').createAccessStage(a);const e=engine([stage('S02'),s]);
  const result=await runLifecycle(e,x,'S03',async()=>{a.observation.ssh.configHash='external-sshd-change';a.observation.firewall.rulesHash='external-firewall-change';});
  const b=new h.FakeAccessAdapter(h.baseObservation()),direct=from('stages/access.js').createAccessStage(b);
  const ctx={installationId:x.c.installation_id,contractVersion:'1.0.0',profile:x.c.profile,desiredHash:'d'.repeat(64),planHash:'p'.repeat(64),config:x.c};
  const plan=direct.plan(x.c,await direct.observe(ctx));b.observation.ssh.configHash='external-sshd-change';b.observation.firewall.rulesHash='external-firewall-change';
  let directError=null;try{await direct.apply(ctx,plan);}catch(err){directError={code:err.code,exit:err.exitCode};}
  return {...result,engine_cutover_calls:a.cutoverCalls,engine_stage_calls:a.stageCalls,direct_stage_error:directError,direct_cutover_calls:b.cutoverCalls,change:'sshd config hash and firewall rules hash after plan approvals, before first effect'};
 });
 await test('C12_primary_restored_quarantine_admission_control',async()=>{
  // Synthetic protocol-consistent proof made through writer APIs, not a claim
  // that this is the checkpoint layout produced by SetupEngine.apply.
  const x=await fixture('cleanup-control'),s=await initial(x.c);await saveState(f,x.c,s);
  const attemptId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';let cp;
  for(const code of ['intent','effect','verify','checkpoint'])cp=await appendEvent(f,x.c,{operation_id:'proof-op',stage:'S01',code,message:code+':proof-op',attempt_id:attemptId,...(code==='checkpoint'?{state_hash:stateHash(s)}:{})});
  await from('core/state.js').recordEffectCheckpoint(f,x.c,{attemptId,operationId:'proof-op',stage:'S01',sequence:cp.sequence,stateHash:stateHash(s)});
  await fs.unlink(x.primary);let hits=0;const faulty=Object.create(f);faulty.remove=async(p,options)=>{if(p===x.marker&&hits++===0)throw ioError('EIO');return f.remove(p,options);};
  const first=await engine([stage('S01')],{fsAdapter:faulty}).run('recover',{configPath:x.configPath});assert.equal(first.exitCode,8);assert.equal(JSON.parse(await fs.readFile(x.marker,'utf8')).recovery_commit.phase,'primary_restored');
  await fs.writeFile(x.primary+'.corrupt-unknown',JSON.stringify({...s,in_flight_operation:pending('unknown-quarantined')}));const before=await evidenceSnapshot(x);
  const r=await engine([stage('S01')]).run('recover',{configPath:x.configPath});const after=await evidenceSnapshot(x);
  return {proof_source:'synthetic writer API sequence',fault_hits:hits,first:brief(first),retry:brief(r),marker_preserved:before['recovery-required.json']===after['recovery-required.json'],evidence_preserved:JSON.stringify(before)===JSON.stringify(after)};
 });
 emit('META',{node:process.version,repo,temporary_root:root,real_commands:0,note:'harness_ok means scenario executed; compare outcomes, not a product PASS'});
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(()=>{clearInterval(reviewKeepAlive);clearTimeout(reviewDeadline);});
