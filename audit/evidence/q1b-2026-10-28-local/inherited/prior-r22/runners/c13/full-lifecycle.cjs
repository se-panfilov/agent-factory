// C13 fixture/input adapter. Original counters/oracles preserved; see adapter-map.md.
const __c13=require('../c13-fixture-compat.cjs')(process.argv[2]);
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),rawfs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const repo=process.argv[2],fixtures=process.argv[3];const from=n=>require(path.join(repo,'setup/dist/src',n+'.js'));
function helpers(file,names){const filename=path.join(repo,'setup/dist/tests/integration',file+'.test.js'),raw=rawfs.readFileSync(path.join(fixtures,file+'.test.js'),'utf8');const at=raw.indexOf('(0, node_test_1.default)(');assert.ok(at>0);const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(raw.slice(0,at)+'\nmodule.exports={'+names.join(',')+'};',filename);return m.exports;}
(async()=>{
 const images=helpers('config-images',['prepareRoot','FakeProcessAdapter']);const q=await images.prepareRoot(),c=q.config;c.selected_stages=['S07'];
 c.host.arch='amd64';await __c13.prepare(c);const configPath=path.join(q.root,'config.json');await fs.writeFile(configPath,__c13.stringify(c));
 const apph=helpers('application',['makeCheckout','makeRelease','FakeApplicationAdapter']);const release=apph.makeRelease(c),checkout=apph.makeCheckout(c);
 // An owner-provided synthetic M0 checkout exists, but has no installer trust receipt.
 // S05 must create a gated plan and run its mandatory command probe regardless.
 checkout.exists=true;checkout.deployedSourceCommit=c.release.source_commit;
 await fs.writeFile(path.join(c.paths.application_dir,'deployment-manifest.json'),__c13.stringify(release.manifest));
 await fs.mkdir(path.join(c.paths.setup_node_dir,'bin'),{recursive:true});await fs.writeFile(path.join(c.paths.setup_node_dir,'bin/node'),'synthetic executable placeholder',{mode:0o700});
 const verifyh=helpers('verification-auth',['FakeProcessAdapter']);const vp=new verifyh.FakeProcessAdapter({},c.release.source_commit);
 const ip=new images.FakeProcessAdapter(q.codexPath,'0.32.0','sha256:'+'b'.repeat(64),'1'.repeat(64));
 const proc={hostIdentity:async()=>({os:"ubuntu-24.04",arch:"amd64"}),loginSessionId:async()=>"c13-fixture-owner-login",pid:()=>process.pid,uid:()=>1000,username:()=> 'factory',bootId:()=>vp.bootId(),machineIdHash:()=>vp.machineIdHash(),processStartTicks:async()=>1,isPidAlive:()=>true,
  runCommand:async opts=> opts.binary==='/usr/bin/git'||opts.binary.endsWith('/node')||(opts.binary==='/usr/bin/docker'&&['run','create','inspect','rm'].includes(opts.args[0])) ? vp.runCommand(opts) : ip.runCommand(opts)};
 const {NodeFilesystemAdapter}=from('adapters/filesystem'),base=new NodeFilesystemAdapter();const f=Object.create(base);f.exists=async p=>path.basename(p)==='bootstrap-receipt.json'?true:base.exists(p);
 const {SetupEngine}=from('core/engine'),{createRegistry}=from('core/plan');const defaults=new SetupEngine({fsAdapter:f,processAdapter:proc});const bootstrap=defaults.registry.byId.get('S00');assert.ok(bootstrap);
 let installed=false,refreshed=false,aptCounts={refresh:0,simulate:0,install:0};const apt={observe:async names=>({metadataFresh:refreshed,metadataUpdatedAt:'2026-10-24T10:00:00Z',sudoAvailable:true,dpkgAuditClean:true,dpkgAuditOutput:'',rebootRequired:false,packages:names.map(name=>({name,installedVersion:installed?'1.0':null,candidateVersion:'1.0'}))}),refreshMetadata:async()=>{refreshed=true;aptCounts.refresh++;},simulateInstall:async()=>{aptCounts.simulate++;},installPinned:async()=>{installed=true;aptCounts.install++;}};
 const ah=helpers('access',['FakeAccessAdapter','baseObservation']),access=new ah.FakeAccessAdapter(ah.baseObservation());
 const dh=helpers('docker-host',['FakeDockerAdapter','baseObservation']),docker=new dh.FakeDockerAdapter(dh.baseObservation());
 const application=new apph.FakeApplicationAdapter(checkout,release);
 const stages=[bootstrap,from('stages/preflight').createPreflightStage({readOnlyHostReport:async()=>({osRelease:'ubuntu-24.04',arch:'amd64',uid:1000,username:'factory',hasSystemd:true,cgroupVersion:'v2',freeDiskBytes:1e11,totalDiskBytes:2e11,freeInodes:1e5,cpuCount:4,totalMemBytes:16e9})}),from('stages/system').createSystemStage(apt),from('stages/access').createAccessStage(access),from('stages/docker').createDockerStage(docker),from('stages/application').createApplicationStage(application),from('stages/configuration').createConfigurationStage(f,proc),from('stages/verification').createVerificationStage(f,proc)];
 const makeEngine=()=>new SetupEngine({fsAdapter:f,processAdapter:proc,clock:{now:()=>new Date('2026-10-24T10:00:00Z')}},__c13.registry(stages));let e=makeEngine();
 const p=await e.run('plan',{configPath});assert.equal(p.exitCode,0,__c13.stringify(p));assert.deepEqual(p.envelope.data.stage_closure,['S00','S01','S02','S03','S04','S05','S06','S07']);
 for(const g of p.envelope.data.required_approvals){const r=await e.run('gate-approve',{configPath,gateId:g.id,planHash:p.envelope.plan_hash});assert.equal(r.exitCode,0,__c13.stringify(r));}
 const a=await e.run('apply',{configPath,planPath:path.join(c.paths.setup_state_dir,'plan.json')});assert.equal(a.exitCode,0,__c13.stringify(a));
 const s=await e.run('status',{configPath});assert.equal(s.exitCode,0,__c13.stringify(s));for(const id of ['S00','S01','S02','S03','S04','S05','S06','S07'])assert.equal(s.envelope.stages.find(s=>s.id===id).status,'verified');
 const r=await makeEngine().run('resume',{configPath});assert.equal(r.exitCode,0,__c13.stringify(r));assert.equal(aptCounts.install,1);assert.equal(docker.installCalls,1);assert.equal(docker.probeCalls,1);assert.equal(access.cutoverCalls,1);assert.equal(ip.buildCalls,1);
 console.log(__c13.stringify({id:'U09_all_real_S00_S07_single_engine',status:application.probeCalls>=1?'PASS':'FAIL',fixture:'existing owner-provided synthetic M0 checkout without installer trust receipt; clean fake APT/Docker with group already active; all real producer modules; no real privileged commands',stage_closure:p.envelope.data.stage_closure,apply_exit:a.exitCode,status_exit:s.exitCode,resume_exit:r.exitCode,apt_counts:aptCounts,docker_install_calls:docker.installCalls,docker_probe_calls:docker.probeCalls,cutover_calls:access.cutoverCalls,application_probe_calls:application.probeCalls,image_build_calls:ip.buildCalls,real_commands:0}));
 assert.ok(application.probeCalls>=1,'Mandatory S05 probes must execute in full composition');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
