// C13 fixture/input adapter. Original counters/oracles preserved; see adapter-map.md.
const __c13=require('../c13-fixture-compat.cjs')(process.argv[2]);
'use strict';
// Reviewer-only probes: actual engine + real S02 producer with fake APT effects,
// plus an explicitly synthetic no-gate stage for plan-age checks. No real commands.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const repo = path.resolve(process.argv[2]);
const { r14Fixture, r14Noop, r14Process } = require(path.join(repo, 'setup/dist/tests/helpers/r14-engine.js'));
const { SetupEngine } = require(path.join(repo, 'setup/dist/src/core/engine.js'));
const { createRegistry } = require(path.join(repo, 'setup/dist/src/core/plan.js'));
const { createSystemStage } = require(path.join(repo, 'setup/dist/src/stages/system.js'));
const { stableStringify } = require(path.join(repo, 'setup/dist/src/core/config.js'));
const { validateContractSchema } = require(path.join(repo, 'setup/dist/src/core/validators.js'));
const results = [];
function rehash(plan) {
  const { plan_hash, ...payload } = plan;
  plan.plan_hash = crypto.createHash('sha256').update(__c13.canonical(payload)).digest('hex');
}
async function gateCase(id, kind) {
  const x = await r14Fixture('S02');
  const counts = {refresh:0, simulate:0, install:0};
  let metadataFresh = false, installed = false;
  const apt = {
    observe: async names => ({metadataFresh, metadataUpdatedAt:metadataFresh?'2026-10-25T10:00:00Z':null,
      sudoAvailable:true,dpkgAuditClean:true,dpkgAuditOutput:'',rebootRequired:false,
      packages:names.map(name=>({name,candidateVersion:'1.0.0',installedVersion:installed?'1.0.0':null}))}),
    refreshMetadata: async()=>{counts.refresh++;metadataFresh=true;},
    simulateInstall: async()=>{counts.simulate++;},
    installPinned: async()=>{counts.install++;installed=true;}
  };
  const clock={now:()=>new Date('2026-10-25T10:00:00Z')};
  const engine = new SetupEngine({fsAdapter:x.f,processAdapter:r14Process,clock},
    __c13.registry([r14Noop('S01'),createSystemStage(apt)]));
  const planned = await engine.run('plan',{configPath:x.configPath});
  assert.equal(planned.exitCode,0,__c13.stringify(planned));
  const plan=__c13.parse(await fs.readFile(x.applyOptions.planPath,'utf8'));
  const initialHash=plan.plan_hash;
  const originalGates=plan.stages.flatMap(s=>s.required_gates);
  let approved=0;
  if(kind==='approved') for(const gateId of new Set(originalGates)) {
    const a=await engine.run('gate-approve',{configPath:x.configPath,gateId,planHash:plan.plan_hash});
    assert.equal(a.exitCode,0,__c13.stringify(a));approved++;
  }
  if(['strip','one-sided','bad-hash'].includes(kind)) {
    for(const s of plan.stages) {
      s.required_gates=[];
      if(kind!=='one-sided')for(const op of s.operations)op.gate_ids=[];
    }
    if(kind!=='bad-hash')rehash(plan);
    await fs.writeFile(x.applyOptions.planPath,__c13.stringify(plan));
  }
  const schema=__c13.validate('plan',plan);assert.equal(schema.ok,true);
  const applied=await engine.run('apply',{...x.applyOptions,nonInteractive:true});
  const state=await x.state();
  const allZero=Object.values(counts).every(n=>n===0);
  const expectedSafe=kind==='approved'?applied.exitCode===0&&counts.install===1:applied.exitCode!==0&&allZero;
  const row={id,fixture:'actual SetupEngine + createSystemStage; APT adapter fake only',harness_ok:true,
    schema_valid:true,original_gate_ids:originalGates,approvals:approved,hash_changed:plan.plan_hash!==initialHash,
    gate_ids_in_submitted_plan:plan.stages.flatMap(s=>[...s.required_gates,...s.operations.flatMap(o=>o.gate_ids)]),
    exit:applied.exitCode,error:applied.envelope.error?.code??null,counts,
    s02_status:state.stages.find(s=>s.id==='S02')?.status,acceptance:expectedSafe,real_privileged_or_network_commands:0};
  results.push(row);console.log(__c13.stringify(row));
}
async function ageCase(id,deltaMinutes) {
  const x=await r14Fixture('S02');let effects=0;
  const start=Date.parse('2026-10-25T10:00:00Z');let now=start;
  const clock={now:()=>new Date(now)};
  const stage={id:'S02',dependencies:['S01'],supportedProfiles:['supervised'],optional:false,requiredCapabilities:[],
    observe:async()=>({stageId:'S02',status:effects?'verified':'planned',checks:{},versions:{},observedAt:clock.now().toISOString()}),
    plan:()=>({stageId:'S02',optional:false,requiredCapabilities:[],requiredGates:[],operations:[{id:'r2-age-effect',stageId:'S02',kind:'mutate',resourceId:'synthetic-owned-resource',risk:'low',gateIds:[],preconditions:[],sideEffects:['in-memory counter only'],timeoutSec:1,retryable:false}]}),
    apply:async(_ctx,p)=>{effects++;return [{operationId:p.operations[0].id,stageId:'S02',resourceId:p.operations[0].resourceId,observedAt:clock.now().toISOString(),checks:{done:true},versions:{},artifacts:[]}];},
    verifyOperation:async()=>{assert.ok(effects>0);},verify:async()=>[],recover:async()=>[]};
  const engine=new SetupEngine({fsAdapter:x.f,processAdapter:r14Process,clock},__c13.registry([r14Noop('S01'),stage]));
  assert.equal((await engine.run('plan',{configPath:x.configPath})).exitCode,0);
  const plan=__c13.parse(await fs.readFile(x.applyOptions.planPath,'utf8'));
  now+=deltaMinutes*60_000;
  const applied=await engine.run('apply',{...x.applyOptions,nonInteractive:true});
  const valid=deltaMinutes>=0&&deltaMinutes<30;
  const row={id,fixture:'actual engine; synthetic gate-free low-risk stage and injected clock',harness_ok:true,
    created_at:plan.created_at,apply_now:clock.now().toISOString(),age_minutes:deltaMinutes,
    serialized_plan_fields:Object.keys(plan),exit:applied.exitCode,error:applied.envelope.error?.code??null,effects,
    acceptance:valid?applied.exitCode===0&&effects===1:applied.exitCode!==0&&effects===0,real_privileged_or_network_commands:0};
  results.push(row);console.log(__c13.stringify(row));
}
(async()=>{
  await gateCase('R2A01_valid_approved','approved');
  await gateCase('R2A02_unapproved_control','unapproved');
  await gateCase('R2A03_remove_all_gates_rehash','strip');
  await gateCase('R2A04_one_sided_strip_control','one-sided');
  await gateCase('R2A05_bad_hash_control','bad-hash');
  await ageCase('R2A06_fresh_gate_free_control',5);
  await ageCase('R2A07_expired_gate_free_plan',31);
  await ageCase('R2A08_future_created_plan',-60);
  console.log(__c13.stringify({id:'META',repo,cases:results.length,safe:results.filter(r=>r.acceptance).length,
    note:'Observed product failures identify next R2 work; they are not regressions introduced by R1.6. No sudo/apt/daemon/network commands ran.'}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
