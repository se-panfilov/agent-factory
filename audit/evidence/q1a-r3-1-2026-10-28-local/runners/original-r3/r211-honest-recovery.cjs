'use strict';
// Actual S03 v2 final publication -> re-plan -> primary loss. Only owned fixture files are changed.
// No commits/push/branches/worktree/index/PR/release/deploy or real host effects.
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);
const {accessFixture,accessEngine,readFacts}=require(path.join(root,'setup/dist/tests/helpers/r211-access.js'));
(async()=>{
 for(const mode of ['direct','plan-first']){
  const x=await accessFixture();await x.planAndApprove(accessEngine(x.root,x.config));
  const applied=await accessEngine(x.root,x.config).run('apply',x.applyOptions);assert.equal(applied.exitCode,0);
  await x.planAndApprove(accessEngine(x.root,x.config));
  const before=(await readFacts(x.root)).counts;
  await fs.unlink(path.join(x.config.paths.setup_state_dir,'state.json'));
  let marker=null;
  if(mode==='plan-first'){
   const planned=await accessEngine(x.root,x.config).run('plan',{configPath:x.configPath});assert.equal(planned.exitCode,8);marker=planned.exitCode;
  }
  const recovered=await accessEngine(x.root,x.config).run('recover',{configPath:x.configPath});assert.equal(recovered.exitCode,8,JSON.stringify(recovered));assert.equal(recovered.envelope.error.code,'context_review_unproven');assert.equal(recovered.envelope.data.review_required,true);
  const repeated=await accessEngine(x.root,x.config).run('recover',{configPath:x.configPath});assert.equal(repeated.exitCode,8);assert.equal(repeated.envelope.error.code,'context_review_unproven');
  const resumed=await accessEngine(x.root,x.config).run('resume',{configPath:x.configPath});const desired_acceptance=resumed.exitCode===0;
  let reviewed=null;
  if(!desired_acceptance){await x.planAndApprove(accessEngine(x.root,x.config));reviewed=await accessEngine(x.root,x.config).run('resume',{configPath:x.configPath});assert.equal(reviewed.exitCode,0,JSON.stringify(reviewed));}
  const after=(await readFacts(x.root)).counts;assert.deepEqual(after,before);
  const manifest=JSON.parse(await fs.readFile(path.join(x.config.paths.setup_state_dir,'state-commit.json'),'utf8'));assert.ok(manifest.last_effect_checkpoint);
  assert.equal((await x.state()).stages.find(s=>s.id==='S03').status,'verified');
  console.log(JSON.stringify({mode,apply:applied.exitCode,marker,recover:recovered.exitCode,repeat:repeated.exitCode,resume:resumed.exitCode,resume_error:resumed.envelope.error?.code??null,explicit_review_resume:reviewed?.exitCode??null,before,after,checkpoint_retained:!!manifest.last_effect_checkpoint,desired_acceptance,recovery_error:recovered.envelope.error.code,review_required:recovered.envelope.data.review_required,resume_authorized:recovered.envelope.data.resume_authorized}));
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
