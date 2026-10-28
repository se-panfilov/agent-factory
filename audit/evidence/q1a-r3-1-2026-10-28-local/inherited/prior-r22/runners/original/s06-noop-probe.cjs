// Reuse only deterministic fixture helpers from the compiled repository test.
// No repository source/test file is modified and no original test callback runs.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const repo=path.resolve(process.argv[2]||process.cwd());
const filename=path.join(repo,'setup/dist/tests/integration/config-images.test.js');
const raw=fs.readFileSync(filename,'utf8');
const prefix=raw.slice(0,raw.indexOf('(0, node_test_1.default)("S06 applies'));
assert.ok(prefix.length>1000);
const fixtureModule=new Module(filename,module);fixtureModule.filename=filename;fixtureModule.paths=Module._nodeModulePaths(path.dirname(filename));
fixtureModule._compile(prefix+'\nmodule.exports={prepareRoot,FakeProcessAdapter,ctx,DIGEST_B};',filename);
const {prepareRoot,FakeProcessAdapter,ctx,DIGEST_B}=fixtureModule.exports;
const {NodeFilesystemAdapter}=require(path.join(repo,'setup/dist/src/adapters/filesystem.js'));
const {createConfigurationStage}=require(path.join(repo,'setup/dist/src/stages/configuration.js'));
(async()=>{
 const {config,codexPath}=await prepareRoot();const proc=new FakeProcessAdapter(codexPath,'0.32.0',DIGEST_B,'a'.repeat(64));
 const base=new NodeFilesystemAdapter(),counted=Object.create(base);let writes=[];
 counted.writeText=async(p,s,mode)=>{writes.push(p);return base.writeText(p,s,mode);};
 const stage=createConfigurationStage(counted,proc);
 await stage.apply(ctx(config),stage.plan(config,await stage.observe(ctx(config))));
 const observed=await stage.observe(ctx(config));assert.equal(observed.status,'verified');
 const empty=stage.plan(config,observed);assert.equal(empty.operations.length,0);assert.equal(empty.requiredGates.length,0);
 writes=[];let directError;
 try {await stage.apply(ctx(config),empty);}catch(e){directError=e;}
 assert.equal(directError,undefined);
 const {SetupEngine}=require(path.join(repo,'setup/dist/src/core/engine.js'));
 const {createRegistry}=require(path.join(repo,'setup/dist/src/core/plan.js'));
 const s05={id:'S05',dependencies:[],supportedProfiles:['supervised','service'],optional:false,requiredCapabilities:[],
 observe:async()=>({stageId:'S05',status:'verified',checks:{},versions:{},observedAt:'2026-10-23T10:00:00.000Z'}),
 plan:()=>({stageId:'S05',optional:false,requiredCapabilities:[],operations:[],requiredGates:[]}),apply:async()=>[],verify:async()=>[],recover:async()=>[]};
 const configPath=path.join(path.dirname(config.version_lock_path),'setup.json');await fs.promises.writeFile(configPath,JSON.stringify(config));
 proc.bootId=async()=> 'f324dcd7-4035-4430-ab39-ce31f9e396bf';
 const engine=new SetupEngine({fsAdapter:counted,processAdapter:proc,clock:{now:()=>new Date('2026-10-23T10:00:00Z')}},createRegistry([s05,stage]));
 const p=await engine.run('plan',{configPath});assert.equal(p.exitCode,0,JSON.stringify(p));
 const a=await engine.run('apply',{configPath,planPath:path.join(config.paths.setup_state_dir,'plan.json')});
 assert.equal(a.exitCode,0,JSON.stringify(a));
 console.log(JSON.stringify({id:'P05_real_S06_empty_plan_fixed',passed:true,observed_status:observed.status,planned_operations:0,required_gates:0,direct_apply_exit:0,engine_plan_exit:p.exitCode,engine_apply_exit:a.exitCode,error:a.envelope.error?.code??null,real_commands:0,scope:'actual S06 module and SetupEngine; verified fake S05 prerequisite; fake process adapter'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
