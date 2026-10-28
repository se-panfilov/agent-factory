"""Run frozen independent measurements; exit status is harness status, not product acceptance."""
import argparse,subprocess,json,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--fixed',required=True);p.add_argument('--inputs',required=True);p.add_argument('--logs',required=True);a=p.parse_args();r=Path(__file__).resolve().parent;logs=Path(a.logs);logs.mkdir(parents=True,exist_ok=True);inputs=Path(a.inputs).resolve();rows=[]
assert subprocess.check_output(['node','--version'],text=True).startswith('v24.')
for label,checkout in [('baseline',a.baseline),('fixed',a.fixed)]:
 checkout=str(Path(checkout).resolve())
 cases=[('new-probes','r14-new-probes.cjs',inputs/'frozen-r14-fixtures'),('new-probes-adapted','r14-new-probes-directory-contract.cjs',inputs/'frozen-r14-fixtures'),('comparison','r14-comparison-fresh-gates.cjs',inputs/'input-r14/frozen-fixtures')]
 if label=='fixed':cases += [(n,f,inputs/'input-r14/frozen-fixtures') for n,f in [('full-lifecycle','full-lifecycle.cjs'),('lifecycle-controls','lifecycle-controls.cjs'),('s06-noop','s06-noop-probe.cjs'),('stage-compat','stage-compat-probes.cjs')]]
 for name,runner,fixture in cases:
  argv=['node',str(r/runner),checkout,str(fixture)];start=time.time()
  with open(logs/f'{label}-{name}.jsonl','wb') as f:
   try:rc=subprocess.run(argv,stdout=f,stderr=subprocess.STDOUT,timeout=60).returncode
   except subprocess.TimeoutExpired:rc=124
  rows.append({'argv':argv,'exit_code':rc,'elapsed_seconds':round(time.time()-start,3),'log':f'{label}-{name}.jsonl'});(logs/'independent-commands.json').write_text(json.dumps(rows,indent=2)+'\n')
  if rc:raise SystemExit(rc)
