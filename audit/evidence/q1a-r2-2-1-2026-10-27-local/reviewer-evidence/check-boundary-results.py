"""Fail closed on incomplete reviewer matrices; separate desired acceptance from observed defects."""
import argparse,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('evidence',type=Path);p.add_argument('--expect',choices=['fixed','observed-current'],default='fixed');a=p.parse_args()
expected={
 'context-boundary-probes.jsonl': [f'gate-after-probe-{k}-{m}' for k in ['lock','config','plan'] for m in ['control','fault']]+[f'effect-during-final-context-{k}-{m}' for k in ['config','plan'] for m in ['control','fault']],
 'release-boundary-probes.jsonl': ['release-final-hash-lock-control']+[f'release-final-hash-{k}-fault' for k in ['lock','config','plan']]
}
out=[]
for filename,ids in expected.items():
 rows=[json.loads(x) for x in (a.evidence/filename).read_text().splitlines() if x.strip()]
 assert len(rows)==len(ids)+1 and rows[-1]['id']=='META' and rows[-1]['cases']==len(ids),(filename,'incomplete')
 assert [x['id'] for x in rows[:-1]]==ids,(filename,'wrong/duplicate cases')
 assert rows[-1]['real_commands']==0
 for r in rows[:-1]:
  assert r['hits']==1,(r['id'],'barrier not reached')
  safe=r['expected_safe']
  if a.expect=='fixed': accepted=safe
  elif not r['fault']: accepted=safe
  elif r['id'].startswith('gate-'): accepted=r['result']['exit']==0 and r['gate']['status']=='approved' and not r['evidence_unchanged'] and all(n==0 for n in r['counts'].values())
  elif r['id'].startswith('effect-'): accepted=r['result']=={'exit':8,'code':'request_changed_after_read'} and r['counts']=={'refresh':1,'simulate':0,'install':0} and any(x['code']=='checkpoint' for x in r['journal'])
  else: accepted=r['result']['exit']==8 and r['extracts']==1 and r['materialize']==0 and r['probes']==0 and any(x['code']=='checkpoint' for x in r['journal'])
  out.append({'id':r['id'],'desired_acceptance':safe,'oracle_acceptance':accepted})
result={'expect':a.expect,'complete':True,'cases':len(out),'desired_pass':sum(x['desired_acceptance'] for x in out),'desired_fail':sum(not x['desired_acceptance'] for x in out),'oracle_pass':sum(x['oracle_acceptance'] for x in out),'rows':out}
print(json.dumps(result,indent=2));raise SystemExit(0 if all(x['oracle_acceptance'] for x in out) else 1)
