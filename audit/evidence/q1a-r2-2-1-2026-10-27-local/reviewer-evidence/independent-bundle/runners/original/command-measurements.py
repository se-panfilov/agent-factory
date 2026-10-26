"""Measure unchanged original audit runner on baseline/fixed; inspect product assertions separately."""
import argparse,pathlib,subprocess,json
p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--fixed',required=True);p.add_argument('--logs',required=True);a=p.parse_args();r=pathlib.Path(__file__).resolve().parent;o=pathlib.Path(a.logs);o.mkdir(parents=True,exist_ok=True);rows=[]
assert subprocess.check_output(['node','--version'],text=True).startswith('v24.')
for label,checkout in [('baseline',a.baseline),('fixed',a.fixed)]:
 for mode in ['adapter','stage']:
  argv=['node',str(r/'command-identity-probes.cjs'),str(pathlib.Path(checkout).resolve()),mode];log=f'{label}-{mode}-final.jsonl'
  with (o/log).open('w') as f:result=subprocess.run(argv,stdout=f,stderr=subprocess.STDOUT,timeout=45)
  rows.append({'argv':argv,'exit_code':result.returncode,'log':log});(o/'audit-harness-commands.json').write_text(json.dumps(rows,indent=2)+'\n');assert result.returncode==0
