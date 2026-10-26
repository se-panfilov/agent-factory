'use strict';
// Fixture-format adapter only. No commits/push/branches/worktree/index/PR/release/deploy.
// Production engine/schema/adapters are never replaced. Fake producers get an explicit closed fixture action.
const path=require('node:path');
module.exports=function(repo){
 const from=n=>require(path.join(path.resolve(repo),'setup/dist/src',n+'.js'));
 const {decodePlan,encodePlan}=from('core/plan-format'),config=from('core/config'),validators=from('core/validators');
 const native=p=>p&&typeof p==='object'&&Array.isArray(p.stage_scope)&&Array.isArray(p.operations)&&typeof p.generated_at==='string';
 const view=p=>p&&typeof p==='object'&&p.native&&Array.isArray(p.stages);
 return {
  parse:(text,reviver)=>{const p=JSON.parse(text,typeof reviver==='function'?reviver:undefined);return native(p)?decodePlan(p):p;},
  stringify:(p,...args)=>JSON.stringify(view(p)?encodePlan(p):p,...args),
  canonical:p=>{
   if(view(p)){const out=encodePlan(p);if(!Object.hasOwn(p,'plan_hash'))delete out.plan_hash;return config.stableStringify(out);}
   return config.stableStringify(p);
  },
  validate:(name,p)=>validators.validateContractSchema(name,name==='plan'&&view(p)?encodePlan(p):p),
  registry:stages=>from('core/plan').createRegistry(stages.map(stage=>{
   const producer=stage.plan.bind(stage);
   return {...stage,plan:(desired,observed)=>{const p=producer(desired,observed);return {...p,operations:p.operations.map(op=>op.action?op:{...op,action:'fixture.counter'})};}};
  })),
  prepare:async(c,filename)=>{
   await require(path.join(path.resolve(repo),'setup/dist/tests/helpers/r22-context.js')).fixtureContextFiles(c,c.selected_stages.some(id=>['S05','S06','S07','S09','S10','S11','S13'].includes(id)));
   if(filename)await require('node:fs/promises').writeFile(filename,JSON.stringify(c));
  }
 };
};
