import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { r14Fixture, r14Noop, r14Process } from "./r14-engine";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { stableStringify } from "../../src/core/config";
import { createSystemStage } from "../../src/stages/system";
import { type InstallerPlan } from "../../src/core/types";
export async function aptFixture() {
  const x = await r14Fixture("S02"), counts = {refresh:0,simulate:0,install:0};
  let candidate = "1.0.0", fresh = false, installed = false, now = Date.parse("2026-10-25T10:00:00.000Z");
  const clock = {now: () => new Date(now)};
  const apt = {observe: async (names: string[]) => ({metadataFresh:fresh,metadataUpdatedAt:fresh?"2026-10-25T10:00:00Z":null,sudoAvailable:true,dpkgAuditClean:true,dpkgAuditOutput:"",rebootRequired:false,
    packages:names.map(name => ({name,candidateVersion:candidate,installedVersion:installed?candidate:null}))}),
    refreshMetadata:async()=>{counts.refresh++;fresh=true;}, simulateInstall:async()=>{counts.simulate++;}, installPinned:async()=>{counts.install++;installed=true;}};
  const make = () => new SetupEngine({fsAdapter:x.f,processAdapter:r14Process,clock},createRegistry([r14Noop("S01"),createSystemStage(apt)]));
  return {x,counts,clock,apt,make,candidate:(value:string)=>{candidate=value;},advance:(ms:number)=>{now+=ms;}};
}
export function rehash(plan: InstallerPlan) {const {plan_hash,...payload}=plan;plan.plan_hash=createHash("sha256").update(stableStringify(payload)).digest("hex");}

export async function evidence(config: import("../../src/core/types").SetupConfig) {
  const result: Record<string,string|null> = {};
  for (const name of ["state.json","state.json.previous","state-commit.json","events.jsonl","recovery-required.json"]) {
    try {result[name]=createHash("sha256").update(await fs.readFile(path.join(config.paths.setup_state_dir,name))).digest("hex");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;result[name]=null;}
  }
  return result;
}
export async function readPlan(x: Awaited<ReturnType<typeof r14Fixture>>) {return JSON.parse(await fs.readFile(x.applyOptions.planPath,"utf8")) as InstallerPlan;}
export async function writePlan(x: Awaited<ReturnType<typeof r14Fixture>>, p:InstallerPlan) {rehash(p);await fs.writeFile(x.applyOptions.planPath,JSON.stringify(p));}

/** Explicitly synthetic gate-free resource producer, with durable checkpoints and injected time. */
export async function counterFixture(operations=1) {
  const q=await aptFixture();const counts=Array.from({length:operations},()=>0);let revision="reviewed";
  const stage=r14Noop("S02");stage.dependencies=["S01"];
  stage.observe=async()=>({stageId:"S02",status:counts.every(n=>n>0)?"verified":"planned",checks:{revision},versions:{},observedAt:q.clock.now().toISOString()});
  stage.plan=(_desired,obs)=>({stageId:"S02",optional:false,requiredCapabilities:[],requiredGates:[],operations:counts.map((_n,index)=>({id:`owned-${index}`,stageId:"S02",kind:"mutate",resourceId:`counter-${index}`,risk:"low",gateIds:[],preconditions:[`revision:${obs.checks.revision}`],sideEffects:["owned in-memory counter"],timeoutSec:1,retryable:false}))});
  stage.apply=async(_ctx,p)=>{const op=p.operations[0]!;counts[Number(op.id.slice(6))]!++;return [{operationId:op.id,stageId:"S02",resourceId:op.resourceId,observedAt:q.clock.now().toISOString(),checks:{done:true},versions:{},artifacts:[]}];};
  stage.verifyOperation=async(_ctx,r)=>{if(counts[Number(r.operationId.slice(6))]!==1)throw Error("Counter postcondition failed");};
  const make=()=>new SetupEngine({fsAdapter:q.x.f,processAdapter:r14Process,clock:q.clock},createRegistry([r14Noop("S01"),stage]));
  return {...q,stage,make,counts,revision:(value:string)=>{revision=value;}};
}
