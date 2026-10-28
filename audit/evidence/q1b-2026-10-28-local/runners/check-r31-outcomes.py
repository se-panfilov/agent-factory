"""Additional machine-outcome predicates; original reviewer oracle stays immutable.
No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy.
"""
import sys,json,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('original',Path(__file__).with_name('check-r31-boundaries.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=m.check(sys.argv[1],'desired');assert r['desired_pass']==14
rows=[json.loads(l) for l in Path(sys.argv[1]).read_text().splitlines()];checks=[]
for x in rows[:-1]:
 i=x['id']
 if i.startswith('C-'):
  if i in ['C-broken-json','C-v2-missing-field','C-v2-extra-field','C-unknown-version']:assert x['error']['code']=='cancel_evidence_unknown'
 else:
  o=x['data']['emergency_outcome'];assert o['paused']['publication']=='durable' and o['paused']['exists'] is True
  if i in ['E-control','E-no-inventory','E-empty-inventory']:
   assert x['exit']==0 and o['stopped_containers']==['a'*12] and o['skipped_foreign_containers']==['b'*12]
   assert o['docker_discovery']=='verified_targets' and o['phase']=='complete'
  else:
   assert x['exit']==8 and x['error']['code']=='emergency_stop_unconfirmed' and x['error']['retryable'] is False
   assert 'Manually' in x['error']['next_action'] and 'fresh plan' not in x['error']['next_action']
   if i=='E-throw-after-prefix':
    assert x['data']['stopped_containers']==['a'*12] and 'container:'+'a'*12 in o['confirmed_stopped']
    assert o['unknown']==['container:'+'b'*12] and 'container:'+'b'*12 not in o['attempted']
   else:assert o['confirmed_stopped']==[] and len(o['attempted'])==1 and o['unknown']==o['attempted']
 checks.append({'id':i,'acceptance':True})
assert len(checks)==14
print(json.dumps({'cases':14,'pass':14,'machine_outcome_predicates':checks},indent=2))
