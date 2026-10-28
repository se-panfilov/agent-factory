"""Separate measurement and desired-product oracles. No edits to the input runner."""
import argparse, json, pathlib
p=argparse.ArgumentParser(); p.add_argument('log',type=pathlib.Path); p.add_argument('--expect',choices=['observed-current','fixed'],required=True); a=p.parse_args()
rows=[json.loads(l) for l in a.log.read_text().splitlines() if l.strip()]
assert rows[-1]['id']=='META' and rows[-1]['cases']==5 and len(rows)==6
results=[]
for r in rows[:-1]:
    assert r['real_privileged_or_network_commands']==0 and r['submitted_plan_unchanged'] and r['config_unchanged']
    desired=r['acceptance']
    observed=(r['exit']==0 and r['counts']=={'refresh':1,'simulate':1,'install':1}) if r['id'].startswith(('B02','B03','B04')) else desired
    results.append({'id':r['id'],'desired_acceptance':desired,'oracle_acceptance':desired if a.expect=='fixed' else observed})
print(json.dumps({'expect':a.expect,'cases':results,'pass':sum(r['oracle_acceptance'] for r in results),'fail':sum(not r['oracle_acceptance'] for r in results)},indent=2))
raise SystemExit(0 if all(r['oracle_acceptance'] for r in results) else 1)
