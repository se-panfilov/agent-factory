"""Final exact source, runner, suite and matrix audit.
No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy.
"""
import sys,json,hashlib,re,importlib.util
from pathlib import Path
b=Path(sys.argv[1]);tree=Path(sys.argv[2]);repo=Path(sys.argv[3]);logs=b/'inherited/logs';ledger=json.loads((logs/'commands.json').read_text());text=(logs/'test.stdout').read_text()
for k,n in [('tests',645),('pass',645),('fail',0),('cancelled',0),('skipped',0),('todo',0)]:assert re.search(r'^[ℹ#] '+k+' '+str(n)+'$',text,re.M),(k,n)
for prefix,file,n in [('R3','r3-test-contract.json',74),('R31','r31-test-contract.json',56)]:
 c=json.loads((b/'runners'/file).read_text());actual=re.findall(r'^✔ ('+prefix+r' .+) \([\d.]+ms\)$',text,re.M)
 assert actual==c['ids'] and len(set(actual))==n,(prefix,len(actual))
assert all(x['exit_code']==x['expected_exit'] for x in ledger)
assert json.loads((logs/'replay-verdict.json').read_text())['status']=='COMPLETE'
assert json.loads((logs/'current-callers.stdout').read_text())['count']==22
assert json.loads((logs/'r31-oracle.stdout').read_text())['desired_pass']==14
assert json.loads((logs/'r31-outcomes.stdout').read_text())['pass']==14
before=json.loads((logs/'hashes-before.json').read_text());after=json.loads((logs/'hashes-after.json').read_text());assert before==after
for n,d in before.items():assert hashlib.sha256((tree/n).read_bytes()).hexdigest()==d and hashlib.sha256((repo/n).read_bytes()).hexdigest()==d,n
print(json.dumps(dict(suite=645,new_R31_tests=56,preserved_R3_tests=74,exact_source_runner_inputs=len(before),all_ledger_exits_expected=True,no_splicing=True,historical_O02='OPEN',root_isolated_environment='NOT RUN'),indent=2))
