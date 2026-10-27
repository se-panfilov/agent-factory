"""Portable local measurements; no commits/push/branches/worktree/index/PR/release/deploy."""
import argparse,pathlib,subprocess,json,time
p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--fixed',required=True);p.add_argument('--historical-command-baseline',required=True);p.add_argument('--inputs',required=True);p.add_argument('--logs',required=True);a=p.parse_args();r=pathlib.Path(__file__).resolve().parent;o=pathlib.Path(a.logs).resolve();o.mkdir(parents=True,exist_ok=True);rows=[]
assert subprocess.check_output(['node','--version'],text=True).startswith('v24.')
def run(name,argv):
 start=time.time()
 with (o/name).open('w') as f:res=subprocess.run(argv,stdout=f,stderr=subprocess.STDOUT,timeout=150)
 rows.append({'argv':argv,'exit_code':res.returncode,'elapsed_seconds':round(time.time()-start,3),'log':name});(o/'commands.json').write_text(json.dumps(rows,indent=2)+'\n');assert res.returncode==0,(name,res.returncode)
for label,root in [('baseline',a.baseline),('fixed',a.fixed)]:run(label+'-r2-final.log',['node',str(r/'r2-admission-probes.cjs'),str(pathlib.Path(root).resolve())])
# Historical R1.5 baseline is used only to keep the original R1.6 oracle unchanged.
for label,root in [('baseline',a.historical_command_baseline),('fixed',a.fixed)]:
 for mode in ['adapter','stage']:run(label+'-'+mode+'-final.jsonl',['node',str(r/'command-identity-probes.cjs'),str(pathlib.Path(root).resolve()),mode])
run('frozen-driver.log',['python3',str(r/'run-evidence.py'),'--baseline',str(pathlib.Path(a.baseline).resolve()),'--fixed',str(pathlib.Path(a.fixed).resolve()),'--inputs',str(pathlib.Path(a.inputs).resolve()),'--logs',str(o/'frozen-comparisons')])
run('comparison-assertions.json',['python3',str(r/'check-results.py'),str(o/'frozen-comparisons')])
run('command-assertions.json',['python3',str(r/'check-r16.py'),str(o)])
run('r2-product-assertions.json',['python3',str(r/'check-r21.py'),str(o)])
