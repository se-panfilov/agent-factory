'use strict';
// An owned process uses the real engine/S02 producer. Every APT effect changes only this test's JSON.
const path = require('node:path'), fs = require('node:fs/promises');
const dist = process.argv[2], configPath = process.argv[3], factsPath = process.argv[4], mode = process.argv[5];
const from = n => require(path.join(dist,'src',n+'.js'));
const {r14Noop,r14Process} = require(path.join(dist,'tests/helpers/r14-engine.js'));
(async()=>{
 const {NodeFilesystemAdapter} = from('adapters/filesystem'), {SetupEngine} = from('core/engine'),{createRegistry}=from('core/plan'),{createSystemStage}=from('stages/system');
 const load=async()=>JSON.parse(await fs.readFile(factsPath,'utf8'));
 async function effect(name){const f=await load();f.counts[name]++;if(name==='refresh')f.fresh=true;if(name==='install')f.installed=true;await fs.writeFile(factsPath,JSON.stringify(f));}
 const apt={observe:async names=>{const f=await load();return {metadataFresh:f.fresh,metadataUpdatedAt:f.fresh?'2026-10-25T10:00:00Z':null,sudoAvailable:true,dpkgAuditClean:true,dpkgAuditOutput:'',rebootRequired:false,packages:names.map(name=>({name,candidateVersion:'1.0.0',installedVersion:f.installed?'1.0.0':null}))};},refreshMetadata:()=>effect('refresh'),simulateInstall:()=>effect('simulate'),installPinned:()=>effect('install')};
 const e=new SetupEngine({fsAdapter:new NodeFilesystemAdapter(),processAdapter:r14Process,clock:{now:()=>new Date('2026-10-25T10:00:00.000Z')}},createRegistry([r14Noop('S01'),createSystemStage(apt)]));
 const config=JSON.parse(await fs.readFile(configPath,'utf8')),planPath=path.join(config.paths.setup_state_dir,'plan.json');let result;
 if(mode==='approve'){
  const p=JSON.parse(await fs.readFile(planPath,'utf8'));const gates=[...new Set(p.stages.flatMap(s=>s.required_gates))];
  for(const gateId of gates){result=await e.run('gate-approve',{configPath,gateId,planHash:p.plan_hash});if(result.exitCode!==0)throw Error(JSON.stringify(result));}
  result={exitCode:0,gates};
 }else result=await e.run(mode,{configPath,...(mode==='apply'?{planPath,nonInteractive:true}:{})});
 process.stdout.write(JSON.stringify({mode,pid:process.pid,result,facts:await load()}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
