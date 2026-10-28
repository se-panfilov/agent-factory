'use strict';
// No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy. Local owned fixtures only.
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const repo=path.resolve(process.argv[2]);
const load=n=>require(path.join(repo,'setup/dist',n+'.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(file){const end=performance.now()+8000;while(performance.now()<end){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}throw Error('readiness barrier not reached');}
async function child(mode,signal,barrier){
 const {counterFixture}=load('tests/helpers/r21-admission');const {NodeProcessAdapter}=load('src/adapters/process');
 const {runCliEngine}=load('src/cli');const {setupError}=load('src/core/errors');
 const q=await counterFixture(2), e=q.make(), original=q.stage.apply;
 await q.x.planAndApprove(e);
 const announce=()=>fs.writeFile(barrier,JSON.stringify({root:q.x.root,configPath:q.x.configPath}));
 const aborted=ctx=>ctx.cancellationSignal.aborted?Promise.resolve():new Promise(r=>ctx.cancellationSignal.addEventListener('abort',r,{once:true}));
 let supervised;
 if(mode==='pre')q.stage.admitOperation=async ctx=>{await announce();await aborted(ctx);};
 if(mode==='prefix')q.stage.apply=async(ctx,p)=>{const receipts=await original(ctx,p);if(p.operations[0].id==='owned-0'){await announce();await aborted(ctx);}return receipts;};
 if(mode==='disk')q.stage.apply=async()=>{
   const target=path.join(q.x.root,'target-ready');
   const running=new NodeProcessAdapter().runCommand({policy:'interruptible',binary:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(target)},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),6000);`],timeoutMs:7000,maxOutputBytes:1024});
   await ready(target);await announce();supervised=await running;
   throw setupError({exitCode:8,code:'fixture_resource_unknown',publicMessage:'Interrupted fixture has no receipt',nextAction:'Preserve and manually reconcile.'});
 };
 const watchdog=setTimeout(()=>{console.error('OWNED_HARNESS_WATCHDOG');process.exitCode=70;},15000);
 const result=await runCliEngine(e,'apply',q.x.applyOptions);clearTimeout(watchdog);
 const {readStateCommitManifest}=load('src/core/state');
 const before=await readStateCommitManifest(q.x.f,q.x.config), afterCounts=[...q.counts];
 let resume=null, identical=null;
 if(mode==='prefix'){resume=await q.make().run('resume',{configPath:q.x.configPath});const after=await readStateCommitManifest(q.x.f,q.x.config);const b=before.completed_operations.find(x=>x.receipt.operationId==='owned-0'),a=after.completed_operations.find(x=>x.receipt.operationId==='owned-0');identical=JSON.stringify(a)===JSON.stringify(b);}
 if(mode==='disk')resume=await q.make().run('resume',{configPath:q.x.configPath});
 result.envelope.data={...result.envelope.data,q1b:{mode,signal,actual_uid:process.getuid(),injected_uid:1000,counts:afterCounts,after_resume:[...q.counts],checkpoint_identical:identical,resume_exit:resume?.exitCode??null,in_flight:!!(await q.x.state()).in_flight_operation,supervised}};
 process.stdout.write(JSON.stringify(result.envelope)+'\n');process.exitCode=result.exitCode;
}
async function capture(args){return new Promise((resolve,reject)=>{const c=spawn(process.execPath,[__filename,repo,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.on('error',reject);c.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});}
async function collect(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'q1b-cli-'));const rows=[];
 for(const [mode,signal]of [['pre','SIGINT'],['pre','SIGTERM'],['prefix','SIGINT'],['prefix','SIGTERM'],['disk','cancel']]){
  const barrier=path.join(root,mode+'-'+signal);const started=performance.now();
  const c=spawn(process.execPath,[__filename,repo,'--child',mode,signal,barrier],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const done=new Promise((resolve,reject)=>{c.on('error',reject);c.on('close',(code,signal)=>resolve({code,signal}));});
  c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);
  const watchdog=setTimeout(()=>{console.error('COLLECTOR_WATCHDOG');c.kill('SIGKILL');},25000);
  const context=await ready(barrier);let producer=null;
  if(mode==='disk'){producer=await capture(['--cancel',context.configPath]);assert.equal(producer.code,0,producer.stderr);}
  else {assert.equal(c.kill(signal),true);assert.equal(c.kill(signal),true);}
  const result=await done;clearTimeout(watchdog);const lines=stdout.trim().split('\n');assert.equal(lines.length,1);const envelope=JSON.parse(lines[0]),data=envelope.data.q1b;
  assert.equal(result.signal,null);assert.equal(result.code,mode==='disk'?8:signal==='SIGTERM'?143:130);
  assert.deepEqual(data.counts,mode==='prefix'?[1,0]:[0,0]);
  if(mode==='prefix'){assert.equal(data.resume_exit,0);assert.equal(data.checkpoint_identical,true);assert.deepEqual(data.after_resume,[1,1]);}
  if(mode==='disk'){assert.equal(data.supervised.cancelled,true);assert.equal(data.supervised.cleanup,'confirmed');assert.equal(data.in_flight,true);assert.equal(data.resume_exit,8);}
  const row={id:`CLI-${mode}-${signal}`,barrier:true,...result,duration_ms:performance.now()-started,envelope,stderr,producer};rows.push(row);console.log(JSON.stringify(row));
 }
 console.log(JSON.stringify({id:'META',cases:rows.length,actual_uid:process.getuid(),injected_uid:1000,node:process.version,platform:process.platform,real_privileged_commands:0,external_calls:0}));
 await fs.rm(root,{recursive:true});
}
(async()=>{if(process.argv[3]==='--child')await child(process.argv[4],process.argv[5],process.argv[6]);else if(process.argv[3]==='--cancel'){const {requestCancel}=load('src/core/lock'),{NodeFilesystemAdapter}=load('src/adapters/filesystem'),{r14Process}=load('tests/helpers/r14-engine');const config=JSON.parse(await fs.readFile(process.argv[4],'utf8'));await requestCancel(new NodeFilesystemAdapter(),config,r14Process);}else await collect();})().catch(e=>{console.error(e.stack);process.exitCode=1;});
