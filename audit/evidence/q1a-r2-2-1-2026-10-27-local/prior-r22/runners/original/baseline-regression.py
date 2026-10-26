"""Apply only compiled new test layer to an ordinary baseline copy. No commits/push/branches/worktrees/index/PR/release/deploy."""
import argparse,json,shutil,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',required=True,type=Path);p.add_argument('--fixed',required=True,type=Path);p.add_argument('--output',required=True,type=Path);p.add_argument('--logs',required=True,type=Path);a=p.parse_args()
assert not a.output.exists();a.logs.mkdir(parents=True,exist_ok=True)
shutil.copytree(a.baseline/'setup',a.output/'setup')
for name in ['tests/helpers/r211-access.js','tests/helpers/r211-child.js','tests/integration/q1a-r211-access.test.js']:
 target=a.output/'setup/dist'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.fixed/'setup/dist'/name,target)
argv=['node','--test','--test-name-pattern=A211-02/03/04 actual S03',str((a.output/'setup/dist/tests/integration/q1a-r211-access.test.js').resolve())]
start=time.monotonic()
with (a.logs/'baseline-regression-red.log').open('w') as stream:result=subprocess.run(argv,stdout=stream,stderr=subprocess.STDOUT,cwd=a.output,timeout=120)
body=(a.logs/'baseline-regression-red.log').read_text()
assert result.returncode==1 and 's03_observation_drifted' in body and 'install: 2' in body and 'fail 2' in body
(a.logs/'baseline-regression-red-command.json').write_text(json.dumps({'argv':argv,'cwd':str(a.output.resolve()),'exit_code':result.returncode,'expected_exit':1,'elapsed_seconds':round(time.monotonic()-start,3),'classification':'meaningful product red: false drift and observed install replay; no harness/setup failure','baseline_production':'unchanged compiled baseline; only new tests/helpers overlaid'},indent=2)+'\n')
