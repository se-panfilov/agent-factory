'use strict';
// Independent review probes. Real SetupEngine/S02 and filesystem, injected APT/host identity.
// No host command, repository mutation, credential, network or privileged effect.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const req = p => require(path.join(root,'setup/dist',p));
const {aptFixture,evidence}=req('tests/helpers/r21-admission.js');
const {r14Noop,r14Process}=req('tests/helpers/r14-engine.js');
const {SetupEngine}=req('src/core/engine.js');
const {createRegistry}=req('src/core/plan.js');
const {createSystemStage}=req('src/stages/system.js');
const results=[];let complete=false;
process.on('beforeExit',()=>{if(!complete){console.error('INCOMPLETE: main promise did not settle');process.exitCode=70;}});
const sha = p => fs.readFile(p).then(b=>crypto.createHash('sha256').update(b).digest('hex'));
const brief = r => ({exit:r.exitCode,code:r.envelope.error?.code??null});
async function mutate(q,kind){
  if(kind==='lock'){
    const lock=JSON.parse(await fs.readFile(q.x.config.version_lock_path,'utf8'));
    lock.docker.ce += '.review-swap';
    await fs.writeFile(q.x.config.version_lock_path,JSON.stringify(lock));
  }else await fs.appendFile(kind==='config'?q.x.configPath:q.x.applyOptions.planPath,'\n');
}
async function approval(kind,fault){
  const q=await aptFixture();const e=q.make();
  const planned=await e.run('plan',{configPath:q.x.configPath});assert.equal(planned.exitCode,0);
  const p=JSON.parse(await fs.readFile(q.x.applyOptions.planPath,'utf8'));
  const before=await evidence(q.x.config),beforeLock=await sha(q.x.config.version_lock_path);
  const original=q.apt.observe;let hits=0;
  q.apt.observe=async (...a)=>{const o=await original(...a);if(!hits){hits++;if(fault)await mutate(q,kind);}return o;};
  const approved=await e.run('gate-approve',{configPath:q.x.configPath,gateId:'s02-sudo-apt-update',planHash:p.plan_hash});
  const after=await evidence(q.x.config),s=await q.x.state();
  const gate=s.pending_gates.find(g=>g.id==='s02-sudo-apt-update');
  const row={id:`gate-after-probe-${kind}-${fault?'fault':'control'}`,fault,hits,result:brief(approved),gate,counts:q.counts,evidence_unchanged:JSON.stringify(before)===JSON.stringify(after),beforeLock,afterLock:await sha(q.x.config.version_lock_path),before,after};
  assert.equal(hits,1);assert.equal(q.counts.refresh,0);assert.equal(q.counts.install,0);
  row.expected_safe = fault ? approved.exitCode!==0 && row.evidence_unchanged : approved.exitCode===0;
  console.log(JSON.stringify(row));results.push(row);
}
async function effect(kind,fault){
  const q=await aptFixture();await q.x.planAndApprove(q.make());
  const before=await evidence(q.x.config),original=q.apt.observe;
  let policyReads=0,armed=false,hits=0;
  q.apt.observe=async (...a)=>{
    if(new Error().stack.includes('admitPlanPolicies')){policyReads++;if(policyReads===2)armed=true;}
    return original(...a);
  };
  const f=new Proxy(q.x.f,{get(target,key){
    if(key==='readTextBounded')return async (p,limit)=>{
      const result=await target.readTextBounded(p,limit);
      if(armed&&hits===0&&p===q.x.config.version_lock_path){hits++;if(fault)await mutate(q,kind);}
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop('S01'),createSystemStage(q.apt)]));
  const applied=await e.run('apply',q.x.applyOptions);const after=await evidence(q.x.config);const s=await q.x.state();
  const journal=await fs.readFile(path.join(q.x.config.paths.setup_state_dir,'events.jsonl'),'utf8').then(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse),e=>{if(e.code==='ENOENT')return [];throw e;});
  const row={id:`effect-during-final-context-${kind}-${fault?'fault':'control'}`,fault,hits,policyReads,result:brief(applied),counts:q.counts,inflight:s.in_flight_operation,journal:journal.map(x=>({code:x.code,operation:x.operation_id,attempt:x.attempt_id})),before,after};
  assert.equal(hits,1);
  row.expected_safe=fault ? applied.exitCode!==0&&q.counts.refresh===0&&q.counts.simulate===0&&q.counts.install===0 : applied.exitCode===0&&q.counts.refresh===1&&q.counts.simulate===1&&q.counts.install===1;
  console.log(JSON.stringify(row));results.push(row);
}
(async()=>{
  for(const kind of ['lock','config','plan']){await approval(kind,false);await approval(kind,true);}
  for(const kind of ['config','plan']){await effect(kind,false);await effect(kind,true);}
  complete=true;
  console.log(JSON.stringify({id:'META',cases:results.length,passed:results.filter(r=>r.expected_safe).length,refused_as_required:results.filter(r=>r.fault&&r.expected_safe).length,real_commands:0,source:root,node:process.version}));
})().catch(e=>{complete=true;console.error(e.stack);process.exitCode=1;});
