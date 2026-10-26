'use strict';
// Independent final-admission read barrier. Hashing and engine are real; release effects are fake.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);const req=p=>require(path.join(root,'setup/dist',p));
const {r14Fixture,r14Noop,r14Process,r14Clock}=req('tests/helpers/r14-engine.js');
const {FakeApplicationAdapter,makeCheckout,makeRelease}=req('tests/helpers/r15-application.js');
const {SetupEngine}=req('src/core/engine.js');const {createRegistry}=req('src/core/plan.js');
const {createApplicationStage}=req('src/stages/application.js');const {evidence}=req('tests/helpers/r21-admission.js');
let complete=false;process.on('beforeExit',()=>{if(!complete){console.error('INCOMPLETE');process.exitCode=70;}});
async function run(kind,fault){
 const x=await r14Fixture('S05'),adapter=new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config));
 const stages=()=>[r14Noop('S04'),createApplicationStage(adapter)];await x.planAndApprove(x.engine(stages()));
 let hashes=0,hits=0,stack=null;const before=await evidence(x.config);
 const f=new Proxy(x.f,{get(target,key){
  if(key==='hashFile')return async(...args)=>{
   hashes++;const result=await target.hashFile(...args);
   // The fifth archive read is the final capturePlanContext before the first effect.
   // Capture the production call stack as evidence; never alter hash results or engine code.
   if(hashes===5){hits++;stack=new Error('final context read barrier').stack;
    if(fault){if(kind==='lock'){const lock=JSON.parse(await fs.readFile(x.config.version_lock_path,'utf8'));lock.docker.ce+='.review-swap';await fs.writeFile(x.config.version_lock_path,JSON.stringify(lock));}
    else await fs.appendFile(kind==='config'?x.configPath:x.applyOptions.planPath,'\n');}
   }return result;
  };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }});
 const result=await new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry(stages())).run('apply',x.applyOptions);
 const after=await evidence(x.config),s=await x.state();
 const events=await fs.readFile(path.join(x.config.paths.setup_state_dir,'events.jsonl'),'utf8').then(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse),e=>{if(e.code==='ENOENT')return [];throw e;});
 const row={id:`release-final-hash-${kind}-${fault?'fault':'control'}`,fault,hits,hashes,stack,result:{exit:result.exitCode,code:result.envelope.error?.code??null},extracts:adapter.extractCalls,probes:adapter.probeCalls,inflight:s.in_flight_operation,before,after,journal:events.map(e=>({code:e.code,operation:e.operation_id}))};
 assert.equal(hits,1);row.expected_safe=fault?result.exitCode!==0&&adapter.extractCalls===0:result.exitCode===0&&adapter.extractCalls===1;console.log(JSON.stringify(row));return row;
}
(async()=>{const rows=[];await run('lock',false).then(x=>rows.push(x));for(const kind of ['lock','config','plan'])rows.push(await run(kind,true));complete=true;console.log(JSON.stringify({id:'META',cases:rows.length,passed:rows.filter(x=>x.expected_safe).length,real_commands:0,node:process.version,source:root}));})().catch(e=>{complete=true;console.error(e.stack);process.exitCode=1;});
