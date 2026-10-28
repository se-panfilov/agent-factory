"""Local-only R2.1.1 validation. Never commit/push/create branches/worktrees/PR/release/deploy or touch the index."""
import argparse,hashlib,io,json,os,platform,subprocess,tarfile,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--fixed',required=True,type=Path);p.add_argument('--baseline',required=True,type=Path);p.add_argument('--bundle',required=True,type=Path);p.add_argument('--work',required=True,type=Path);a=p.parse_args()
repo=a.repo.resolve();fixed=a.fixed.resolve();baseline=a.baseline.resolve();bundle=a.bundle.resolve();work=a.work.resolve();logs=bundle/'logs';logs.mkdir(exist_ok=True);rows=[];env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'};r=bundle/'runners'
def run(name,argv,cwd=fixed,expect=0):
 start=time.monotonic();argv=list(map(str,argv));dest=logs/name;dest.parent.mkdir(parents=True,exist_ok=True)
 with dest.open('w') as f:res=subprocess.run(argv,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=420)
 rows.append({'argv':argv,'cwd':str(cwd),'exit_code':res.returncode,'expected_exit':expect,'elapsed_seconds':round(time.monotonic()-start,3),'log':str(dest.relative_to(bundle))});(logs/'commands.json').write_text(json.dumps(rows,indent=2)+'\n')
 assert res.returncode==expect,(name,res.returncode,expect)
def hashes():
 result={}
 for line in (bundle/'tested-files.sha256').read_text().splitlines():
  digest,name=line.split('  ',1);actual=hashlib.sha256((fixed/name).read_bytes()).hexdigest();assert actual==digest,name;result[name]=actual
 return result
before=hashes();(logs/'hashes-before.json').write_text(json.dumps(before,indent=2)+'\n')
assert subprocess.check_output(['node','--version'],env=env,text=True).startswith('v24.')
run('node.log',['node','--version']);run('npm.log',['npm','--version'])
(logs/'environment.json').write_text(json.dumps({'node':subprocess.check_output(['node','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip(),'os':platform.platform(),'arch':platform.machine(),'uid':os.getuid(),'host_qualification':'NOT RUN'},indent=2)+'\n')
run('final-ci.log',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund'])
run('final-typecheck.log',['npm','--prefix','setup','run','typecheck','--silent'])
run('final-test.log',['npm','--prefix','setup','run','test','--silent'])
for label,tree in [('access-baseline',baseline)]:
 run(label+'-ci.log',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund'],tree)
 run(label+'-build.log',['npm','--prefix','setup','run','build','--silent'],tree)
for label,tree in [('access-baseline',baseline),('access-fixed',fixed)]:
 run(label+'.jsonl',['node',r/'access-continuation-probes.cjs',tree])
 run(label+'-oracle.json',['python3',r/'check-access-continuation.py',logs/(label+'.jsonl'),'--expect','fixed'],expect=1 if label=='access-baseline' else 0)
run('access-baseline-observed.json',['python3',r/'check-access-continuation.py',logs/'access-baseline.jsonl','--expect','observed-r21'])
run('access-legacy.jsonl',['node',r/'access-legacy-transition.cjs',baseline,fixed])
run('access-legacy-oracle.json',['python3',r/'check-access-continuation.py',logs/'access-legacy.jsonl','--expect','fixed'])
def archive(sha,name):
 tree=work/name;assert not tree.exists();tree.mkdir(parents=True)
 data=subprocess.check_output(['git','archive',sha],cwd=repo,env=env)
 with tarfile.open(fileobj=io.BytesIO(data)) as t:t.extractall(tree,filter='data')
 run(name+'-ci.log',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund'],tree)
 run(name+'-build.log',['npm','--prefix','setup','run','build','--silent'],tree)
 return tree
r2=archive('ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff','r2-baseline')
command=archive('b888082167b5edc50977a6dcda997b40e962da8d','command-baseline')
run('independent-comparisons.log',['python3',r/'measure-r21.py','--baseline',r2,'--fixed',fixed,'--historical-command-baseline',command,'--inputs',bundle/'inputs','--logs',logs/'comparisons'])
after=hashes();assert before==after;(logs/'hashes-after.json').write_text(json.dumps(after,indent=2)+'\n')
print('Reconstructed source validated; unchanged manifest; S03 baseline red/fixed green and frozen comparisons complete.')
