import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { createSystemStage } from "../../src/stages/system";
import { createApplicationStage } from "../../src/stages/application";
import { type FilesystemAdapter } from "../../src/adapters/filesystem";
import { aptFixture, counterFixture, evidence } from "../helpers/r21-admission";
import { r14Fixture, r14Noop, r14Process, r14Clock } from "../helpers/r14-engine";
import { FakeApplicationAdapter, makeCheckout, makeRelease } from "../helpers/r15-application";
import { REVIEW_KEY } from "../../src/core/plan-context";

async function changeLock(file: string) {
  const lock = JSON.parse(await fs.readFile(file,"utf8")) as {docker:{ce:string}};
  lock.docker.ce += ".final-boundary";
  await fs.writeFile(file,JSON.stringify(lock));
}
async function events(dir: string) {
  return fs.readFile(path.join(dir,"events.jsonl"),"utf8").then(t=>t.trim().split("\n").filter(Boolean).map(l=>JSON.parse(l) as {stage:string;code:string}), e=>{if(e.code==="ENOENT")return [];throw e;});
}
function wrap(target: FilesystemAdapter, method: "readTextBounded" | "hashFile", barrier: () => Promise<void>, onlyPath?: string): FilesystemAdapter {
  return new Proxy(target,{get(t,key){
    if(key===method && method==="readTextBounded")return async (p:string,max:number) => {
      const result=await t.readTextBounded(p,max);
      if((onlyPath===undefined || p===onlyPath) && new Error().stack?.includes("finalPlanAdmission"))await barrier();
      return result;
    };
    if(key===method && method==="hashFile")return async (p:string,max:number,deadline:number) => {
      const result=await t.hashFile!(p,max,deadline);
      if((onlyPath===undefined || p===onlyPath) && new Error().stack?.includes("finalPlanAdmission"))await barrier();
      return result;
    };
    const value:unknown=Reflect.get(t,key);return typeof value==="function"?value.bind(t):value;
  }});
}
for(const verb of ["apply","resume"] as const) for(const kind of ["control","config","plan"] as const) test(`A221-02/06 S02 ${verb}: ${kind} at last context read`,async()=>{
  const q=await aptFixture();await q.x.planAndApprove(q.make());let hits=0;
  const f=wrap(q.x.f,"readTextBounded",async()=>{if(hits++)return;if(kind!=="control")await fs.appendFile(kind==="config"?q.x.configPath:q.x.applyOptions.planPath,"\n");},q.x.config.version_lock_path);
  const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),createSystemStage(q.apt)]));
  const result=await e.run(verb,verb==="apply"?q.x.applyOptions:{configPath:q.x.configPath});assert.ok(hits>0,"actual last context read reached");
  if(kind==="control"){assert.equal(result.exitCode,0,JSON.stringify(result));assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});}
  else {assert.equal(result.exitCode,8);assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});assert.equal((await events(q.x.config.paths.setup_state_dir)).filter(e=>e.stage==="S02").length,0);assert.notEqual((await q.x.state()).stages.find(s=>s.id==="S02")?.status,"applying");assert.equal((await q.x.state()).in_flight_operation,null);}
});
for(const kind of ["control","config","plan","lock","session","ttl"] as const)test(`A221-04 gate after policy probe: ${kind} never publishes stale approval`,async()=>{
  const q=await aptFixture();let session="first-login";const proc={...r14Process,loginSessionId:async()=>session};
  const make=()=>new SetupEngine({fsAdapter:q.x.f,processAdapter:proc,clock:q.clock},createRegistry([r14Noop("S01"),createSystemStage(q.apt)]));
  const planned=await make().run("plan",{configPath:q.x.configPath});assert.equal(planned.exitCode,0);const before=await evidence(q.x.config);let hits=0;const original=q.apt.observe;
  q.apt.observe=async names=>{const result=await original(names);if(hits++===0){
    if(kind==="config"||kind==="plan")await fs.appendFile(kind==="config"?q.x.configPath:q.x.applyOptions.planPath,"\n");
    if(kind==="lock")await changeLock(q.x.config.version_lock_path);
    if(kind==="session")session="new-login";
    if(kind==="ttl")q.advance(30*60_000);
  }return result;};
  const result=await make().run("gate-approve",{configPath:q.x.configPath,gateId:"s02-sudo-apt-update",planHash:planned.envelope.plan_hash!});assert.ok(hits>0);
  const approved=(await q.x.state()).pending_gates.some(g=>g.status==="approved");
  if(kind==="control"){assert.equal(result.exitCode,0);assert.equal(approved,true);}
  else {assert.notEqual(result.exitCode,0);assert.equal(approved,false);assert.deepEqual(await evidence(q.x.config),before);}
  assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});
});
for(const kind of ["control","config","plan","lock","archive","manifest"] as const)for(const verb of ["apply","gate-approve"] as const)test(`A221-03/04 S05 ${verb}: ${kind} during final archive hash`,async()=>{
  const x=await r14Fixture("S05"),a=new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config));const stages=()=>[r14Noop("S04"),createApplicationStage(a)];
  const planned=await x.engine(stages()).run("plan",{configPath:x.configPath});assert.equal(planned.exitCode,0);
  if(verb==="apply")await x.planAndApprove(x.engine(stages()));
  const before=await evidence(x.config);let hits=0;
  const f=wrap(x.f,"hashFile",async()=>{if(hits++)return;
    if(kind==="config"||kind==="plan")await fs.appendFile(kind==="config"?x.configPath:x.applyOptions.planPath,"\n");
    if(kind==="lock")await changeLock(x.config.version_lock_path);
    if(kind==="archive")await fs.appendFile(x.config.release.archive_path,"drift");
    if(kind==="manifest")a.release.manifest!.source_commit="f".repeat(40);
  });
  const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry(stages()));
  const result=await e.run(verb,verb==="apply"?x.applyOptions:{configPath:x.configPath,gateId:"s05-application-release-reviewed",planHash:planned.envelope.plan_hash!});
  assert.ok(hits>0,"final archive hashing boundary reached");
  if(kind==="control"){assert.equal(result.exitCode,0,JSON.stringify(result));if(verb==="apply"){assert.equal(a.extractCalls,2);assert.equal(a.materializeCalls,1);assert.ok(a.probeCalls>0);}}
  else {assert.notEqual(result.exitCode,0,JSON.stringify(result));assert.equal(a.extractCalls+a.materializeCalls+a.probeCalls,0);assert.equal((await events(x.config.paths.setup_state_dir)).filter(e=>e.stage==="S05").length,0);if(verb==="gate-approve")assert.deepEqual(await evidence(x.config),before);}
});
for(const fault of [false,true])test(`A221-05 plan publication reseals context after archive hashing: fault=${fault}`,async()=>{
  const x=await r14Fixture("S05"),a=new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config));await x.planAndApprove(x.engine([r14Noop("S04"),createApplicationStage(a)]));
  let hashes=0,hits=0;const f=new Proxy(x.f,{get(t,key){if(key==="hashFile")return async (...args:Parameters<NonNullable<FilesystemAdapter["hashFile"]>>) =>{const value=await t.hashFile!(...args);hashes++;if(hits===0 && new Error().stack?.includes("captureContextEvidence")){hits++;if(fault)await fs.appendFile(x.configPath,"\n");}return value;};const v:unknown=Reflect.get(t,key);return typeof v==="function"?v.bind(t):v;}});
  const result=await new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry([r14Noop("S04"),createApplicationStage(a)])).run("plan",{configPath:x.configPath});assert.equal(hits,1);assert.equal(result.exitCode,fault?8:0);assert.equal(a.extractCalls+a.materializeCalls+a.probeCalls,0);
});
for(const fault of [false,true])test(`A221-05 prepared review cannot commit after request swap during plan write: fault=${fault}`,async()=>{
  const q=await aptFixture();let hits=0;const f=new Proxy(q.x.f,{get(t,key){if(key==="rename")return async(from:string,to:string)=>{await t.rename(from,to);if(to===q.x.applyOptions.planPath){hits++;if(fault)await fs.appendFile(q.x.configPath,"\n");}};const v:unknown=Reflect.get(t,key);return typeof v==="function"?v.bind(t):v;}});
  const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),createSystemStage(q.apt)]));const result=await e.run("plan",{configPath:q.x.configPath});assert.equal(hits,1);assert.equal(result.exitCode,fault?8:0);
  const review=JSON.parse((await q.x.state()).stages.find(s=>s.id==="S00")!.versions[REVIEW_KEY]!) as {phase:string};assert.equal(review.phase,fault?"prepared":"committed");assert.deepEqual(q.counts,{refresh:0,simulate:0,install:0});
});
test("A221-06 gate-free synthetic producer is still subject to final request fence",async()=>{
  const q=await counterFixture();await q.x.planAndApprove(q.make());let hits=0;
  const f=wrap(q.x.f,"readTextBounded",async()=>{if(hits++===0)await fs.appendFile(q.x.configPath,"\n");},q.x.config.version_lock_path);
  const e=new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),q.stage]));assert.equal((await e.run("apply",q.x.applyOptions)).exitCode,8);assert.ok(hits>0);assert.deepEqual(q.counts,[0]);
});
test("A221-07 completed refresh checkpoint survives session boundary; fresh review continues without replay",async()=>{
  const q=await aptFixture();let session="one";const proc={...r14Process,loginSessionId:async()=>session};const make=()=>new SetupEngine({fsAdapter:q.x.f,processAdapter:proc,clock:q.clock},createRegistry([r14Noop("S01"),createSystemStage(q.apt)]));
  const refresh=q.apt.refreshMetadata;q.apt.refreshMetadata=async()=>{await refresh();session="two";};await q.x.planAndApprove(make());const result=await make().run("apply",q.x.applyOptions);assert.equal(result.exitCode,4);assert.deepEqual(q.counts,{refresh:1,simulate:0,install:0});
  const state=await q.x.state();assert.equal(state.in_flight_operation,null);const before=await evidence(q.x.config);assert.equal((await make().run("resume",{configPath:q.x.configPath})).exitCode,4);assert.deepEqual(await evidence(q.x.config),before);
  await q.x.planAndApprove(make());assert.equal((await make().run("resume",{configPath:q.x.configPath})).exitCode,0);assert.deepEqual(q.counts,{refresh:1,simulate:1,install:1});
});
