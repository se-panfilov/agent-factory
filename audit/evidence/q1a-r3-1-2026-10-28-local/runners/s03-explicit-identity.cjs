'use strict';
// Actual engine and S03. All host effects are counters and an in-memory observation.
// Cancellation uses the product requestCancel API; no state/evidence is forged.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const repo = path.resolve(process.argv[2]);
const from = p => require(path.join(repo, 'setup/dist', p + '.js'));
const { r14Fixture, r14Noop, r14Process } = from('tests/helpers/r14-engine');
const { SetupEngine } = from('src/core/engine');
const { createRegistry } = from('src/core/plan');
const { createAccessStage } = from('src/stages/access');
const { requestCancel } = from('src/core/lock');
const rows = [];
async function evidence(x) {
  const hashes = {};
  for (const name of ['state.json','state.json.previous','state-commit.json','events.jsonl','recovery-required.json']) {
    try { hashes[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(x.config.paths.setup_state_dir,name))).digest('hex'); }
    catch(e) { if(e.code !== 'ENOENT')throw e;hashes[name]=null; }
  }
  return hashes;
}
async function scenario(pause, continuation) {
  const x = await r14Fixture('S03');
  const clock = { now: () => new Date('2026-10-25T10:00:00.000Z') };
  const calls = { install:0, stage:0, arm:0, cutover:0, tailnet:0, disarm:0, rollback:0 };
  const observation = {
    securityInputs:{contentHash:'synthetic-config-content',ownershipHash:'synthetic-root-owner-modes'},
    tailscale:{installedVersion:null,candidateVersion:'1.84.0',loginState:'connected',privateSshReachable:true},
    ssh:{port:22,hasMatchBlocks:false,users:['factory'],configHash:'ssh-config-hash'},
    firewall:{manager:'ufw',enabled:true,defaultIncomingPolicy:'deny',ipv6Enabled:true,rulesHash:'ufw-rules-hash'},
    publicExposure:{ipv4SshReachable:true,ipv6SshReachable:true},
    manual:{providerConsoleConfirmed:true,secondSessionValidated:true,secondSessionHasSudo:true,tailscaleLoginConfirmed:true,cutoverAckConfirmed:true},
    rollback:{timerTemplatePresent:true,serviceTemplatePresent:true,armed:false},
    diff:{sshd:'reviewed managed drop-in',firewall:'reviewed private SSH only'}
  };
  let cancelled = false;
  async function effect(name, action) {
    calls[name]++; action?.();
    if (name === pause && !cancelled) { cancelled = true; await requestCancel(x.f, x.config, r14Process); }
  }
  const adapter = {
    observe:async()=>structuredClone(observation),
    installPinnedTailscale:async v=>effect('install',()=>observation.tailscale.installedVersion=v),
    stageManagedCutover:async()=>effect('stage'),validateSshdCandidate:async()=>{},
    armRollbackTimer:async()=>effect('arm',()=>observation.rollback.armed=true),
    applyCutover:async()=>effect('cutover',()=>{observation.publicExposure.ipv4SshReachable=false;observation.publicExposure.ipv6SshReachable=false;}),
    verifyPrivateTailnetAccess:async()=>{await effect('tailnet');return true;},
    disarmRollbackTimer:async()=>effect('disarm',()=>observation.rollback.armed=false),
    rollbackManagedCutover:async()=>{await effect('rollback',()=>observation.rollback.armed=false);return {ok:true,details:'fake rollback'};}
  };
  const make=()=>new SetupEngine({fsAdapter:x.f,processAdapter:r14Process,clock},createRegistry([r14Noop('S02'),createAccessStage(adapter)]));
  const original=await x.planAndApprove(make());
  const first=await make().run('apply',x.applyOptions);
  const before=structuredClone(calls), stateBefore=await x.state();
  const journalBefore=await fs.readFile(path.join(x.config.paths.setup_state_dir,'events.jsonl'),'utf8');
  const manifest=JSON.parse(await fs.readFile(path.join(x.config.paths.setup_state_dir,'state-commit.json'),'utf8'));
  const evidenceBefore=await evidence(x);
  let next=null,replanned=null;
  if(pause!=='none') {
    assert.equal(first.exitCode,130,JSON.stringify(first));assert.equal(stateBefore.in_flight_operation,null);
    if(continuation==='replan')replanned=await x.planAndApprove(make());
    next=await make().run('resume',{configPath:x.configPath});
  }
  const state=await x.state();
  const journalAfter=await fs.readFile(path.join(x.config.paths.setup_state_dir,'events.jsonl'),'utf8');
  const acceptance=(next??first).exitCode===0 && Object.entries(calls).every(([k,v])=>v===(k==='rollback'?0:1));
  const row={id:`S03-${pause}-${continuation}`,repo,fixture:'actual SetupEngine/createAccessStage; fake external adapter; real cancel API',
    first_exit:first.exitCode,first_error:first.envelope.error?.code??null,next_exit:next?.exitCode??null,next_error:next?.envelope.error?.code??null,
    before,after:calls,known_receipts:manifest.completed_operations?.filter(r=>r.stage==='S03'||r.receipt?.stageId==='S03').map(r=>r.receipt.operationId),
    evidence_before:evidenceBefore,evidence_after:await evidence(x),
    in_flight_before:stateBefore.in_flight_operation,in_flight_after:state.in_flight_operation,
    stage_status:state.stages.find(s=>s.id==='S03').status,timer_armed:observation.rollback.armed,
    original_operations:original.stages.find(s=>s.stage_id==='S03').operations.map(o=>o.id),
    replanned_operations:replanned?.stages.find(s=>s.stage_id==='S03').operations.map(o=>o.id)??null,
    new_intents_after_pause:journalAfter.split('\n').filter(l=>l.includes('"code":"intent"')).length-journalBefore.split('\n').filter(l=>l.includes('"code":"intent"')).length,
    acceptance,real_privileged_commands:0};
  rows.push(row);console.log(JSON.stringify(row));
}
(async()=>{
  await scenario('none','control');
  for(const pause of ['install','stage','arm','cutover','tailnet','disarm'])for(const continuation of ['resume','replan'])await scenario(pause,continuation);
  console.log(JSON.stringify({id:'META',cases:rows.length,acceptance_pass:rows.filter(r=>r.acceptance).length,harness_ok:true}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
