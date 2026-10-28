"""Exact CLI lifecycle completeness and product predicates, independent of collector exit."""
import json,sys
from pathlib import Path
rows=[json.loads(x) for x in Path(sys.argv[1]).read_text().splitlines() if x.strip()]
ids=['CLI-pre-SIGINT','CLI-pre-SIGTERM','CLI-prefix-SIGINT','CLI-prefix-SIGTERM','CLI-disk-cancel']
assert [x['id'] for x in rows]==ids+['META'] and len({x['id'] for x in rows})==6
meta=rows[-1];assert meta['cases']==5 and meta['real_privileged_commands']==meta['external_calls']==0 and meta['node'].startswith('v24.')
for row in rows[:-1]:
 d=row['envelope']['data']['q1b'];mode=d['mode'];assert row['barrier'] is True and row['signal'] is None and not row['stderr']
 assert d['injected_uid']==1000 and d['actual_uid']==meta['actual_uid']
 assert row['code']==(8 if mode=='disk' else 143 if d['signal']=='SIGTERM' else 130)
 assert d['counts']==([1,0] if mode=='prefix' else [0,0])
 if mode=='prefix':assert d['resume_exit']==0 and d['checkpoint_identical'] is True and d['after_resume']==[1,1] and d['in_flight'] is False
 if mode=='disk':
  assert row['producer']['code']==0 and row['producer']['signal'] is None
  assert d['resume_exit']==8 and d['in_flight'] is True and d['supervised']['cleanup']=='confirmed' and d['supervised']['cancelled'] is True
print(json.dumps(dict(cases=5,ids=ids,verdict='PASS')))
