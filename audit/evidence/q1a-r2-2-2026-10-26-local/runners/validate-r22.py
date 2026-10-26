"""R2.2 local-only validation. No commits/push/branches/worktrees/staging/index/PR/merge/tag/release/deploy or host effects."""
import argparse,hashlib,io,json,os,platform,subprocess,tarfile,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--fixed',required=True,type=Path);p.add_argument('--bundle',required=True,type=Path);p.add_argument('--work',required=True,type=Path);p.add_argument('--independent-only',action='store_true');a=p.parse_args()
repo=a.repo.resolve();fixed=a.fixed.resolve();b=a.bundle.resolve();work=a.work.resolve();work.mkdir(parents=True,exist_ok=True);logs=b/'logs';logs.mkdir(exist_ok=True);r=b/'runners';rows=[];env={**os.environ,'GIT_OPTIONAL_LOCKS':'0','TMPDIR':'/private/tmp' if platform.system()=='Darwin' else '/tmp'}
def run(name,argv,cwd=fixed,expect=0,timeout=600):
 argv=list(map(str,argv));start=time.monotonic();dest=logs/name;dest.parent.mkdir(parents=True,exist_ok=True)
 with dest.open('w') as f:
  try: result=subprocess.run(argv,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=timeout);rc=result.returncode
  except subprocess.TimeoutExpired:rc=124
 rows.append({'argv':argv,'cwd':str(cwd),'exit_code':rc,'expected_exit':expect,'elapsed_seconds':round(time.monotonic()-start,3),'log':str(dest.relative_to(b))});(logs/'commands.json').write_text(json.dumps(rows,indent=2)+'\n');assert rc==expect,(name,rc,expect)
def hashes():
 result={}
 for line in (b/'tested-files.sha256').read_text().splitlines():
  digest,name=line.split('  ',1);value=hashlib.sha256((fixed/name).read_bytes()).hexdigest();assert value==digest,name;result[name]=value
 return result
if not a.independent_only:
 before=hashes();(logs/'hashes-before.json').write_text(json.dumps(before,indent=2)+'\n')
 for name,argv in [('node.log',['node','--version']),('npm.log',['npm','--version']),('final-ci.log',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund']),('final-typecheck.log',['npm','--prefix','setup','run','typecheck','--silent']),('final-test.log',['npm','--prefix','setup','run','test','--silent'])]:run(name,argv)
 assert (logs/'node.log').read_text().startswith('v24.')
 (logs/'environment.json').write_text(json.dumps({'node':(logs/'node.log').read_text().strip(),'npm':(logs/'npm.log').read_text().strip(),'os':platform.platform(),'arch':platform.machine(),'uid':os.getuid(),'injected_owner':1000,'real_host_qualification':'NOT RUN'},indent=2)+'\n')
def archive(sha,name):
 tree=work/name;assert not tree.exists(),tree;tree.mkdir()
 data=subprocess.check_output(['git','archive',sha],cwd=repo,env=env)
 with tarfile.open(fileobj=io.BytesIO(data)) as t:t.extractall(tree,filter='data')
 run(name+'-ci.log',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund'],tree)
 run(name+'-build.log',['npm','--prefix','setup','run','build','--silent'],tree)
 return tree
base=archive('f12791cf8416fc115d45246f0531ce103fa5e2e8','context-baseline')
run('context-baseline.jsonl',['node',r/'original/context-binding-probes.cjs',base]);run('context-baseline-desired.json',['python3',r/'original/check-context-binding.py',logs/'context-baseline.jsonl','--expect','fixed'],expect=1)
run('context-baseline-observed.json',['python3',r/'original/check-context-binding.py',logs/'context-baseline.jsonl','--expect','observed-current'])
run('context-fixed.jsonl',['node',r/'context-binding-c13.cjs',fixed]);run('context-fixed-desired.json',['python3',r/'original/check-context-binding.py',logs/'context-fixed.jsonl','--expect','fixed'])
run('access-fixed.jsonl',['node',r/'original/access-continuation-probes.cjs',fixed]);run('access-fixed-oracle.json',['python3',r/'original/check-access-continuation.py',logs/'access-fixed.jsonl','--expect','fixed'])
legacy=archive('6281df5796ec5dd82a6fee95b058bbc970f0ed16','access-v1-baseline')
run('access-legacy.jsonl',['node',r/'legacy-to-c13-explicit-review.cjs',legacy,fixed]);run('access-legacy-oracle.json',['python3',r/'original/check-access-continuation.py',logs/'access-legacy.jsonl','--expect','fixed'])
run('access-v2-legacy.jsonl',['node',r/'legacy-to-c13-explicit-review.cjs',base,fixed]);run('access-v2-legacy-oracle.json',['python3',r/'original/check-access-continuation.py',logs/'access-v2-legacy.jsonl','--expect','fixed'])
run('access-final-known-red.log',['node',r/'original/access-final-recovery.cjs',fixed],expect=1)
run('access-final-explicit-review.jsonl',['node',r/'original/access-final-recovery-measurements.cjs',fixed])
r2=archive('ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff','r2-baseline');command=archive('b888082167b5edc50977a6dcda997b40e962da8d','command-baseline')
c=logs/'comparisons';c.mkdir(exist_ok=True)
for label,tree in [('baseline',r2),('fixed',fixed)]:run('comparisons/'+label+'-r2-final.log',['node',r/('original' if label=='baseline' else 'c13')/'r2-admission-probes.cjs',tree])
for label,tree in [('baseline',command),('fixed',fixed)]:
 for mode in ['adapter','stage']:run(f'comparisons/{label}-{mode}-final.jsonl',['node',r/'original/command-identity-probes.cjs',tree,mode])
for name,runner,inputs in [('new-probes','r14-new-probes.cjs','frozen-r14-fixtures'),('new-probes-adapted','r14-new-probes-directory-contract.cjs','frozen-r14-fixtures'),('comparison','r14-comparison-fresh-gates.cjs','input-r14/frozen-fixtures'),('full-lifecycle','full-lifecycle.cjs','input-r14/frozen-fixtures'),('lifecycle-controls','lifecycle-controls.cjs','input-r14/frozen-fixtures'),('s06-noop','s06-noop-probe.cjs','input-r14/frozen-fixtures'),('stage-compat','stage-compat-probes.cjs','input-r14/frozen-fixtures')]:run('comparisons/frozen/fixed-'+name+'.jsonl',['node',r/'c13'/runner,fixed,b/'inputs-c13'/inputs])
run('comparisons/comparison-assertions.json',['python3',r/'original/check-results.py',c/'frozen']);run('comparisons/command-assertions.json',['python3',r/'original/check-r16.py',c]);run('comparisons/r2-product-assertions.json',['python3',r/'original/check-r21.py',c])
# Completeness is independent of process exit and per-case harness_ok.
def jsonrows(name):return [json.loads(line) for line in (logs/name).read_text().splitlines() if line.strip()]
for name,n in [('context-baseline.jsonl',6),('context-fixed.jsonl',6),('access-fixed.jsonl',14),('access-legacy.jsonl',14),('access-v2-legacy.jsonl',14),('comparisons/baseline-r2-final.log',9),('comparisons/fixed-r2-final.log',9),('comparisons/frozen/fixed-comparison.jsonl',13)]:
 data=jsonrows(name);assert len(data)==n and data[-1]['id']=='META',(name,'incomplete',len(data))
for label in ['baseline','fixed']:
 for mode in ['adapter','stage']:
  data=jsonrows(f'comparisons/{label}-{mode}-final.jsonl');assert len(data)==5 and data[-1]['id']=='META' and data[-1]['cases']==4
for name in ['new-probes','new-probes-adapted']:
 data=jsonrows('comparisons/frozen/fixed-'+name+'.jsonl');assert len(data)==7 and data[-1]['id']=='META' and data[-1]['cases']==6
recovery=jsonrows('access-final-explicit-review.jsonl');assert len(recovery)==2 and all(x['resume']!=0 and x['explicit_review_resume']==0 and x['before']==x['after'] and x['checkpoint_retained'] for x in recovery)
for name in ['full-lifecycle','lifecycle-controls','s06-noop','stage-compat']:
 data=jsonrows('comparisons/frozen/fixed-'+name+'.jsonl');assert data and all(x.get('harness_ok',True) and x.get('acceptance',True) and x.get('passed',True) and (x.get('status','PASS') in ['PASS',0]) for x in data),(name,data)
if not a.independent_only:
 after=hashes();assert before==after;(logs/'hashes-after.json').write_text(json.dumps(after,indent=2)+'\n')
print('Complete context5/5; original S03 13/13; genuine legacy explicit review13/13; frozen33/command37/R2checker39; final recovery known red and explicit workaround. No overlap counts summed.')
