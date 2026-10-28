"""Separate complete-matrix baseline/product oracle; no mutations or external commands."""
import argparse,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('--mode',choices=['baseline','desired'],required=True);a=p.parse_args()
rows=[json.loads(x) for x in a.file.read_text().splitlines() if x.strip()]
ids=['B01-argv-control','B02-output-budget','B03-owned-tree-term','B04-explicit-preload-env','B05-ambient-env-control']
assert [r['id'] for r in rows]==ids+['META']
assert len(set(r['id'] for r in rows))==6
assert rows[-1]['cases']==5 and rows[-1]['real_privileged_commands']==0 and rows[-1]['external_network_calls']==0
x=rows[0];assert x['returned']['exitCode']==0
pred=[json.loads(x['returned']['stdout'])==x['expected_args']]
x=rows[1];pred.append(x['stdout_bytes']+x['stderr_bytes']<=x['limit'] and (bool(x.get('rejected')) or x['returned'].get('outputLimitExceeded') is True))
assert x['stdout_bytes']==len(x.get('returned',{}).get('stdout','').encode()) and x['stderr_bytes']==len(x.get('returned',{}).get('stderr','').encode())
x=rows[2];assert x['grandchild_started'] and x['final_grandchild_state'] in ['absent','Z']
pred.append(not x['grandchild_effect_after_deadline'] and (bool(x.get('rejected')) or x['returned']['timedOut'] is True))
x=rows[3];pred.append(not x['preload_executed'])
x=rows[4];observed=json.loads(x['returned']['stdout']);assert observed==x['observed']
pred.append(x['returned']['exitCode']==0 and not observed['ambient'] and observed['path']=='/usr/bin:/bin:/usr/sbin:/sbin' and observed['locale']=='C')
assert [r['desired_pass'] for r in rows[:-1]]==pred
assert rows[-1]['desired_pass']==sum(pred) and rows[-1]['desired_fail']==5-sum(pred)
if a.mode=='baseline':assert pred==[True,False,False,False,True]
print(json.dumps({'mode':a.mode,'complete_cases':5,'desired_pass':sum(pred),'desired_fail':5-sum(pred),'rows':[{'id':i,'desired_pass':v} for i,v in zip(ids,pred)],'verdict':'BASELINE_CONFIRMED' if a.mode=='baseline' else 'PASS' if all(pred) else 'FAIL'},indent=2))
raise SystemExit(0 if a.mode=='baseline' or all(pred) else 1)
