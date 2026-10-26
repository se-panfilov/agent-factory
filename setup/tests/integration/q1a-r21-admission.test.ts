import { parseFixturePlan } from "../helpers/r22-context";
import { stringifyFixturePlan } from "../helpers/r22-context";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { r14Fixture, r14Noop, r14Process } from "../helpers/r14-engine";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { stableStringify } from "../../src/core/config";
import { createSystemStage } from "../../src/stages/system";
import { type ExecutionPlan } from "../../src/core/types";

import {aptFixture, rehash} from "../helpers/r21-admission";
test("A21-01 actual S02 stripped stage+operation gates cannot authorize APT", async () => {
  const q=await aptFixture(),e=q.make();assert.equal((await e.run("plan",{configPath:q.x.configPath})).exitCode,0);
  const p=parseFixturePlan(await fs.readFile(q.x.applyOptions.planPath,"utf8")) as ExecutionPlan;
  for(const s of p.stages){s.required_gates=[];for(const op of s.operations)op.gate_ids=[];} rehash(p);await fs.writeFile(q.x.applyOptions.planPath,stringifyFixturePlan(p));
  const applied=await e.run("apply",{...q.x.applyOptions,nonInteractive:true});assert.notEqual(applied.exitCode,0);assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});
});
test("A21-09 independently expired plan refuses even before APT approval checks",async()=>{
  const q=await aptFixture(),e=q.make();await q.x.planAndApprove(e);q.advance(31*60_000);
  assert.notEqual((await e.run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});
});
for(const age of [31,-60]) test(`A21-09 synthetic gate-free age ${age} minutes cannot execute`,async()=>{
  const q=await aptFixture();let effects=0;const s=r14Noop("S02");s.dependencies=["S01"];
  s.observe=async()=>({stageId:"S02",status:effects?"verified":"planned",checks:{},versions:{},observedAt:q.clock.now().toISOString()});
  s.plan=()=>({stageId:"S02",optional:false,requiredCapabilities:[],requiredGates:[],operations:[{ action: "fixture.counter" as const,id:"age-effect",stageId:"S02", kind:"mutate",resourceId:"synthetic",risk:"low",gateIds:[],preconditions:[],sideEffects:["local counter"],timeoutSec:1,retryable:false}]});
  s.apply=async()=>{effects++;return [{operationId:"age-effect",stageId:"S02",resourceId:"synthetic",observedAt:q.clock.now().toISOString(),checks:{done:true},versions:{},artifacts:[]}];};
  const e=new SetupEngine({fsAdapter:q.x.f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),s]));
  await q.x.planAndApprove(e);q.advance(age*60_000);assert.notEqual((await e.run("apply",q.x.applyOptions)).exitCode,0);assert.equal(effects,0);
});

import path from "node:path";
import { evidence, readPlan, writePlan, counterFixture } from "../helpers/r21-admission";
import { type StageModule } from "../../src/core/types";
const edits: Array<[string,(s:ExecutionPlan["stages"][number])=>void]> = [
  ["wrong nonempty gates",s=>{s.required_gates=["forged-review"];for(const op of s.operations)op.gate_ids=["forged-review"];}],
  ["one mandatory gate removed",s=>{s.required_gates=s.required_gates.filter(g=>g!=="s02-sudo-apt-install");s.operations[2]!.gate_ids=[];}],
  ["same gate different resources",s=>{s.required_gates=["s02-sudo-apt-install"];for(const op of s.operations)op.gate_ids=["s02-sudo-apt-install"];}],
  ["parent stage",s=>{s.stage_id="S01";}], ["foreign stage",s=>{s.operations[0]!.stage_id="S01";}], ["operation id",s=>{s.operations[2]!.id="renamed-install";}],
  ["kind",s=>{s.operations[2]!.kind="observe";}], ["resource",s=>{s.operations[2]!.resource_id="harmless";}],
  ["risk",s=>{s.operations[2]!.risk="low";}], ["preconditions",s=>{s.operations[2]!.preconditions=[];}],
  ["side effects",s=>{s.operations[2]!.side_effects=[];}], ["timeout",s=>{s.operations[2]!.timeout_sec=1;}],
  ["retry",s=>{s.operations[2]!.retryable=true;}], ["duplicate",s=>{s.operations.push({...s.operations[0]!});}],
  ["reorder",s=>{s.operations.reverse();}], ["simulation omitted",s=>{s.operations=s.operations.filter(o=>o.resource_id!=="apt-simulation");}],
  ["forged optional",s=>{s.optional=true;}], ["forged capability",s=>{s.required_capabilities=["runner-readonly"];}]
];
test("A21-02/03 policy tampering matrix: recomputed hash, zero target intents/effects and preserved approval evidence",async()=>{
  for(const [name,edit] of edits){
    const q=await aptFixture(),e=q.make();await q.x.planAndApprove(e);const original=await readPlan(q.x),p=structuredClone(original);edit(p.stages.find(s=>s.stage_id==="S02")!);await writePlan(q.x,p);
    const before=await evidence(q.x.config);const result=await q.make().run("apply",q.x.applyOptions);
    assert.equal(result.exitCode,2,`${name}: ${JSON.stringify(result)}`);assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});assert.deepEqual(await evidence(q.x.config),before,name);
    console.log("R21_TAMPER "+JSON.stringify({name,exit:result.exitCode,error:result.envelope.error?.code,counts:q.counts,before,after:await evidence(q.x.config)}));
    if(name==="wrong nonempty gates"){await fs.writeFile(q.x.applyOptions.planPath,stringifyFixturePlan(original));assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,0,"original approvals must remain usable for their original policy");assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});}
  }
});
test("A21-04 stage-only requirements, optional/capabilities and true no-op are independent policy",async()=>{
  for(const mode of ["review","prerequisite","optional","capability","noop"] as const){
    const q=await aptFixture();let calls=0;const stage=r14Noop("S02");stage.dependencies=["S01"];
    stage.requiredCapabilities=mode==="capability"?["runner-readonly"]:[];
    const gate=mode==="prerequisite"?"external-required":"stage-review";
    stage.plan=()=>({stageId:"S02",optional:false,requiredCapabilities:stage.requiredCapabilities,requiredGates:mode==="noop"?[]:[gate],operations:[]});stage.apply=async()=>{calls++;return [];};
    const make=()=>new SetupEngine({fsAdapter:q.x.f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),stage]));
    const e=make();assert.equal((await e.run("plan",{configPath:q.x.configPath})).exitCode,0);const p=await readPlan(q.x),original=structuredClone(p);const s=p.stages.find(s=>s.stage_id==="S02")!;
    if(mode!=="noop"){
      if(mode==="optional")s.optional=true;else if(mode==="capability")s.required_capabilities=[];else s.required_gates=[];
      await writePlan(q.x,p);assert.equal((await make().run("apply",q.x.applyOptions)).exitCode,2);await fs.writeFile(q.x.applyOptions.planPath,stringifyFixturePlan(original));
      assert.equal((await make().run("apply",q.x.applyOptions)).exitCode,4);
      const approved=await make().run("gate-approve",{configPath:q.x.configPath,gateId:gate,planHash:original.plan_hash});
      assert.equal(approved.exitCode,mode==="prerequisite"?5:0);
    }
    const result=await make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,mode==="prerequisite"?4:0,JSON.stringify(result));assert.equal(calls,0);
  }
});
test("A21-05/06 actual S02 fresh/approved succeeds; no approval, bad hash and one-sided gates remain refusals",async()=>{
  for(const mode of ["approved","unapproved","hash","one-sided"] as const){
    const q=await aptFixture(),e=q.make();if(mode==="approved")await q.x.planAndApprove(e);else assert.equal((await e.run("plan",{configPath:q.x.configPath})).exitCode,0);
    const p=await readPlan(q.x);if(mode==="hash"){p.plan_hash="0".repeat(64);await fs.writeFile(q.x.applyOptions.planPath,stringifyFixturePlan(p));}if(mode==="one-sided"){p.stages.find(s=>s.stage_id==="S02")!.required_gates=[];await writePlan(q.x,p);}
    const result=await q.make().run("apply",{...q.x.applyOptions,nonInteractive:true});assert.equal(result.exitCode,mode==="approved"?0:mode==="unapproved"?4:2,JSON.stringify(result));
    assert.deepEqual(q.counts,mode==="approved"?{refresh:1,simulate:1,install:1}:{refresh:0,simulate:0,install:0});
  }
});
for(const age of [0,30*60_000-1,30*60_000,30*60_000+1,31*60_000,-1,-60*60_000])test(`A21-09 synthetic gate-free plan age boundary ${age}ms`,async()=>{
  const q=await counterFixture(),e=q.make();await q.x.planAndApprove(e);q.advance(age);const before=await evidence(q.x.config);const result=await q.make().run("apply",q.x.applyOptions);
  const valid=age>=0&&age<30*60_000;assert.equal(result.exitCode,valid?0:age<0?8:4,JSON.stringify(result));assert.deepEqual(q.counts,[valid?1:0]);if(!valid)assert.deepEqual(await evidence(q.x.config),before);
  console.log("R21_TIME "+JSON.stringify({age,exit:result.exitCode,effects:q.counts,error:result.envelope.error?.code}));
});
test("A21-09 malformed and impossible UTC creation timestamps refuse without effects",async()=>{
  for(const value of ["2026-10-25Tnonsense","2026-10-25T10:00:00Z","2026-10-25T10:00:00.000+00:00","2026-02-30T10:00:00.000Z","2026-02-29T10:00:00.000Z","2026-13-25T10:00:00.000Z"]){
    const q=await counterFixture(),e=q.make();await q.x.planAndApprove(e);const p=await readPlan(q.x);p.created_at=value;await writePlan(q.x,p);const before=await evidence(q.x.config);const result=await q.make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,2,JSON.stringify(result));assert.deepEqual(q.counts,[0]);assert.deepEqual(await evidence(q.x.config),before);
  }
});
test("A21-08/10 expiry after durable first operation preserves progress across instances and explicit re-review",async()=>{
  const q=await counterFixture(2);const apply=q.stage.apply.bind(q.stage);q.stage.apply=async(ctx,p)=>{const receipts=await apply(ctx,p);if(p.operations[0]!.id==="owned-0")q.advance(30*60_000);return receipts;};
  const e=q.make();await q.x.planAndApprove(e);const result=await e.run("apply",q.x.applyOptions);assert.equal(result.exitCode,4);assert.deepEqual(q.counts,[1,0]);assert.equal((await q.x.state()).in_flight_operation,null);
  const before=await evidence(q.x.config);assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,4);assert.deepEqual(await evidence(q.x.config),before);assert.deepEqual(q.counts,[1,0]);
  const manifest=JSON.parse(await fs.readFile(path.join(q.x.config.paths.setup_state_dir,"state-commit.json"),"utf8")) as {completed_operations:Array<{receipt:{operationId:string}}>} ;assert.ok(manifest.completed_operations.some(x=>x.receipt.operationId==="owned-0"));
  await q.x.planAndApprove(q.make());assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,0);assert.deepEqual(q.counts,[1,1]);assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,0);assert.deepEqual(q.counts,[1,1]);
  console.log("R21_PROGRESS "+JSON.stringify({first_exit:result.exitCode,effects:q.counts,inflight:(await q.x.state()).in_flight_operation,completed:manifest.completed_operations.map(x=>x.receipt.operationId)}));
});
for(const changed of ["config","plan"] as const)test(`A21-11 controlled lock barrier changes ${changed}: no in-memory substitution`,async()=>{
  const q=await aptFixture(),e=q.make();await q.x.planAndApprove(e);const before=await evidence(q.x.config);const mkdir=q.x.f.mkdir.bind(q.x.f);let hit=0;
  q.x.f.mkdir=async(dir,opts)=>{await mkdir(dir,opts);if(dir===path.join(q.x.config.paths.setup_state_dir,"lock")&&hit++===0){if(changed==="config"){const c=structuredClone(q.x.config);c.resource_profile="standard";await fs.writeFile(q.x.configPath,JSON.stringify(c));}else await fs.appendFile(q.x.applyOptions.planPath,"\n ");}};
  const result=await q.make().run("apply",q.x.applyOptions);assert.equal(hit,1);assert.equal(result.exitCode,8,JSON.stringify(result));assert.equal(result.envelope.error?.code,"request_changed_after_read");assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});assert.deepEqual(await evidence(q.x.config),before);
});
test("A21-12 actual S02 candidate drift with unchanged planned status requires a fresh reviewed policy",async()=>{
  const q=await aptFixture(),e=q.make();await q.x.planAndApprove(e);q.candidate("2.0.0");const before=await evidence(q.x.config);const result=await q.make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,8);assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});assert.deepEqual(await evidence(q.x.config),before);
  await q.x.planAndApprove(q.make());assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});
});
test("A21-12 APT refresh may change candidates, but unreviewed install never gains that authorization",async()=>{
  const q=await aptFixture();const refresh=q.apt.refreshMetadata;q.apt.refreshMetadata=async()=>{await refresh();q.candidate("2.0.0");};await q.x.planAndApprove(q.make());const result=await q.make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,8,JSON.stringify(result));assert.deepEqual(q.counts,{refresh:1,simulate:0,install:0});assert.equal((await q.x.state()).in_flight_operation,null);
});
test("A21-13 expired plan approval/resume/upsert never renews approval identity or destroys known progress",async()=>{
  const q=await aptFixture(),e=q.make();await q.x.planAndApprove(e);const p=await readPlan(q.x),gates=(await q.x.state()).pending_gates;q.advance(30*60_000);
  const approved=await q.make().run("gate-approve",{configPath:q.x.configPath,gateId:"s02-sudo-apt-update",planHash:p.plan_hash});assert.equal(approved.exitCode,4);assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,4);
  const next=(await q.x.state()).pending_gates;assert.deepEqual(next.map(g=>[g.id,g.operation_id,g.plan_hash,g.expires_at]),gates.map(g=>[g.id,g.operation_id,g.plan_hash,g.expires_at]));assert.ok(next.every(g=>g.status==="expired"));assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});
});

import { capturePlanContext } from "../../src/core/plan-context";
import { createPlanFile } from "../../src/core/plan";
test("A21-01/03 legacy without enrolled basis still derives policy independently from actual S02 producer",async()=>{
  for(const mode of ["strip", "simulation omitted", "timeout"] as const){
    const q=await aptFixture(),e=q.make();await createPlanFile(q.x.f,q.x.config,createRegistry([r14Noop("S01"),createSystemStage(q.apt)]),null,q.clock,[],new Map(),await capturePlanContext(q.x.f,r14Process,q.x.config,["S01","S02"]));
    const p=await readPlan(q.x),s=p.stages.find(s=>s.stage_id==="S02")!;
    if(mode==="strip"){s.required_gates=[];for(const op of s.operations)op.gate_ids=[];}else edits.find(([name])=>name===mode)![1](s);
    await writePlan(q.x,p);const result=await e.run("apply",{...q.x.applyOptions,nonInteractive:true});assert.equal(result.exitCode,8,JSON.stringify(result));assert.equal(result.envelope.error?.code,"plan_review_required");assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});assert.equal((await q.x.state()).in_flight_operation,null);
  }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("A21-07 explicit S02 target uses its closure rather than all config selected stages; containment retained",async()=>{
  const q=await aptFixture();q.x.config.selected_stages=["S06"];await fs.writeFile(q.x.configPath,JSON.stringify(q.x.config));
  const e=q.make();assert.equal((await e.run("plan",{configPath:q.x.configPath,stageId:"S02"})).exitCode,0);const p=await readPlan(q.x);assert.deepEqual(p.stages.map(s=>s.stage_id),["S01","S02"]);
  for(const gateId of new Set(p.stages.flatMap(s=>s.required_gates)))assert.equal((await e.run("gate-approve",{configPath:q.x.configPath,gateId,planHash:p.plan_hash})).exitCode,0);
  assert.equal((await e.run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});
  for(const id of ["S08","S14"] as const){const x=await aptFixture(),stage=r14Noop(id);const engine=new SetupEngine({fsAdapter:x.x.f,processAdapter:r14Process,clock:x.clock},createRegistry([stage]));assert.equal((await engine.run("plan",{configPath:x.x.configPath,stageId:id})).exitCode,0);assert.equal((await engine.run("apply",x.x.applyOptions)).exitCode,5);}
});
test("A21-08 separate owned engine subprocesses: plan, tamper refusal, approve, apply, resume with no replay",async()=>{
  const q=await aptFixture(),factsPath=path.join(q.x.root,"owned-apt.json");await fs.writeFile(factsPath,JSON.stringify({fresh:false,installed:false,counts:{refresh:0,simulate:0,install:0}}));
  async function run(mode:string){const {stdout}=await promisify(execFile)(process.execPath,[path.resolve(__dirname,"../../../tests/helpers/r21-worker.cjs"),path.resolve(__dirname,"../.."),q.x.configPath,factsPath,mode],{timeout:20_000,maxBuffer:512*1024,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}});return JSON.parse(stdout) as {pid:number;result:{exitCode:number};facts:{counts:{refresh:number;simulate:number;install:number}}};}
  const planned=await run("plan");assert.equal(planned.result.exitCode,0);const p=await readPlan(q.x),original=structuredClone(p);for(const s of p.stages){s.required_gates=[];for(const op of s.operations)op.gate_ids=[];}await writePlan(q.x,p);
  const before=await evidence(q.x.config),refused=await run("apply");assert.equal(refused.result.exitCode,2);assert.deepEqual(refused.facts.counts,{refresh:0,simulate:0,install:0});assert.deepEqual(await evidence(q.x.config),before);
  await fs.writeFile(q.x.applyOptions.planPath,stringifyFixturePlan(original));const approved=await run("approve"),applied=await run("apply"),resumed=await run("resume");assert.equal(approved.result.exitCode,0);assert.equal(applied.result.exitCode,0);assert.equal(resumed.result.exitCode,0);assert.deepEqual(resumed.facts.counts,{refresh:1,simulate:1,install:1});assert.notEqual(planned.pid,applied.pid);
  console.log("R21_PROCESSES "+JSON.stringify({planned,refused,approved,applied,resumed}));
});
test("A21-12 planner timestamps and producer-ignored volatile counters do not create false drift",async()=>{
  const q=await counterFixture(),observe=q.stage.observe.bind(q.stage);let reads=0;q.stage.observe=async ctx=>{const o=await observe(ctx);o.checks.free_memory=++reads;o.observedAt=new Date().toISOString();return o;};await q.x.planAndApprove(q.make());assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,[1]);assert.ok(reads>=3);
});

import { saveState } from "../../src/core/state";
import { POLICY_BASIS_KEY } from "../../src/core/policy";
test("A21-04/08 internal basis compatibility: legacy fresh policy is validated, malformed/future metadata preserved and blocked",async()=>{
  const legacy=await counterFixture(),engine=legacy.make();await createPlanFile(legacy.x.f,legacy.x.config,createRegistry([r14Noop("S01"),legacy.stage]),null,legacy.clock,[],new Map(),await capturePlanContext(legacy.x.f,r14Process,legacy.x.config,["S01","S02"]));assert.equal((await engine.run("apply",legacy.x.applyOptions)).exitCode,8);assert.deepEqual(legacy.counts,[0]);await legacy.x.planAndApprove(engine);assert.equal((await engine.run("apply",legacy.x.applyOptions)).exitCode,0);assert.deepEqual(legacy.counts,[1]);
  for(const corrupt of ["json","version","shape","status-type"] as const){
    const q=await counterFixture();await q.x.planAndApprove(q.make());const state=await q.x.state(),stage=state.stages.find(s=>s.id==="S02")!;
    const basis=JSON.parse(stage.versions[POLICY_BASIS_KEY]!) as Record<string,unknown>;
    if(corrupt==="status-type")(basis.source as Record<string,unknown>).status=["planned"];
    if(corrupt==="version")basis.version=99;if(corrupt==="shape")basis.extra="unsupported";
    stage.versions[POLICY_BASIS_KEY]=corrupt==="json"?"{":JSON.stringify(basis);
    // Synthetic malformed metadata, published with the real core writer, never a forged state hash.
    await saveState(q.x.f,q.x.config,state);const before=await evidence(q.x.config),plan=await fs.readFile(q.x.applyOptions.planPath);
    assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,8);assert.equal((await q.make().run("plan",{configPath:q.x.configPath})).exitCode,8);assert.deepEqual(q.counts,[0]);assert.deepEqual(await evidence(q.x.config),before);assert.deepEqual(await fs.readFile(q.x.applyOptions.planPath),plan);
  }
});
test("A21-06 malformed JSON and unreadable reviewed plan have typed refusal and zero effects",async()=>{
  const q=await counterFixture();await q.x.planAndApprove(q.make());await fs.writeFile(q.x.applyOptions.planPath,"{");assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,2);await fs.unlink(q.x.applyOptions.planPath);assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,8);assert.deepEqual(q.counts,[0]);
});

test("A21-02/03/12 own progress cannot silently authorize a newly required gate/resource/risk",async()=>{
  for(const change of ["gate","resource","risk"] as const){
    const q=await counterFixture(2),observe=q.stage.observe.bind(q.stage),plan=q.stage.plan.bind(q.stage);
    q.stage.observe=async ctx=>{const o=await observe(ctx);o.checks.first_done=q.counts[0]===1;return o;};
    q.stage.plan=(desired,obs)=>{const p=plan(desired,obs);if(obs.checks.first_done){if(change==="gate"){p.requiredGates=["new-review"];p.operations[1]!.gateIds=["new-review"];}if(change==="resource")p.operations[1]!.resourceId="new-resource";if(change==="risk")p.operations[1]!.risk="critical";}return p;};
    await q.x.planAndApprove(q.make());const first=await q.make().run("apply",q.x.applyOptions);assert.equal(first.exitCode,8,JSON.stringify(first));assert.deepEqual(q.counts,[1,0]);assert.equal((await q.x.state()).in_flight_operation,null);
    await q.x.planAndApprove(q.make());assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,[1,1]);
  }
});

test("A21-13 expired approval retains actual S02 checkpoint/binding and a new review resumes without refresh replay",async()=>{
  const q=await aptFixture(),refresh=q.apt.refreshMetadata;q.apt.refreshMetadata=async()=>{await refresh();q.advance(30*60_000);};await q.x.planAndApprove(q.make());const plan=await readPlan(q.x);assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,4);assert.deepEqual(q.counts,{refresh:1,simulate:0,install:0});
  const commitPath=path.join(q.x.config.paths.setup_state_dir,"state-commit.json"),before=JSON.parse(await fs.readFile(commitPath,"utf8")) as {completed_operations:unknown;last_effect_checkpoint:unknown};const journal=await fs.readFile(path.join(q.x.config.paths.setup_state_dir,"events.jsonl"));const expiry=(await q.x.state()).pending_gates.map(g=>g.expires_at);
  assert.equal((await q.make().run("gate-approve",{configPath:q.x.configPath,gateId:"s02-sudo-apt-install",planHash:plan.plan_hash})).exitCode,4);assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,4);
  const after=JSON.parse(await fs.readFile(commitPath,"utf8")) as typeof before;assert.deepEqual(after.completed_operations,before.completed_operations);assert.deepEqual(after.last_effect_checkpoint,before.last_effect_checkpoint);assert.deepEqual(await fs.readFile(path.join(q.x.config.paths.setup_state_dir,"events.jsonl")),journal);assert.deepEqual((await q.x.state()).pending_gates.map(g=>g.expires_at),expiry);assert.equal((await q.x.state()).in_flight_operation,null);
  await q.x.planAndApprove(q.make());assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,0);assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});
});

test("A21-03 operation IDs are unique across parent stages, not merely within each array",async()=>{
  for(const collision of [true,false]){
    const q=await aptFixture(),counts:{[key:string]:number}={S01:0,S02:0};
    const stages=(["S01","S02"] as const).map(id=>{
      const s=r14Noop(id);s.dependencies=id==="S02"?["S01"]:[];s.observe=async()=>({stageId:id,status:counts[id]!>0?"verified":"planned",checks:{},versions:{},observedAt:q.clock.now().toISOString()});
      s.plan=()=>({stageId:id,optional:false,requiredCapabilities:[],requiredGates:[],operations:[{ action: "fixture.counter" as const,id:collision?"shared":`owned-${id}`,stageId:id,kind:"mutate",resourceId:`resource-${id}`,risk:"low",gateIds:[],preconditions:[],sideEffects:["owned counter"],timeoutSec:1,retryable:false}]});
      s.apply=async(_ctx,p)=>{counts[id]!++;return [{operationId:p.operations[0]!.id,stageId:id,resourceId:`resource-${id}`,observedAt:q.clock.now().toISOString(),checks:{done:true},versions:{},artifacts:[]}];};return s;
    });
    const e = new SetupEngine({fsAdapter:q.x.f,processAdapter:r14Process,clock:q.clock},createRegistry(stages));
    if (collision) {
      const result = await e.run("plan", {configPath:q.x.configPath});
      assert.equal(result.exitCode, 2, "duplicate producer IDs refuse at serialization, before review/effect");
      assert.deepEqual(counts, {S01:0,S02:0});
    } else {
      await q.x.planAndApprove(e);
      assert.equal((await e.run("apply",q.x.applyOptions)).exitCode, 0);
      assert.deepEqual(counts, {S01:1,S02:1});
    }
  }
});

test("A21-08 synthetic legacy policy absence preserves engine-generated simulation proof until explicit review",async()=>{
  const q=await aptFixture(),observe=q.apt.observe,simulate=q.apt.simulateInstall;q.apt.observe=async names=>({...await observe(names),metadataFresh:true});q.apt.simulateInstall=async()=>{await simulate();q.advance(30*60_000);};await q.x.planAndApprove(q.make());assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,4);assert.deepEqual(q.counts,{refresh:0,simulate:1,install:0});
  q.advance(-30*60_000);const legacy=await q.x.state();for(const s of legacy.stages)delete s.versions[POLICY_BASIS_KEY];await saveState(q.x.f,q.x.config,legacy);
  const before=await evidence(q.x.config);const refused=await q.make().run("apply",q.x.applyOptions);assert.equal(refused.exitCode,8);assert.equal(refused.envelope.error?.code,"plan_review_required");assert.deepEqual(await evidence(q.x.config),before);assert.deepEqual(q.counts,{refresh:0,simulate:1,install:0});
  await q.x.planAndApprove(q.make());assert.equal((await q.make().run("resume",{configPath:q.x.configPath})).exitCode,0);assert.deepEqual(q.counts,{refresh:0,simulate:1,install:1});
});

test("A21-04/12 stage-only gate discovered after the last effect blocks final verified until explicit review",async()=>{
  const q=await counterFixture(),observe=q.stage.observe.bind(q.stage),plan=q.stage.plan.bind(q.stage);
  q.stage.observe=async ctx=>{const o=await observe(ctx);o.checks.requires_final_review=q.counts[0]===1;return o;};
  q.stage.plan=(desired,o)=>o.checks.requires_final_review?{stageId:"S02",optional:false,requiredCapabilities:[],requiredGates:["final-review"],operations:[]}:plan(desired,o);
  await q.x.planAndApprove(q.make());const result=await q.make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,8);assert.equal(result.envelope.error?.code,"plan_completion_policy_drift");assert.deepEqual(q.counts,[1]);assert.equal((await q.x.state()).in_flight_operation,null);assert.notEqual((await q.x.state()).stages.find(s=>s.id==="S02")?.status,"verified");
  await q.x.planAndApprove(q.make());assert.equal((await q.make().run("apply",q.x.applyOptions)).exitCode,0);assert.deepEqual(q.counts,[1]);
});
