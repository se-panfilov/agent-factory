'use strict';
// Local fake-adapter writer. All barriers are reached through SetupEngine.
const fs = require('node:fs/promises');
const path = require('node:path');
const dist = process.argv[2], phase = process.argv[3];
const { r14Fixture, r14Noop, r14Clock, r14Process } = require(path.join(dist, 'tests/helpers/r14-engine.js'));
const { SetupEngine } = require(path.join(dist, 'src/core/engine.js'));
const { createRegistry } = require(path.join(dist, 'src/core/plan.js'));
const { createSystemStage } = require(path.join(dist, 'src/stages/system.js'));
const { NodeFilesystemAdapter } = require(path.join(dist, 'src/adapters/filesystem.js'));
(async () => {
 const x = await r14Fixture('S02');
 const delegate = new NodeFilesystemAdapter();
 let enabled = false, barrierHit = false, refreshed = false, installed = false, finalWrite = false, manifestBody;
 const trace = [];
 const effectsFile = path.join(x.root, 'effects.json');
 async function record(effect) { trace.push(effect); await fs.writeFile(effectsFile, JSON.stringify(trace)); }
 async function barrier(name, exactPath) {
  if (!enabled || barrierHit || name !== phase) return;
  barrierHit = true;
  process.send({ type: 'barrier', phase: name, path: exactPath, configPath: x.configPath, config: x.config, effectsFile });
  await new Promise(resolve => process.once('message', resolve));
 }
 const proxy = new Proxy(delegate, {get(target, key) {
  if (key === 'writeText') return async(p, body, mode) => {
   if (p.includes('state-commit.json.tmp-')) manifestBody = JSON.parse(body);
   if (p.includes('state.json.tmp-')) { const state = JSON.parse(body); finalWrite = state.stages.some(s => s.id === 'S02' && s.status === 'verified'); }
   return target.writeText(p, body, mode);
  };
  if (key === 'fsyncFile') return async p => {
   await target.fsyncFile(p);
   if (p.endsWith('events.jsonl')) {
    const records = (await fs.readFile(p, 'utf8')).trim().split('\n').map(JSON.parse);
    if (records.at(-1).code === 'checkpoint') await barrier('checkpoint-before-binding', p);
   }
  };
  if (key === 'rename') return async(a,b) => {
   await target.rename(a,b);
   if (b.endsWith('state-commit.json')) {
    if (manifestBody?.completed_operations?.length === 1) await barrier('between-operations', b);
    if (manifestBody?.clean_proof) await barrier('final-manifest', b);
   }
   if (b.endsWith('state.json') && finalWrite) await barrier('final-primary', b);
   if (b.endsWith('recovery-required.json')) {
    const marker = JSON.parse(await fs.readFile(b, 'utf8'));
    if (marker.recovery_commit?.phase === 'prepared') await barrier('recovery-prepared', b);
    if (marker.recovery_commit?.phase === 'primary_restored') await barrier('recovery-restored', b);
   }
  };
  if (key === 'remove') return async(p, opts) => {
   if (p.endsWith('recovery-required.json')) await barrier('cleanup-before-remove', p);
   await target.remove(p,opts);
   if (p.endsWith('recovery-required.json')) await barrier('cleanup-after-remove', p);
  };
  const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
 }});
 const apt = {
  observe: async names => ({metadataFresh: refreshed, metadataUpdatedAt: r14Clock.now().toISOString(), sudoAvailable:true, dpkgAuditClean:true, dpkgAuditOutput:'', rebootRequired:false,
   packages:names.map(name => ({name, installedVersion:installed?'1.0':null, candidateVersion:'1.0'}))}),
  refreshMetadata: async()=> { await record('refresh'); refreshed = true; },
  simulateInstall: async()=> { await record('simulate'); },
  installPinned: async()=> { await barrier('before-install', effectsFile); await record('install'); installed = true; await barrier('install-after-effect', effectsFile); }
 };
 const engine = new SetupEngine({fsAdapter:proxy,processAdapter:r14Process,clock:r14Clock},createRegistry([r14Noop('S01'),createSystemStage(apt)]));
 await x.planAndApprove(engine);
 enabled = !phase.startsWith('recovery-') && !phase.startsWith('cleanup-');
 const applied = await engine.run('apply',x.applyOptions);
 if(applied.exitCode !== 0) throw Error(JSON.stringify(applied));
 if(!enabled) {
  const planned = await engine.run('plan',{configPath:x.configPath}); if(planned.exitCode!==0)throw Error(JSON.stringify(planned));
  await fs.unlink(path.join(x.config.paths.setup_state_dir,'state.json'));
  enabled=true;
  const recovered=await engine.run('recover',{configPath:x.configPath}); if(recovered.exitCode!==0)throw Error(JSON.stringify(recovered));
 }
 if(!barrierHit)throw Error('Requested barrier not reached: '+phase);
 process.send({type:'completed'});
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
