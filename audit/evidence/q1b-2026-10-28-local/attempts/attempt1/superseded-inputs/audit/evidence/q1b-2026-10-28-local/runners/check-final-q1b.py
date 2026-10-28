"""Current dynamic environment/roster/complete ledger checker. Historical checker remains unchanged.
No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy.
"""
import sys,json,hashlib,re
from pathlib import Path
b=Path(sys.argv[1]);tree=Path(sys.argv[2]);repo=Path(sys.argv[3]);logs=b/'inherited/logs'
ledger=json.loads((logs/'commands.json').read_text());text=(logs/'test.stdout').read_text()
actual=re.findall(r'^✔ (.+) \([\d.]+ms\)$',text,re.M)
baseline=json.loads((b/'runners/baseline-test-names.json').read_text())
assert len(baseline)==645 and len(set(baseline))==645
assert [n for n in actual if not n.startswith('Q1B ')]==baseline
new=[n for n in actual if n.startswith('Q1B ')];assert len(new)==50 and len(set(new))==50
for k,n in [('tests',695),('pass',695),('fail',0),('cancelled',0),('skipped',0),('todo',0)]:assert re.search(r'^[ℹ#] '+k+' '+str(n)+'$',text,re.M),(k,n)
for prefix,file,n in [('R3','r3-test-contract.json',74),('R31','r31-test-contract.json',56)]:
 c=json.loads((b/'runners'/file).read_text());found=[n for n in actual if n.startswith(prefix+' ')]
 assert found==c['ids'] and len(set(found))==n
assert all(x['exit_code']==x['expected_exit'] and x['signal'] is None for x in ledger)
assert json.loads((logs/'replay-verdict.json').read_text())['status']=='COMPLETE'
matrices=json.loads((logs/'matrices.json').read_text());assert len(matrices)==22 and all(x['status']=='COMPLETE' for x in matrices)
assert json.loads((logs/'q1b-oracle.stdout').read_text())['desired_pass']==5
assert json.loads((logs/'q1b-cli-oracle.stdout').read_text())['verdict']=='PASS'
before=json.loads((logs/'hashes-before.json').read_text());after=json.loads((logs/'hashes-after.json').read_text());assert before==after
for n,d in before.items():assert hashlib.sha256((tree/n).read_bytes()).hexdigest()==d and hashlib.sha256((repo/n).read_bytes()).hexdigest()==d,n
env=json.loads((logs/'environment.json').read_text());assert env['node'].startswith('v24.') and isinstance(env['uid'],int) and env['injected_owner']==1000
print(json.dumps(dict(suite=695,preserved_baseline_names=645,new_Q1B_tests=50,preserved_R3_tests=74,preserved_R31_tests=56,source_runner_inputs=len(before),command_entries=len(ledger),inherited_matrices=len(matrices),q1b_matrices=2,environment=env,no_splicing=True,historical_O02='OPEN',linux_root_isolated='NOT RUN'),indent=2))
