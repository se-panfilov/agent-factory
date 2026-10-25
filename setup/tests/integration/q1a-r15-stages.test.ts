import test from "node:test";
import assert from "node:assert/strict";
import { r14Fixture, r14Noop } from "../helpers/r14-engine";
import { FakeApplicationAdapter, makeCheckout, makeRelease } from "../helpers/r15-application";
import { FakeDockerAdapter, baseObservation } from "../helpers/r15-docker";
import { accessInventory } from "../helpers/r15-access";
import { createApplicationStage } from "../../src/stages/application";
import { createDockerStage } from "../../src/stages/docker";
import { observeAccessInputProof } from "../../src/stages/access";
for (const command of ["plan", "verify", "status-refresh"] as const) {
  test(`V01 trusted S05 detected tamper refuses ${command} before probe adapter`, async () => {
    const x = await r14Fixture("S05"), a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
    const e = x.engine([r14Noop("S04"), createApplicationStage(a)]); await x.planAndApprove(e);
    assert.equal((await e.run("apply", x.applyOptions)).exitCode, 0);
    const before = a.probeCalls; assert.ok(before > 0); a.hashMismatches = ["runner.js:hash-mismatch"];
    const result = await e.run(command === "status-refresh" ? "status" : command, { configPath:x.configPath, ...(command === "status-refresh" ? {refresh:true} : {}) });
    assert.equal(a.probeCalls, before, "known integrity violation must never enter command probe adapter");
    assert.equal(result.exitCode, 9); assert.equal(result.envelope.error?.code, "s05_deployed_integrity_failed");
  });
}
test("V05 clean Docker without effective group pauses before daemon-dependent effects", async () => {
  const x = await r14Fixture("S04"), o = baseObservation();
  o.dockerGroup = { exists:false,currentUserInGroup:false,accountUserInGroup:false };
  const a = new FakeDockerAdapter(o); a.changeGroupMembership = true;
  const observe = a.observe.bind(a); a.observe = async () => { const o = await observe(); if (!o.dockerGroup.currentUserInGroup) { o.daemonReachable=false; o.apiCompatible=false; o.serverVersion=null; } return o; };
  const e = x.engine([r14Noop("S03"), createDockerStage(a)]); await x.planAndApprove(e);
  const result = await e.run("apply", x.applyOptions);
  assert.equal(result.exitCode, 4, JSON.stringify(result)); assert.equal(a.groupCalls,1); assert.equal(a.restartCalls,0); assert.equal(a.mergeCalls,0);
  assert.equal((await x.state()).in_flight_operation,null); assert.equal((await x.state()).stages.find(s=>s.id==="S04")?.status,"awaiting_manual");
});
test("V08 external Include is explicitly refused rather than silently omitted", async () => {
  const x = await accessInventory("Include /etc/ssh/extra/access.conf\n");
  await x.write("/etc/ssh/extra/access.conf", "Match User factory\n PasswordAuthentication yes\n");
  await assert.rejects(() => observeAccessInputProof(x.adapter,1000,"/manual"), {code:"s03_include_unsupported"});
  assert.equal(x.mutations(),0);
});

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeApplicationReleaseAdapter } from "../../src/adapters/git";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import { r14Process, r14Clock } from "../helpers/r14-engine";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { SessionDockerAdapter } from "../helpers/r15-docker";
import { type FilesystemAdapter } from "../../src/adapters/filesystem";
import { type ProcessAdapter } from "../../src/adapters/process";
import { type StageContext } from "../../src/core/types";

async function actualApplication(entry = "runner.js", downstream = false) {
  const x = await r14Fixture(downstream ? "S06" : "S05");
  const a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
  const body = "// reviewed local fixture entry; command process is intercepted\n";
  const executable = path.join(x.config.paths.application_dir, entry);
  a.release.manifest!.content_hashes = { [entry]: createHash("sha256").update(body).digest("hex") };
  a.release.manifest!.commands = { runner_verify:["node",entry],runner_stop:["node",entry,"stop"] };
  let commandInvocations = 0, traps = 0, hashReadFailure = false, dependentEffects = 0;
  const proc: ProcessAdapter = { ...r14Process, uid: () => process.getuid?.() ?? 1000, runCommand: async command => {
    if (command.binary === "/usr/bin/sha256sum") {
      if (hashReadFailure) return {exitCode:1,stdout:"",stderr:"injected read failure",timedOut:false,durationMs:0};
      return {exitCode:0,stdout:createHash("sha256").update(await fs.readFile(command.args[0]!)).digest("hex")+"  fixture\n",stderr:"",timedOut:false,durationMs:0};
    }
    assert.equal(command.binary,path.join(x.config.paths.setup_node_dir,"bin","node"));
    commandInvocations++; if ((await fs.readFile(command.args[0]!,"utf8")).includes("TAMPERED")) traps++;
    return {exitCode:0,stdout:"help",stderr:"",timedOut:false,durationMs:0};
  } };
  const node = new NodeApplicationReleaseAdapter(proc,x.f);
  a.verifyContentHashes = node.verifyContentHashes.bind(node); a.probeCommands = node.probeCommands.bind(node);
  a.materializeRelease = async () => {
    a.materializeCalls++; await fs.mkdir(path.dirname(executable),{recursive:true,mode:0o700}); await fs.writeFile(executable,body,{mode:0o600});
    a.checkout.exists=true;a.checkout.deployedSourceCommit=x.config.release.source_commit;
  };
  // Extraction is external/fake; hash-check uses the actual deployed FS only for this fixture.
  a.extractArchive = async (_config,target) => {a.extractCalls++; await fs.mkdir(path.join(target,"release",path.dirname(entry)),{recursive:true,mode:0o700}); await fs.writeFile(path.join(target,"release",entry),body,{mode:0o600});};
  const dependent = r14Noop("S06");dependent.dependencies=["S05"];
  dependent.plan=()=>({stageId:"S06",optional:false,requiredCapabilities:[],requiredGates:[],operations:[{id:"dependent-trap",stageId:"S06",kind:"mutate",resourceId:"dependent",risk:"low",gateIds:[],preconditions:[],sideEffects:["fixture only"],timeoutSec:1,retryable:false}]});
  dependent.apply=async()=>{dependentEffects++;throw Error("Downstream trap executed");};
  const engine = (f: FilesystemAdapter = x.f) => new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry([r14Noop("S04"),createApplicationStage(a),...(downstream?[dependent]:[])]));
  return {x,a,node,engine,executable,body,commands:()=>commandInvocations,traps:()=>traps,dependentEffects:()=>dependentEffects,setHashReadFailure:()=>{hashReadFailure=true;}};
}
for (const failure of ["tamper","missing","read-failure","file-symlink","directory-symlink","writable"] as const) {
  for (const command of ["plan","verify","status-refresh","apply","resume"] as const) {
    test(`V01 actual application adapter ${failure}/${command}: zero executable invocations`, async () => {
      const q = await actualApplication(failure==="directory-symlink"?"scripts/runner.js":"runner.js"),{x}=q,e=q.engine();
      await x.planAndApprove(e); assert.equal((await e.run("apply",x.applyOptions)).exitCode,0); assert.ok(q.commands()>=2);
      if(failure==="tamper") await fs.writeFile(q.executable,"// TAMPERED executable trap\n");
      if(failure==="missing") await fs.unlink(q.executable);
      if(failure==="read-failure") q.setHashReadFailure();
      if(failure==="writable") await fs.chmod(q.executable,0o666);
      if(failure==="file-symlink") {await fs.rename(q.executable,q.executable+".saved");await fs.symlink(q.executable+".saved",q.executable);}
      if(failure==="directory-symlink") {const dir=path.dirname(q.executable);await fs.rename(dir,dir+".saved");await fs.symlink(dir+".saved",dir);}
      const before=q.commands(); const result=await e.run(command==="status-refresh"?"status":command,command==="apply"?x.applyOptions:{configPath:x.configPath,...(command==="status-refresh"?{refresh:true}:{})});
      assert.equal(result.exitCode,9,JSON.stringify(result));assert.equal(result.envelope.error?.code,"s05_deployed_integrity_failed");assert.equal(q.commands(),before);assert.equal(q.traps(),0);
      const stateBefore=await fs.readFile(path.join(x.config.paths.setup_state_dir,"state.json"),"utf8");
      await e.run("status",{configPath:x.configPath}); assert.equal(q.commands(),before);assert.equal(await fs.readFile(path.join(x.config.paths.setup_state_dir,"state.json"),"utf8"),stateBefore);
    });
  }
}
test("V02 materialization checkpoint to probe drift blocks actual commands and downstream effects", async () => {
  const q=await actualApplication("runner.js",true),{x}=q;let tampered=false;
  const f=new Proxy(x.f,{get(t,key,receiver){
    if(key==="fsyncDir")return async(p:string)=>{await t.fsyncDir(p);if(p!==x.config.paths.setup_state_dir||tampered)return;
      try {const m=JSON.parse(await fs.readFile(path.join(p,"state-commit.json"),"utf8")) as {last_effect_checkpoint?:{operation_id:string}};
        if(m.last_effect_checkpoint?.operation_id.includes("materialize-checkout")){tampered=true;await fs.writeFile(q.executable,"// TAMPERED after durable materialization binding\n");}}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    };
    const value:unknown=Reflect.get(t,key,receiver);return typeof value==="function"?value.bind(t):value;
  }});
  const e=q.engine(f);await x.planAndApprove(e);const result=await e.run("apply",x.applyOptions);
  assert.ok(tampered);assert.equal(result.exitCode,9,JSON.stringify(result));assert.equal(q.commands(),0);assert.equal(q.traps(),0);assert.equal(q.dependentEffects(),0);
  const journal=(await fs.readFile(path.join(x.config.paths.setup_state_dir,"events.jsonl"),"utf8")).trim().split("\n").map(s=>JSON.parse(s) as {operation_id:string;code:string});
  assert.equal(journal.some(r=>r.operation_id.includes("probe-release")&&["verify","checkpoint"].includes(r.code)),false);
  assert.notEqual((await x.state()).stages.find(s=>s.id==="S05")?.status,"verified");
});
test("V03 actual clean release probes remain mandatory and repeat verify succeeds",async()=>{
  const q=await actualApplication(),{x}=q,e=q.engine();await x.planAndApprove(e);assert.equal((await e.run("apply",x.applyOptions)).exitCode,0);
  const before=q.commands();assert.ok(before>=2);assert.equal((await e.run("verify",{configPath:x.configPath})).exitCode,0);assert.ok(q.commands()>before);assert.equal(q.traps(),0);
});
test("V03 mismatched config/release/path receipt is not executable authorization",async()=>{
  const x=await r14Fixture("S05"),a=new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config));a.checkout.exists=true;a.checkout.deployedSourceCommit=x.config.release.source_commit;
  const stage=createApplicationStage(a);
  for(const versions of [{archive_sha256:"f".repeat(64),source_commit:x.config.release.source_commit},{archive_sha256:x.config.release.sha256,source_commit:"e".repeat(40)},{archive_sha256:x.config.release.sha256,source_commit:x.config.release.source_commit,release_manifest_hash:"f".repeat(64)}]){
    const ctx:StageContext={config:x.config,installationId:x.config.installation_id,contractVersion:"1.0.0",profile:"supervised",desiredHash:"fixture",planHash:"fixture",completedOperationReceipts:[{operationId:"old",stageId:"S05",resourceId:"application-checkout",observedAt:r14Clock.now().toISOString(),checks:{},versions,artifacts:[x.config.paths.application_dir]}]};
    assert.equal((await stage.observe(ctx)).status,"planned");await assert.rejects(()=>stage.verify(ctx),{code:"s05_release_trust_evidence_missing"});
  }
  assert.equal(a.probeCalls,0);
});
test("V06 realistic clean Docker old/new sessions and repeat preserve completed effects",async()=>{
  const x=await r14Fixture("S04"),o=baseObservation();o.dockerGroup={exists:false,accountUserInGroup:false,currentUserInGroup:false};o.dockerSocket.exists=false;
  const a=new SessionDockerAdapter(o);a.changeGroupMembership=true;const make=()=>x.engine([r14Noop("S03"),createDockerStage(a)]);
  let e=make();await x.planAndApprove(e);assert.equal((await e.run("apply",x.applyOptions)).exitCode,4);
  assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.mergeCalls+a.restartCalls+a.probeCalls,0);
  e=make();const before=await fs.readFile(path.join(x.config.paths.setup_state_dir,"events.jsonl"),"utf8");
  const oldSession=await e.run("resume",{configPath:x.configPath});assert.equal(oldSession.exitCode,4);assert.equal(oldSession.envelope.error?.code,"s04_relogin_required");assert.equal(await fs.readFile(path.join(x.config.paths.setup_state_dir,"events.jsonl"),"utf8"),before);assert.equal((await x.state()).in_flight_operation,null);
  a.observation.dockerGroup.currentUserInGroup=true;a.observation.reloginRequired=false;e=make();
  await x.planAndApprove(e);assert.equal((await e.run("resume",{configPath:x.configPath})).exitCode,0);
  assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.mergeCalls,1);assert.equal(a.restartCalls,1);assert.equal(a.probeCalls,1);
  assert.equal((await make().run("resume",{configPath:x.configPath})).exitCode,0);assert.equal(a.installCalls,1);assert.equal(a.restartCalls,1);assert.equal(a.probeCalls,1);
});

import { NodeDockerAdapter } from "../../src/adapters/docker";
for(const mode of ["permission","down","malformed-info","malformed-version","malformed-ps","ps-error","healthy"] as const){
 test(`V04 actual NodeDockerAdapter ${mode}: unknown data is not a verified empty daemon`,async()=>{
  const x=await r14Fixture("S04"),commands:Array<{binary:string;args:string[]}>=[],unhandled:string[]=[];
  const proc:ProcessAdapter={...r14Process,runCommand:async c=>{
   commands.push({binary:c.binary,args:c.args});let exitCode=0,stdout="",stderr="";
   if(c.binary==="/usr/bin/docker"){
    if(c.args[0]==="context")stdout=c.args[1]==="show"?"default\n":'"unix:///var/run/docker.sock"\n';
    else if(mode==="permission"||mode==="down"){exitCode=1;stderr=mode==="permission"?"permission denied accessing protected socket":"cannot connect to daemon";}
    else if(c.args[0]==="version")stdout=mode==="malformed-version"?"{}":JSON.stringify({Client:{Version:"27.3.1"},Server:{Version:"27.3.1"}});
    else if(c.args[0]==="info")stdout=mode==="malformed-info"?"not-json":JSON.stringify({NCPU:2,MemTotal:2e9,SecurityOptions:[],FirewallBackend:"iptables",CgroupVersion:"2",PidsLimit:true});
    else if(c.args[0]==="ps"){if(mode==="ps-error"){exitCode=1;stderr="inspection failed";}else stdout=mode==="malformed-ps"?'{"ID":"missing-fields"}':"";}
    else unhandled.push(JSON.stringify(c));
   }else if(c.binary==="/usr/bin/id")stdout=c.args.length===1&&mode==="permission"?"factory\n":"factory docker\n";
   else if(c.binary==="/usr/bin/getent")stdout="docker:x:998:factory\n";
   else if(c.binary==="/usr/bin/apt-cache")stdout="docker-ce:\n Candidate: 1.0\n https://download.docker.com/linux/ubuntu\n";
   else if(c.binary==="/usr/bin/dpkg-query")stdout="docker-ce\t1.0\tinstall ok installed\n";
   else if(c.binary!=="/usr/bin/sudo"&&c.binary!=="/usr/bin/ss")unhandled.push(JSON.stringify(c));
   return {exitCode,stdout,stderr,timedOut:false,durationMs:0};
  }};
  const f=new Proxy(x.f,{get(t,key,receiver){
   if(key==="exists")return async()=>false;
   if(key==="stat")return async(p:string)=>{assert.equal(p,"/var/run/docker.sock");return Object.assign(await t.stat(x.root),{uid:0,gid:998,mode:0o140660});};
   const v:unknown=Reflect.get(t,key,receiver);return typeof v==="function"?v.bind(t):v;
  }});
  const observed=await new NodeDockerAdapter(proc,f).observe({config:x.config,installationId:x.config.installation_id,contractVersion:"1.0.0",profile:"supervised",desiredHash:"fixture",planHash:"fixture"});
  assert.deepEqual(unhandled,[]);assert.equal(observed.dockerSocket.mode,"0660");assert.equal(observed.dockerSocket.worldWritable,false);
  if(mode==="permission"){assert.equal(observed.daemonReachable,false);assert.equal(observed.apiCompatible,false);assert.equal(observed.daemonAccess,"permission_denied");assert.equal(observed.dockerGroup.accountUserInGroup,true);assert.equal(observed.dockerGroup.currentUserInGroup,false);}
  if(mode!=="healthy"&&mode!=="malformed-version") {assert.notEqual(observed.workloads.inspection,"verified");assert.equal(observed.workloads.foreignContainerCount,-1);}
  if(mode.startsWith("malformed")&&mode!=="malformed-ps")assert.equal(observed.daemonAccess,"malformed");
  if(mode==="healthy"){assert.equal(observed.daemonReachable,true);assert.equal(observed.apiCompatible,true);assert.equal(observed.workloads.inspection,"verified");assert.equal(observed.workloads.foreignContainerCount,0);}
  assert.ok(commands.some(c=>c.binary==="/usr/bin/id"&&c.args.length===1));assert.ok(commands.some(c=>c.binary==="/usr/bin/id"&&c.args.length===2));
  assert.ok(commands.filter(c=>c.binary==="/usr/bin/sudo").every(c=>c.args.join(" ")==="-n /usr/bin/true"),"no sudo docker or persistent access bypass");
 });
}
for(const syntax of [
 "include /etc/ssh/extra/access.conf\n", "Include sshd_config.d/*.conf\n", 'Include "/etc/ssh/extra/access.conf"\n',
 "Include /etc/ssh/sshd_config.d/*.conf /etc/ssh/extra.conf\n", "Match User factory\n Include /etc/ssh/sshd_config.d/*.conf\n",
 "Include /etc/ssh/**/*.conf\n", "Include /etc/ssh/sshd_config.d/[ab].conf\n", "Include /etc/ssh/sshd_config.d/*.conf\\\n", 'Include "/etc/ssh/sshd_config.d/*.conf\n',
 '"Include" /etc/ssh/extra.conf\n', "Include=/etc/ssh/sshd_config.d/*.conf\n"
])test(`V08 restricted Include policy refuses ${JSON.stringify(syntax)}`,async()=>{
 const x=await accessInventory(syntax);await assert.rejects(()=>observeAccessInputProof(x.adapter,1000,"/manual"),{code:"s03_include_unsupported"});assert.equal(x.mutations(),0);assert.ok(x.reads.length<=1);assert.ok(x.directories.length===0);
});
for(const directive of ["Include /etc/ssh/extra/access.conf\n","include /etc/ssh/sshd_config.d/*.conf\n","Match User factory\n Include /etc/ssh/other.conf\n"])
 test(`V08 nested/conditional/cyclic Include is refused without recursion ${JSON.stringify(directive)}`,async()=>{
  const x=await accessInventory();await x.write("/etc/ssh/sshd_config.d/50-access.conf",directive);
  await assert.rejects(()=>observeAccessInputProof(x.adapter,1000,"/manual"),{code:"s03_include_unsupported"});assert.equal(x.mutations(),0);assert.equal(x.directories.length,1);assert.equal(x.reads.length,2);
 });
test("V09 standard quoted/case-insensitive layout and glob membership/content/mode proof",async()=>{
 const x=await accessInventory('  iNcLuDe   "/etc/ssh/sshd_config.d/*.conf" # standard\n');
 const first=await observeAccessInputProof(x.adapter,1000,"/manual");await x.write("/etc/ssh/sshd_config.d/10-a.conf","Match User factory\n PasswordAuthentication no\n");
 const added=await observeAccessInputProof(x.adapter,1000,"/manual");assert.notEqual(first.contentHash,added.contentHash);
 await x.write("/etc/ssh/sshd_config.d/10-a.conf","Match User factory\n PasswordAuthentication yes\n");const changed=await observeAccessInputProof(x.adapter,1000,"/manual");assert.notEqual(added.contentHash,changed.contentHash);
 await fs.chmod(x.mapped("/etc/ssh/sshd_config.d/10-a.conf"),0o640);const mode=await observeAccessInputProof(x.adapter,1000,"/manual");assert.notEqual(changed.ownershipHash,mode.ownershipHash);
 await fs.unlink(x.mapped("/etc/ssh/sshd_config.d/10-a.conf"));const removed=await observeAccessInputProof(x.adapter,1000,"/manual");assert.equal(removed.contentHash,first.contentHash);assert.equal(x.mutations(),0);
});
for(const failure of ["count","bytes","total-bytes","unreadable","missing-race","file-symlink","directory-symlink","parent-symlink","owner","special"] as const)
 test(`V09 collector boundary ${failure}: bounded reads, no traversal or mutation`,async()=>{
  const x=await accessInventory();let adapter=x.adapter;const target="/etc/ssh/sshd_config.d/10-a.conf";await x.write(target,"PasswordAuthentication no\n");
  if(failure==="count")for(let i=0;i<65;i++)await x.write(`/etc/ssh/sshd_config.d/${i}.conf`,"# bounded\n");
  if(failure==="bytes")await x.write(target,"#".repeat(256*1024+1));
  if(failure==="total-bytes")for(let i=0;i<9;i++)await x.write(`/etc/ssh/sshd_config.d/${i}.conf`,"#".repeat(250*1024));
  if(failure==="file-symlink"){await fs.unlink(x.mapped(target));await fs.symlink("/foreign",x.mapped(target));}
  if(failure==="directory-symlink"){await fs.rename(x.mapped("/etc/ssh/sshd_config.d"),x.mapped("/etc/ssh/saved"));await fs.symlink("/foreign",x.mapped("/etc/ssh/sshd_config.d"));}
  if(failure==="parent-symlink"){await fs.rename(x.mapped("/etc/ssh"),x.mapped("/etc/saved"));await fs.symlink("/foreign",x.mapped("/etc/ssh"));}
  if(failure==="owner")x.owners.set(target,1);
  if(["unreadable","missing-race","special"].includes(failure))adapter=new Proxy(x.adapter,{get(t,key,receiver){
    if(key==="readTextBounded"&&failure==="unreadable")return async(p:string,n:number)=>{if(p===target)throw Object.assign(Error("fixture denied"),{code:"EACCES"});return t.readTextBounded(p,n);};
    if(key==="lstat")return async(p:string)=>{if(p===target&&failure==="missing-race")throw Object.assign(Error("fixture disappeared"),{code:"ENOENT"});const stat=await t.lstat(p);return p===target&&failure==="special"?Object.assign(stat,{mode:0o010600}):stat;};
    const v:unknown=Reflect.get(t,key,receiver);return typeof v==="function"?v.bind(t):v;
  }});
  const expectedCode=failure==="count"?"s03_security_input_inventory_unsafe":["bytes","total-bytes"].includes(failure)?"s03_security_input_oversized":["unreadable","missing-race"].includes(failure)?"s03_security_input_unreadable":"s03_security_input_ownership_unsafe";
  await assert.rejects(()=>observeAccessInputProof(adapter,1000,"/manual"),{code:expectedCode});assert.equal(x.mutations(),0);assert.ok(x.reads.length<=11);assert.ok(x.reads.every(r=>r.limit===256*1024));assert.ok(x.directories.length<=1);
 });

// Actual collector drives admission while the effective-config observation is deliberately constant.
import { FakeAccessAdapter, baseObservation as accessObservation } from "../helpers/r15-access-adapter";
import { createAccessStage } from "../../src/stages/access";
for(const mode of ["clean","content","owner","nested"] as const)test(`V10 actual collector to Access stage to engine ${mode} before first intent`,async()=>{
 const x=await r14Fixture("S03"),inventory=await accessInventory(),file="/etc/ssh/sshd_config.d/50-access.conf";
 await inventory.write(file,"Match User factory\n PasswordAuthentication no\n");
 const a=new FakeAccessAdapter(accessObservation()),effective=a.observation.ssh.configHash;
 const original=a.observe.bind(a);a.observe=async()=>({...await original(),securityInputs:await observeAccessInputProof(inventory.adapter,1000,"/manual")});
 const e=x.engine([r14Noop("S02"),createAccessStage(a)]);await x.planAndApprove(e);
 if(mode==="content")await inventory.write(file,"Match User factory\n PasswordAuthentication yes\n");
 if(mode==="owner")inventory.owners.set(file,1);
 if(mode==="nested")await inventory.write(file,"Match User factory\n Include /etc/ssh/extra/conditional.conf\n");
 const result=await e.run("apply",x.applyOptions);
 assert.equal(a.observation.ssh.configHash,effective,"effective dump never changed; raw inventory must protect admission");
 if(mode==="clean"){assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(a.cutoverCalls,1);assert.equal(a.disarmCalls,1);}
 else{
  assert.equal(result.exitCode,mode==="content"?4:mode==="owner"?9:5,JSON.stringify(result));
  assert.equal(a.installCalls+a.stageCalls+a.armCalls+a.cutoverCalls+a.disarmCalls,0);
  const journalPath=path.join(x.config.paths.setup_state_dir,"events.jsonl");
  const journal=await x.f.exists(journalPath)?await fs.readFile(journalPath,"utf8"):"";
  assert.equal(journal.includes('"stage":"S03"'),false,"refusal precedes every S03 operation intent");
 }
 assert.equal(inventory.mutations(),0);
});
test("V09 deep nested graph and missing/unreadable canonical directory have explicit bounded refusal",async()=>{
 const deep=await accessInventory();for(let i=0;i<20;i++)await deep.write(`/etc/ssh/sshd_config.d/${String(i).padStart(2,"0")}.conf`,`Include /etc/ssh/sshd_config.d/${String((i+1)%20).padStart(2,"0")}.conf\n`);
 await assert.rejects(()=>observeAccessInputProof(deep.adapter,1000,"/manual"),{code:"s03_include_unsupported"});assert.equal(deep.reads.length,2);assert.equal(deep.directories.length,1);
 const missing=await accessInventory();await fs.rmdir(missing.mapped("/etc/ssh/sshd_config.d"));await assert.rejects(()=>observeAccessInputProof(missing.adapter,1000,"/manual"),{code:"s03_security_input_unreadable"});
 const denied=await accessInventory(),adapter=new Proxy(denied.adapter,{get(t,key,receiver){if(key==="readdir")return async()=>{throw Object.assign(Error("denied"),{code:"EACCES"});};const v:unknown=Reflect.get(t,key,receiver);return typeof v==="function"?v.bind(t):v;}});
 await assert.rejects(()=>observeAccessInputProof(adapter,1000,"/manual"),{code:"s03_security_input_unreadable"});
 assert.equal(deep.mutations()+missing.mutations()+denied.mutations(),0);
});
test("V09 unsupported SSH text encoding never produces a lossy complete proof",async()=>{
 const x=await accessInventory();await fs.writeFile(x.mapped("/etc/ssh/sshd_config"),Buffer.from([0xff,0x0a]));await assert.rejects(()=>observeAccessInputProof(x.adapter,1000,"/manual"),{code:"s03_security_input_encoding_unsupported"});assert.equal(x.mutations(),0);
});

async function pauseDocker(accountMember=false,active=false) {
 const x=await r14Fixture("S04"),o=baseObservation();o.dockerGroup={exists:accountMember||active,accountUserInGroup:accountMember||active,currentUserInGroup:active};o.dockerSocket.exists=false;
 const a=new SessionDockerAdapter(o);a.changeGroupMembership=!accountMember&&!active;
 const make=(f:FilesystemAdapter=x.f)=>new SetupEngine({fsAdapter:f,processAdapter:r14Process,clock:r14Clock},createRegistry([r14Noop("S03"),createDockerStage(a)]));
 return {x,a,make};
}
for(const mode of ["account-old-session","already-active"] as const)test(`V06 Docker ${mode} observes actual groups rather than approving a relogin`,async()=>{
 const q=await pauseDocker(true,mode==="already-active"),{x,a}=q;

 const e=q.make();await x.planAndApprove(e);const applied=await e.run("apply",x.applyOptions);
 assert.equal(applied.exitCode,mode==="already-active"?0:4,JSON.stringify(applied));
 if(mode==="account-old-session"){assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.restartCalls,0);assert.equal(a.probeCalls,0);assert.equal((await x.state()).in_flight_operation,null);}
 else{assert.equal(a.installCalls,1);assert.equal(a.restartCalls,1);assert.equal(a.probeCalls,1);}
});
for(const hazard of ["unmanaged","foreign","public","tcp","world-writable","socket-owner","unknown-workloads","malformed-workloads"] as const)test(`V07 Docker ${hazard} refuses before daemon mutation`,async()=>{
 const q=await pauseDocker(true,true),{x,a}=q;a.observation.dockerInstalled=true;a.observation.managedByInstaller=hazard!=="unmanaged";for(const p of a.observation.packages)p.installedVersion=p.candidateVersion;
 if(hazard==="foreign"){a.observation.workloads.foreignContainerCount=1;a.observation.workloads.foreignContainerIds=["foreign"];}if(hazard==="public")a.observation.workloads.publicPublishedPortCount=1;
 if(hazard==="tcp")a.observation.tcpApi.configured=true;if(hazard==="world-writable")a.observation.dockerSocket.worldWritable=true;if(hazard==="socket-owner")a.observation.dockerSocket.uid=1;
 if(hazard==="unknown-workloads")a.inspection="unavailable";if(hazard==="malformed-workloads")a.inspection="malformed";
 const e=q.make();await x.planAndApprove(e);const result=await e.run("apply",x.applyOptions);assert.notEqual(result.exitCode,0,JSON.stringify(result));
 assert.equal(a.installCalls+a.groupCalls+a.mergeCalls+a.restartCalls+a.probeCalls,0);assert.notEqual((await x.state()).stages.find(s=>s.id==="S04")?.status,"verified");
});
for(const drift of ["package","config","account"] as const)test(`V07 Docker ${drift} drift invalidates installation progress without replay`,async()=>{
 const q=await pauseDocker(),{x,a}=q;let e=q.make();await x.planAndApprove(e);assert.equal((await e.run("apply",x.applyOptions)).exitCode,4);
 if(drift==="package")a.observation.packages[0]!.installedVersion="foreign-version";
 if(drift==="config"){x.config.resource_profile="standard";await fs.writeFile(x.configPath,JSON.stringify(x.config));}
 if(drift==="account")a.observation.dockerGroup.accountUserInGroup=false;
 e=q.make();const result=await e.run("resume",{configPath:x.configPath});assert.notEqual(result.exitCode,0);assert.notEqual(result.envelope.error?.code,"s04_relogin_required","drift must not masquerade as confirmed membership awaiting login");
 assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.restartCalls,0);assert.equal(a.probeCalls,0);
});
import { setupError } from "../../src/core/errors";
import { ExitCode } from "../../src/core/types";
for(const failure of ["down","api-mismatch","restart-error","api-after-restart","probe-error"] as const)test(`V07 active-session Docker ${failure} remains a failure with truthful uncertainty`,async()=>{
 const q=await pauseDocker(),{x,a}=q;let e=q.make();await x.planAndApprove(e);assert.equal((await e.run("apply",x.applyOptions)).exitCode,4);
 a.observation.dockerGroup.currentUserInGroup=true;a.observation.reloginRequired=false;
 if(failure==="down")a.healthy=false;if(failure==="api-mismatch")a.compatible=false;
 if(failure==="restart-error"||failure==="api-after-restart"){const restart=a.restartDaemon.bind(a);a.restartDaemon=async()=>{await restart();if(failure==="restart-error")throw setupError({exitCode:ExitCode.OperationOrVerificationFailed,code:"s04_daemon_restart_failed",publicMessage:"fixture restart failure",nextAction:"inspect",stage:"S04"});a.compatible=false;};}
 if(failure==="probe-error")a.probeResult.cleanupOk=false;
 e=q.make();await x.planAndApprove(e);const result=await e.run("apply",x.applyOptions);
 assert.notEqual(result.exitCode,0);assert.notEqual(result.exitCode,4,"operational failure is not a relogin");assert.notEqual((await x.state()).stages.find(s=>s.id==="S04")?.status,"verified");
 if(["restart-error","api-after-restart","probe-error"].includes(failure)){
  assert.ok((await x.state()).in_flight_operation);const counts=[a.installCalls,a.groupCalls,a.restartCalls,a.probeCalls];assert.equal((await q.make().run("resume",{configPath:x.configPath})).exitCode,8);assert.deepEqual([a.installCalls,a.groupCalls,a.restartCalls,a.probeCalls],counts);
 }else{assert.equal((await x.state()).in_flight_operation,null);assert.equal(a.restartCalls+a.probeCalls,0);}
});
for(const phase of ["group-effect-before","group-effect-after","binding-before","binding-after","pause-state"] as const)for(const fault of [true,false])test(`V07 Docker fault ${phase}/${fault?"on":"control"}: independent fixture and no unknown replay`,async()=>{
 const q=await pauseDocker(),{x,a}=q;let hits=0,opportunities=0,exactPath="";
 const originalGroup=a.ensureDockerGroupMembership.bind(a);
 if(phase.startsWith("group-effect"))a.ensureDockerGroupMembership=async()=>{
  opportunities++;if(fault){hits++;exactPath="adapter:group-account-update";if(phase==="group-effect-after")await originalGroup();else a.groupCalls++;throw setupError({exitCode:ExitCode.OperationOrVerificationFailed,code:"s04_group_write_failed",publicMessage:"fixture group write failure",nextAction:"preserve unknown effect",stage:"S04"});}return originalGroup();
 };
 const injected=(p:string)=>{opportunities++;if(fault&&hits===0){hits++;exactPath=p;throw Object.assign(Error("fixture metadata I/O fault"),{code:phase==="binding-before"?"ENOSPC":"EIO"});}};
 const f=new Proxy(x.f,{get(t,key,receiver){
  if(key==="writeText")return async(p:string,body:string,mode?:number)=>{
   if(phase==="binding-before"&&p.includes("state-commit.json.tmp-")){const m=JSON.parse(body) as {last_effect_checkpoint?:{operation_id:string}};if(m.last_effect_checkpoint?.operation_id.includes("docker-group-membership"))injected(p);}
   if(phase==="pause-state"&&p.includes("state.json.tmp-")){const s=JSON.parse(body) as {stages:Array<{id:string;status:string}>};if(s.stages.some(s=>s.id==="S04"&&s.status==="awaiting_manual"))injected(p);}
   return t.writeText(p,body,mode);
  };
  if(key==="rename")return async(from:string,to:string)=>{await t.rename(from,to);if(phase==="binding-after"&&to.endsWith("state-commit.json")){const m=JSON.parse(await fs.readFile(to,"utf8")) as {last_effect_checkpoint?:{operation_id:string}};if(m.last_effect_checkpoint?.operation_id.includes("docker-group-membership"))injected(to);}};
  const v:unknown=Reflect.get(t,key,receiver);return typeof v==="function"?v.bind(t):v;
 }});
 const e=q.make(f);await x.planAndApprove(e);const first=await e.run("apply",x.applyOptions);
 assert.ok(opportunities>0,"exact fault boundary actually reached");assert.equal(hits,fault?1:0);assert.notEqual(first.exitCode,0);if(!fault)assert.equal(first.exitCode,4);
 assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.restartCalls+a.probeCalls,0);assert.notEqual((await x.state()).stages.find(s=>s.id==="S04")?.status,"verified");
 const unresolved=fault&&["group-effect-before","group-effect-after","binding-before"].includes(phase);
 const next=await q.make().run("resume",{configPath:x.configPath});assert.equal(next.exitCode,unresolved?8:4,JSON.stringify(next));assert.equal(a.groupCalls,1);assert.equal(a.installCalls,1);
 if(!unresolved){a.observation.dockerGroup.currentUserInGroup=true;a.observation.reloginRequired=false;const active=q.make();await x.planAndApprove(active);assert.equal((await active.run("apply",x.applyOptions)).exitCode,0);assert.equal(a.installCalls,1);assert.equal(a.groupCalls,1);assert.equal(a.restartCalls,1);assert.equal(a.probeCalls,1);}
 const metadata=await fs.readFile(path.join(x.config.paths.setup_state_dir,"state-commit.json"),"utf8");
 console.log("R15_DOCKER_FAULT "+JSON.stringify({phase,fault,hits,opportunities,path:exactPath,first_exit:first.exitCode,next_exit:next.exitCode,unknown:unresolved,install_calls:a.installCalls,group_calls:a.groupCalls,restart_calls:a.restartCalls,probe_calls:a.probeCalls,manifest_sha256:createHash("sha256").update(metadata).digest("hex")}));
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { type DockerRuntimeObservation } from "../../src/adapters/docker";
async function evidenceHashes(config:import("../../src/core/types").SetupConfig){
 const out:Record<string,string|null>={};for(const name of ["state.json","state.json.previous","state-commit.json","events.jsonl","recovery-required.json"]){try{out[name]=createHash("sha256").update(await fs.readFile(path.join(config.paths.setup_state_dir,name))).digest("hex");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;out[name]=null;}}return out;
}
for(const phase of ["effect","bound","pause"] as const)test(`V07 Docker child ${phase}: real engine barrier, SIGKILL, known progress or unknown refusal`,async()=>{
 const child=spawn(process.execPath,[path.resolve(__dirname,"../../../tests/helpers/r15-docker-child.cjs"),path.resolve(__dirname,"../.."),phase],{stdio:["ignore","pipe","pipe","ipc"]});
 let stderr="",deadline:NodeJS.Timeout|undefined;child.stderr!.on("data",data=>{stderr+=String(data);});
 type Barrier={type:string;phase:string;path:string;config:import("../../src/core/types").SetupConfig;configPath:string;observation:DockerRuntimeObservation;counts:{install:number;group:number;restart:number;probe:number}};
 const b=await new Promise<Barrier>((resolve,reject)=>{deadline=setTimeout(()=>reject(Error("Docker child barrier deadline: "+stderr)),20000);child.once("error",reject);child.once("exit",code=>reject(Error(`Writer exited before barrier ${code}: ${stderr}`)));child.on("message",(value:Barrier)=>{if(value.type==="barrier"){clearTimeout(deadline);resolve(value);}});}).catch(error=>{child.kill("SIGKILL");throw error;});
 try{
  assert.equal(b.phase,phase);assert.deepEqual(b.counts,{install:1,group:1,restart:0,probe:0});assert.equal(b.observation.dockerGroup.accountUserInGroup,true);assert.equal(b.observation.dockerGroup.currentUserInGroup,false);
  const a=new SessionDockerAdapter(b.observation),proc:ProcessAdapter={...r14Process,isPidAlive:pid=>{try{process.kill(pid,0);return true;}catch{return false;}}};
  const make=()=>new SetupEngine({fsAdapter:new NodeFilesystemAdapter(),processAdapter:proc,clock:r14Clock},createRegistry([r14Noop("S03"),createDockerStage(a)]));
  let e=make();const before=await evidenceHashes(b.config);await e.run("status",{configPath:b.configPath});assert.deepEqual(await evidenceHashes(b.config),before);
  assert.equal((await e.run("recover",{configPath:b.configPath})).exitCode,7);assert.deepEqual(await evidenceHashes(b.config),before);
  const exited=once(child,"exit");child.kill("SIGKILL");const[code,signal]=await exited;assert.equal(code,null);assert.equal(signal,"SIGKILL");
  assert.equal((await e.run("recover",{configPath:b.configPath,lockOnly:true})).exitCode,0);assert.deepEqual(await evidenceHashes(b.config),before);
  const recovered=await e.run("recover",{configPath:b.configPath});assert.equal(recovered.exitCode,phase==="effect"?8:0);
  const old=await make().run("resume",{configPath:b.configPath});assert.equal(old.exitCode,phase==="effect"?8:4);assert.equal(a.installCalls+a.groupCalls+a.mergeCalls+a.restartCalls+a.probeCalls,0);
  if(phase!=="effect"){
   a.observation.dockerGroup.currentUserInGroup=true;a.observation.reloginRequired=false;e=make();const planned=await e.run("plan",{configPath:b.configPath});assert.equal(planned.exitCode,0,JSON.stringify(planned));
   const disk=JSON.parse(await fs.readFile(path.join(b.config.paths.setup_state_dir,"plan.json"),"utf8")) as import("../../src/core/types").InstallerPlan;
   for(const gate of new Set(disk.stages.flatMap(s=>[...s.required_gates,...s.operations.flatMap(o=>o.gate_ids)])))assert.equal((await e.run("gate-approve",{configPath:b.configPath,gateId:gate,planHash:disk.plan_hash})).exitCode,0);
   assert.equal((await e.run("resume",{configPath:b.configPath})).exitCode,0);assert.equal(a.installCalls+a.groupCalls,0);assert.equal(a.restartCalls,1);assert.equal(a.probeCalls,1);
  }else assert.deepEqual(await evidenceHashes(b.config),before,"unknown group outcome is preserved without replay");
  console.log("R15_DOCKER_CRASH "+JSON.stringify({phase,path:b.path,child_signal:signal,before,after:await evidenceHashes(b.config),recover_exit:recovered.exitCode,old_session_exit:old.exitCode,child_counts:b.counts,parent_counts:{install:a.installCalls,group:a.groupCalls,restart:a.restartCalls,probe:a.probeCalls}}));
 }finally{clearTimeout(deadline);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});

test("V03 changed desired config cannot reuse historic S05 command authorization",async()=>{
 const x=await r14Fixture("S05"),a=new FakeApplicationAdapter(makeCheckout(x.config),makeRelease(x.config)),e=x.engine([r14Noop("S04"),createApplicationStage(a)]);
 await x.planAndApprove(e);assert.equal((await e.run("apply",x.applyOptions)).exitCode,0);const before=a.probeCalls;
 x.config.resource_profile="standard";await fs.writeFile(x.configPath,JSON.stringify(x.config));
 assert.equal((await e.run("plan",{configPath:x.configPath})).exitCode,0);assert.equal(a.probeCalls,before);
 const verify=await e.run("verify",{configPath:x.configPath});assert.equal(verify.exitCode,5);assert.equal(verify.envelope.error?.code,"s05_release_trust_evidence_missing");assert.equal(a.probeCalls,before);
});
test("V03 actual probe adapter refuses unbound/sudo entries and unsafe content paths before executable entry",async()=>{
 const q=await actualApplication(),e=q.engine();await q.x.planAndApprove(e);assert.equal((await e.run("apply",q.x.applyOptions)).exitCode,0);
 const before=q.commands(),manifest=q.a.release.manifest!;
 for(const argv of [["/usr/bin/sudo","runner.js"],["node","../outside.js"],["node","-e","process.exit()"],["node","unlisted.js"]]){
  await assert.rejects(()=>q.node.probeCommands(q.x.config.paths.application_dir,{...manifest,commands:{...manifest.commands,runner_verify:argv}},q.x.config),{code:"s05_command_content_unbound"});
 }
 await assert.rejects(()=>q.node.probeCommands(q.x.config.paths.application_dir,{...manifest,content_hashes:{...manifest.content_hashes,"../outside.js":"a".repeat(64)}},q.x.config),{code:"s05_deployed_integrity_failed"});
 assert.equal(q.commands(),before);assert.equal(q.traps(),0);
});
