"""Finish independent matrices after an explicitly preserved incomplete run; never silently retry. No commits/push/branches/worktrees/index/PR/release/deploy."""
import argparse,json,os,subprocess,time,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--bundle',required=True,type=Path);p.add_argument('--fixed',required=True,type=Path);p.add_argument('--remaining-only',action='store_true');a=p.parse_args();b=a.bundle.resolve();r=b/'runners';logs=b/'logs';fixed=a.fixed.resolve();rows=json.loads((logs/'commands.json').read_text());env={**os.environ,'TMPDIR':'/private/tmp' if os.uname().sysname=='Darwin' else '/tmp'}
def run(name,argv,stderr=None):
 argv=list(map(str,argv));start=time.monotonic()
 with (logs/name).open('w') as out:
  if stderr:
   with (logs/stderr).open('w') as err:res=subprocess.run(argv,cwd=fixed,env=env,stdout=out,stderr=err,timeout=150)
  else:res=subprocess.run(argv,cwd=fixed,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=150)
 rows.append({'argv':argv,'cwd':str(fixed),'exit_code':res.returncode,'expected_exit':0,'elapsed_seconds':round(time.monotonic()-start,3),'log':'logs/'+name,'stderr':stderr});(logs/'commands.json').write_text(json.dumps(rows,indent=2)+'\n');assert res.returncode==0,(name,res.returncode)
# Diagnostic preload only records owned FS phases; original counters/product oracle unchanged.
if not a.remaining_only:run('comparisons/frozen/fixed-comparison.jsonl',['node','--require',r/'trace-owned-fs.cjs',r/'c13/r14-comparison-fresh-gates.cjs',fixed,b/'inputs-c13/input-r14/frozen-fixtures'],'comparisons/frozen/fixed-comparison-fs-trace.jsonl')
for name,runner in ([('s06-noop','s06-noop-probe.cjs'),('stage-compat','stage-compat-probes.cjs')] if a.remaining_only else [('full-lifecycle','full-lifecycle.cjs'),('lifecycle-controls','lifecycle-controls.cjs'),('s06-noop','s06-noop-probe.cjs'),('stage-compat','stage-compat-probes.cjs')]):run('comparisons/frozen/fixed-'+name+'.jsonl',['node',r/'c13'/runner,fixed,b/'inputs-c13/input-r14/frozen-fixtures'])
c=logs/'comparisons'
for name,checker,target in [('comparison-assertions.json','check-results.py',c/'frozen'),('command-assertions.json','check-r16.py',c),('r2-product-assertions.json','check-r21.py',c)]:run('comparisons/'+name,['python3',r/'original'/checker,target])
run('completeness.json',['python3',r/'check-completeness-r22.py',b,fixed])
print('Remaining product assertions complete. Prior incomplete run retained; instrumentation is not a stability fix. R211-O02 cause OPEN.')
