"""Final exact-source/completion check. No commits/push/branches/worktree/PR/index/merge/tag/release/deploy."""
import sys,json,re,hashlib
from pathlib import Path
b=Path(sys.argv[1]);snapshot=Path(sys.argv[2]);repo=Path(sys.argv[3]);text=(b/'inherited/logs/test.stdout').read_text();contract=json.loads((b/'runners/r3-test-contract.json').read_text())
for name,value in [('tests',589),('pass',589),('fail',0),('cancelled',0),('skipped',0),('todo',0)]:
 assert re.search(r'^[ℹ#] '+name+r' '+str(value)+r'$',text,re.M),(name,value)
actual=re.findall(r'^✔ (R3 .+) \([\d.]+ms\)$',text,re.M)
assert actual==contract['ids'] and len(set(actual))==contract['cases'],(len(actual),contract['cases'])
source=[]
for line in (b/'inherited/tested-files.sha256').read_text().splitlines():
 digest,n=line.split('  ',1)
 assert hashlib.sha256((snapshot/n).read_bytes()).hexdigest()==digest,n
 assert hashlib.sha256((repo/n).read_bytes()).hexdigest()==digest,n
 source.append(n)
runner=[]
for line in (b/'runner-inputs-before.sha256').read_text().splitlines():
 digest,n=line.split('  ',1);assert hashlib.sha256((repo/n).read_bytes()).hexdigest()==digest,n;runner.append(n)
print(json.dumps({'suite':589,'pass':589,'fail':0,'cancelled':0,'skipped':0,'todo':0,'R3_ordered_unique':len(actual),'snapshot_equals_current_source':len(source),'runner_inputs_unchanged':len(runner),'O02':'cause OPEN; a complete run does not prove runtime cause fixed'},indent=2))
