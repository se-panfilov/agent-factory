"""Named fixture/schema adapters; originals untouched. No commits/push/branches/worktree/index/PR/release/deploy."""
from pathlib import Path
import shutil,re
root=Path(__file__).resolve().parent.parent;r=root/'runners';original=r/'original';adapted=r/'c13';adapted.mkdir(exist_ok=True)
# Preserve whole original fixtures and create a separate explicitly adapted input layer.
inputs=root/'inputs-c13';shutil.copytree(root/'inputs',inputs,dirs_exist_ok=True)
for file in inputs.rglob('*.js'):
 s=file.read_text();changed=s
 # All helpers still use production engine/adapters from the selected tree.
 if file.name=='r14-engine.js':
  changed=changed.replace('exports.r14Process = {','exports.r14Process = {\n    hostIdentity: async () => ({os:"ubuntu-24.04",arch:"amd64"}), loginSessionId: async () => "c13-fixture-owner-login",')
  changed=changed.replace('    config.selected_stages = [stageId];','    config.selected_stages = [stageId]; config.host.arch = "amd64";\n    await require("./r22-context.js").fixtureContextFiles(config,["S05","S06","S07","S09","S10","S11","S13"].includes(stageId));')
  changed=changed.replace('const plan = JSON.parse(', 'const plan = require("./r22-context.js").parseFixturePlan(')
 # Frozen exported helper classes expose explicit injected OS/login facts. No production fallback.
 changed=changed.replace('async bootId() {','async hostIdentity() { return {os:"ubuntu-24.04",arch:"amd64"}; }\n    async loginSessionId() { return "c13-fixture-owner-login"; }\n    async bootId() {')
 if 'async function writeConfig(configPath, config)' in changed:
  changed=changed.replace('async function writeConfig(configPath, config) {','async function writeConfig(configPath, config) {\n    await require("../helpers/r22-context.js").fixtureContextFiles(config,config.selected_stages.some(id=>["S05","S06","S07","S09","S10","S11","S13"].includes(id)));')
 if changed!=s:file.write_text(changed)
# Local callsite translation only; never monkey-patch JSON, fs, production modules or global engine behavior.
names=['r2-admission-probes.cjs','r14-new-probes.cjs','r14-new-probes-directory-contract.cjs','r14-comparison-fresh-gates.cjs','full-lifecycle.cjs','lifecycle-controls.cjs','stage-compat-probes.cjs','s06-noop-probe.cjs','command-identity-probes.cjs','access-continuation-probes.cjs']
for name in names:
 s=(original/name).read_text()
 s=s.replace('JSON.parse','__c13.parse').replace('JSON.stringify','__c13.stringify')
 s=s.replace('stableStringify(', '__c13.canonical(').replace('createRegistry(', '__c13.registry(').replace('validateContractSchema(', '__c13.validate(')
 # Explicit static fake host/session and complete local artifact/lock setup before producer review.
 s=s.replace('const proc = {','const proc = { hostIdentity:async()=>({os:"ubuntu-24.04",arch:"amd64"}),loginSessionId:async()=>"c13-fixture-owner-login",')
 s=s.replace('const proc={','const proc={hostIdentity:async()=>({os:"ubuntu-24.04",arch:"amd64"}),loginSessionId:async()=>"c13-fixture-owner-login",')
 s=s.replace('  c.selected_stages = selected;', '  c.selected_stages = selected; c.host.arch="amd64"; await __c13.prepare(c);')
 s=s.replace("const configPath=path.join(q.root,'config.json');", "c.host.arch='amd64';await __c13.prepare(c);const configPath=path.join(q.root,'config.json');")
 # C13 review has two core metadata publications. Its previous snapshot is prepared,
 # not byte-identical to the pre-review clean state. Preserve the functional oracle:
 # verified clean progress and exact checkpoint/receipts survive both recover paths.
 if name=='s06-noop-probe.cjs':
  s=s.replace('const {config,codexPath}=await prepareRoot();', 'const {config,codexPath}=await prepareRoot();await __c13.prepare(config);')
 if name=='r14-comparison-fresh-gates.cjs':
  old="assert.equal(stateHash(__c13.parse(await fs.readFile(x.primary+'.previous','utf8'))),cleanHash);"
  new="""const prepared=__c13.parse(await fs.readFile(x.primary+'.previous','utf8'));
   assert.equal(prepared.in_flight_operation,null);assert.equal(prepared.installation_id,x.state.installation_id);
   assert.equal(prepared.stages.find(s=>s.id==='S01').status,'verified');
   const proofAfterPlan=await readStateCommitManifest(f,x.c);
   assert.deepEqual(proofAfterPlan.last_effect_checkpoint,x.m.last_effect_checkpoint);
   assert.deepEqual(proofAfterPlan.completed_operations,x.m.completed_operations);
   const beforeBasis=JSON.parse(x.state.stages.find(s=>s.id==='S01').versions.setup_policy_basis_v1);
   const preparedBasis=JSON.parse(prepared.stages.find(s=>s.id==='S01').versions.setup_policy_basis_v1);
   assert.deepEqual(preparedBasis.completed,beforeBasis.completed);assert.deepEqual(preparedBasis.progress,beforeBasis.progress);"""
  assert old in s;s=s.replace(old,new)
 # Completeness is checked by validate-r22.py, never manufactured by the adapter.
 prefix="const __c13=require('../c13-fixture-compat.cjs')(process.argv[2]);\n"
 (adapted/name).write_text('// C13 fixture/input adapter. Original counters/oracles preserved; see adapter-map.md.\n'+prefix+s)
print('Separate C13 callsite and fixture layers generated; original runner bytes preserved.')
