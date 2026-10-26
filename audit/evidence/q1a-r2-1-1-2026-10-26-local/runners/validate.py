"""Run final local validation on a temporary reconstruction; no real host effects."""
import argparse,subprocess,pathlib,json,hashlib,time
p=argparse.ArgumentParser();p.add_argument('--checkout',required=True);p.add_argument('--bundle',required=True);p.add_argument('--logs',required=True);a=p.parse_args();r=pathlib.Path(a.checkout).resolve();b=pathlib.Path(a.bundle).resolve();o=pathlib.Path(a.logs);o.mkdir(parents=True,exist_ok=True)
def verify():
 for l in (b/'tested-files.sha256').read_text().splitlines():
  h,n=l.split('  ',1);assert hashlib.sha256((r/n).read_bytes()).hexdigest()==h,n
verify();assert subprocess.check_output(['node','--version'],text=True).startswith('v24.');rows=[]
for name,argv in [('node',['node','--version']),('npm',['npm','--version']),('ci',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund']),('typecheck',['npm','--prefix','setup','run','typecheck','--silent']),('tests',['npm','--prefix','setup','run','test','--silent'])]:
 start=time.time()
 with (o/(name+'.log')).open('w') as f:result=subprocess.run(argv,cwd=r,stdout=f,stderr=subprocess.STDOUT)
 rows.append({'argv':argv,'cwd':str(r),'exit_code':result.returncode,'log':name+'.log','elapsed_seconds':round(time.time()-start,3)});(o/'commands.json').write_text(json.dumps(rows,indent=2)+'\n');assert result.returncode==0
verify();print('All tested manifest hashes unchanged after validation')
