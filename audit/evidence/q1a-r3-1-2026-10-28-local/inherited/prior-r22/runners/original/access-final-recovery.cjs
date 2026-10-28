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
  const recovered=await accessEngine(x.root,x.config).run('recover',{configPath:x.configPath});assert.equal(recovered.exitCode,0,JSON.stringify(recovered));
  const repeated=await accessEngine(x.root,x.config).run('recover',{configPath:x.configPath});assert.equal(repeated.exitCode,0);
  const resumed=await accessEngine(x.root,x.config).run('resume',{configPath:x.configPath});assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
  const after=(await readFacts(x.root)).counts;assert.deepEqual(after,before);
  const manifest=JSON.parse(await fs.readFile(path.join(x.config.paths.setup_state_dir,'state-commit.json'),'utf8'));assert.ok(manifest.last_effect_checkpoint);
  assert.equal((await x.state()).stages.find(s=>s.id==='S03').status,'verified');
  console.log(JSON.stringify({mode,apply:applied.exitCode,marker,recover:recovered.exitCode,repeat:repeated.exitCode,resume:resumed.exitCode,before,after,checkpoint_retained:!!manifest.last_effect_checkpoint,acceptance:true}));
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
