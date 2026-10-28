'use strict';
// R3 mapped barriers. No commits/push/branches/worktree/PR/index/merge/tag/release/deploy; local only.
// Actual engine/lock/cancel/emergency implementation, owned temp files, fake external effects.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const repo=path.resolve(process.argv[2]),req=p=>require(path.join(repo,'setup/dist',p));
const {aptFixture,evidence}=req('tests/helpers/r21-admission.js');
const {r14Noop,r14Process}=req('tests/helpers/r14-engine.js');
const {SetupEngine}=req('src/core/engine.js'),{createRegistry}=req('src/core/plan.js'),{createSystemStage}=req('src/stages/system.js');
const {acquireLock,requestCancel,consumeCancelRequest,recoverLockOnly}=req('src/core/lock.js');
const rows=[];let complete=false;
process.on('beforeExit',()=>{if(!complete){console.error('INCOMPLETE R3 baseline');process.exitCode=70;}});
const hash=p=>fs.readFile(p).then(b=>crypto.createHash('sha256').update(b).digest('hex'),e=>{if(e.code==='ENOENT')return null;throw e;});
const brief=r=>({exit:r.exitCode,code:r.envelope.error?.code??null});
const output=r=>{rows.push(r);console.log(JSON.stringify(r));};
const engine=(q,f=q.x.f,proc=r14Process)=>new SetupEngine({fsAdapter:f,processAdapter:proc,clock:q.clock},createRegistry([r14Noop('S01'),createSystemStage(q.apt)]));
const proxy=(f,overrides)=>new Proxy(f,{get(t,k){if(k in overrides)return overrides[k];const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
async function lockCase(kind){
 const q=await aptFixture();const held=await acquireLock(q.x.f,r14Process,q.x.config);
 const lock=path.join(q.x.config.paths.setup_state_dir,'lock'),ownerFile=path.join(lock,'owner.json');
 if(kind==='invalid-json')await fs.writeFile(ownerFile,'{');
 if(kind==='invalid-shape')await fs.writeFile(ownerFile,'{}');
 const proc={...r14Process,isPidAlive:()=>kind!=='known-dead',processStartTicks:async()=>kind==='unknown-start'?null:1};
 const before=await hash(ownerFile),stateBefore=await evidence(q.x.config);
 const result=await engine(q,q.x.f,proc).run('recover',{configPath:q.x.configPath,lockOnly:true});
 const after=await hash(ownerFile),stateAfter=await evidence(q.x.config);
 const expected=kind==='known-dead'?result.exitCode===0&&after===null:result.exitCode!==0&&before===after;
 output({id:'L-'+kind,result:brief(result),owner_before:before,owner_after:after,held_nonce:held.owner.nonce,data:result.envelope.data,state_evidence_unchanged:JSON.stringify(stateBefore)===JSON.stringify(stateAfter),desired_pass:expected});
}
async function recoverRace(){
 const q=await aptFixture();const old=await acquireLock(q.x.f,r14Process,q.x.config);
 const lock=path.join(q.x.config.paths.setup_state_dir,'lock'),ownerFile=path.join(lock,'owner.json');
 const dead={...r14Process,isPidAlive:()=>false};let hits=0,competing=null,acquireBlocked=null;
 const f=proxy(q.x.f,{rename:async(from,to)=>{
  if(from===lock&&hits===0){hits++;
   competing=await engine(q,q.x.f,dead).run('recover',{configPath:q.x.configPath,lockOnly:true});
   try{await acquireLock(q.x.f,r14Process,q.x.config);}catch(e){acquireBlocked=e.code;}
  }
  return q.x.f.rename(from,to);
 }});
 const first=await engine(q,f,dead).run('recover',{configPath:q.x.configPath,lockOnly:true});
 assert.equal(first.exitCode,0);assert.equal(competing.exitCode,7);assert.equal(acquireBlocked,'lock_protocol_busy');
 const fresh=await acquireLock(q.x.f,r14Process,q.x.config);let staleRelease=null;
 try{await old.release();}catch(e){staleRelease=e.code;}
 assert.equal(staleRelease,'lock_owner_changed');
 const current=JSON.parse(await fs.readFile(ownerFile,'utf8'));assert.equal(hits,1);
 output({id:'L-recovery-race',hits,result:brief(competing),first:brief(first),acquireBlocked,staleRelease,replacement_owner:fresh.owner,current_owner:current,desired_pass:competing.exitCode!==0&&current.nonce===fresh.owner.nonce});
}

async function cancelBoundary(kind){
 const q=await aptFixture();await q.x.planAndApprove(q.make());let hits=0,lockReads=0,beforeRequest=null,request=null;
 const lockDir=path.join(q.x.config.paths.setup_state_dir,'lock');
 const submit=async()=>{hits++;beforeRequest={...q.counts};await requestCancel(q.x.f,q.x.config);request=JSON.parse(await fs.readFile(path.join(q.x.config.paths.setup_state_dir,'cancel-request.json'),'utf8'));};
 const f=proxy(q.x.f,{
  fsyncDir:async p=>{await q.x.f.fsyncDir(p);if(kind==='early'&&p===q.x.config.paths.setup_state_dir&&hits===0&&!(await q.x.f.exists(path.join(p,'lock-protocol')))&&await q.x.f.exists(path.join(lockDir,'owner.json')))await submit();},
  readTextBounded:async(p,n)=>{const r=await q.x.f.readTextBounded(p,n);if(p===q.x.config.version_lock_path){lockReads++;if(kind==='late'&&hits===0&&new Error().stack?.includes('finalPlanAdmission'))await submit();}return r;}
 });
 const result=await engine(q,f).run('apply',q.x.applyOptions);
 if(kind!=='none'){assert.equal(hits,1);assert.deepEqual(beforeRequest,{refresh:0,simulate:0,install:0});}
 const s=await q.x.state();const events=await fs.readFile(path.join(q.x.config.paths.setup_state_dir,'events.jsonl'),'utf8').then(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse),e=>{if(e.code==='ENOENT')return [];throw e;});
 output({id:'C-'+kind,hits,lockReads,beforeRequest,request,result:brief(result),counts:q.counts,inflight:s.in_flight_operation,journal:events.filter(x=>x.stage==='S02').map(x=>({operation:x.operation_id,code:x.code})),desired_pass:kind==='none'?result.exitCode===0&&q.counts.install===1:result.exitCode===130&&Object.values(q.counts).every(n=>n===0)});
}
async function cancelAtomic(fault){
 const q=await aptFixture();const handle=await acquireLock(q.x.f,r14Process,q.x.config);const filename=await requestCancel(q.x.f,q.x.config),before=await hash(filename);let hits=0,error=null;
 const f=proxy(q.x.f,{writeText:async(p,body,mode)=>{if(p.endsWith('/payload')){hits++;if(fault){await q.x.f.writeText(p,'{"installation_id":',mode);throw Object.assign(Error('owned injected ENOSPC'),{code:'ENOSPC'});}}return q.x.f.writeText(p,body,mode);}});
 try{await requestCancel(f,q.x.config);}catch(e){error=e.code;}
 const after=await hash(filename);const consumed=await consumeCancelRequest(q.x.f,q.x.config,handle.owner);assert.equal(hits,1);
 output({id:'C-atomic-'+(fault?'fault':'control'),hits,error,before,after,consumed,desired_pass:consumed===true});
}
async function emergency(kind){
 const q=await aptFixture();await fs.mkdir(q.x.config.paths.application_dir,{recursive:true,mode:0o700});
 const commands=kind==='missing'?{}:{runner_stop:kind==='sudo'?['/usr/bin/sudo','-n','/usr/bin/true']:['/usr/bin/true']};
 await fs.writeFile(path.join(q.x.config.paths.application_dir,'deployment-manifest.json'),JSON.stringify({commands}));
 const calls=[];const proc={...r14Process,...(kind==='root'?{uid:()=>0,username:()=>'root'}:{}),runCommand:async command=>{calls.push(command);return{exitCode:0,stdout:'',stderr:'',timedOut:false};}};
 const result=await engine(q,q.x.f,proc).run('cancel',{configPath:q.x.configPath,emergency:true});
 const paused=await fs.access(path.join(q.x.config.paths.application_state_dir,'PAUSED')).then(()=>true,()=>false);
 output({id:'E-'+kind,result:brief(result),calls,paused,real_commands:0,desired_pass:result.exitCode!==0&&calls.length===0});
}
(async()=>{
 for(const k of ['active','known-dead','unknown-start','invalid-json','invalid-shape'])await lockCase(k);
 await recoverRace();for(const k of ['none','early','late'])await cancelBoundary(k);
 await cancelAtomic(false);await cancelAtomic(true);for(const k of ['missing','sudo','root'])await emergency(k);
 complete=true;console.log(JSON.stringify({id:'META',cases:rows.length,desired_pass:rows.filter(r=>r.desired_pass).length,source:repo,node:process.version,mapping:'R3 mutex/atomic-temp/v2-cancel',real_external_commands:0}));
})().catch(e=>{complete=true;console.error(e.stack);process.exitCode=1;});
