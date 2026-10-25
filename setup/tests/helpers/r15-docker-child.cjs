'use strict';
const path=require('node:path'),fs=require('node:fs/promises');
const dist=process.argv[2],phase=process.argv[3];
const {r14Fixture,r14Noop,r14Clock,r14Process}=require(path.join(dist,'tests/helpers/r14-engine.js'));
const {SessionDockerAdapter,baseObservation}=require(path.join(dist,'tests/helpers/r15-docker.js'));
const {SetupEngine}=require(path.join(dist,'src/core/engine.js'));
const {createRegistry}=require(path.join(dist,'src/core/plan.js'));
const {createDockerStage}=require(path.join(dist,'src/stages/docker.js'));
const {stateHash}=require(path.join(dist,'src/core/state.js'));
(async()=>{
 const x=await r14Fixture('S04'),o=baseObservation();o.dockerGroup={exists:false,accountUserInGroup:false,currentUserInGroup:false};o.dockerSocket.exists=false;
 const a=new SessionDockerAdapter(o);a.changeGroupMembership=true;let hit=false;
 async function barrier(exactPath){if(hit)return;hit=true;process.send({type:'barrier',phase,path:exactPath,config:x.config,configPath:x.configPath,observation:a.observation,counts:{install:a.installCalls,group:a.groupCalls,restart:a.restartCalls,probe:a.probeCalls}});await new Promise(resolve=>process.once('message',resolve));}
 const group=a.ensureDockerGroupMembership.bind(a);a.ensureDockerGroupMembership=async ctx=>{const result=await group(ctx);if(phase==='effect')await barrier('adapter:group-account-updated-before-receipt');return result;};
 const f=new Proxy(x.f,{get(t,key,receiver){
  if(key==='fsyncDir')return async p=>{await t.fsyncDir(p);if(hit||p!==x.config.paths.setup_state_dir||phase==='effect')return;
   try{const m=JSON.parse(await fs.readFile(path.join(p,'state-commit.json'),'utf8'));if(!m.last_effect_checkpoint?.operation_id.includes('docker-group-membership'))return;
    const s=JSON.parse(await fs.readFile(path.join(p,'state.json'),'utf8'));if(m.last_state_hash!==stateHash(s))return;
    const status=s.stages.find(s=>s.id==='S04').status;if((phase==='bound'&&status==='applying')||(phase==='pause'&&status==='awaiting_manual'))await barrier(path.join(p,'state-commit.json'));}
   catch(error){if(error.code!=='ENOENT')throw error;}
  };
  const value=Reflect.get(t,key,receiver);return typeof value==='function'?value.bind(t):value;
 }});
 const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry([r14Noop('S03'),createDockerStage(a)]));
 await x.planAndApprove(e);await e.run('apply',x.applyOptions);if(!hit)throw Error('Requested engine barrier was not reached');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
