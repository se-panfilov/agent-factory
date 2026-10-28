"""Negative completeness controls. No commits/push/branches/worktree/PR/index/merge/tag/release/deploy."""
import sys,json,tempfile,importlib.util,copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('r3checker',Path(__file__).with_name('check-r3-adapted.py'));checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)
rows=[json.loads(l) for l in Path(sys.argv[1]).read_text().splitlines()];results=[]
with tempfile.TemporaryDirectory(prefix='r3-checker-') as root:
 for kind in ['valid','missing-meta','duplicate','order','counter','barrier','typed-fault','count']:
  v=copy.deepcopy(rows)
  if kind=='missing-meta':v.pop()
  if kind=='duplicate':v[1]=v[0]
  if kind=='order':v[0],v[1]=v[1],v[0]
  if kind=='counter':next(x for x in v if x['id']=='C-late')['counts']['refresh']=1
  if kind=='barrier':next(x for x in v if x['id']=='C-late')['hits']=0
  if kind=='typed-fault':next(x for x in v if x['id']=='C-atomic-fault')['error']=None
  if kind=='count':v[-1]['cases']=13
  file=Path(root)/'input.jsonl';file.write_text(''.join(json.dumps(x)+'\n' for x in v))
  rejected=False
  try:result=checker.check(file,'desired');assert result['desired_fail']==0
  except AssertionError:rejected=True
  assert rejected==(kind!='valid'),kind
  results.append({'id':kind,'rejected':rejected,'acceptance':True})
assert len(results)==8 and len({r['id'] for r in results})==8
print(json.dumps({'controls':8,'pass':8,'cases':results},indent=2))
