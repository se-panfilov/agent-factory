"""Deterministic harness guards, not product acceptance. No commits/push/branches/worktree/index/PR/release/deploy."""
import json,subprocess,tempfile
from pathlib import Path
from completion import check,Incomplete
contract={'ids':['A','B','META'],'marker':'META','cases':2};good='\n'.join(json.dumps(x) for x in [{'id':'A'},{'id':'B'},{'id':'META','cases':2}])
assert len(check(good,contract,0))==3
try:check(good,{**contract,'predicates':{'safe':True}},0)
except Incomplete:pass
else:raise AssertionError('complete but missing product proof')
for name,text,code in [('empty','',0),('partial','{"id":"A"}',0),('duplicate','{"id":"A"}\n{"id":"A"}\n{"id":"META","cases":2}',0),('count',good.replace('"cases": 2','"cases": 1'),0),('signal',good,-9),('exit',good,1)]:
 try:check(text,contract,code)
 except Incomplete:pass
 else:raise AssertionError(name)
r=Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as d:
 p=Path(d);(p/'contracts.json').write_text(json.dumps({'control':contract}))
 for name,source,expected in [('complete','console.log('+json.dumps(good)+')',0),('early','process.exit(0)',70),('unsettled','void new Promise(()=>{})',70),('truncated','console.log(JSON.stringify({id:"A"}))',70)]:
  (p/'fixture.cjs').write_text(source);z=subprocess.run(['node',str(r/'checked-runner.cjs'),str(p/'contracts.json'),'control',str(p/'fixture.cjs')],capture_output=True,text=True,timeout=5);assert z.returncode==expected,(name,z.returncode,z.stderr)
with tempfile.TemporaryDirectory() as d:
 p=Path(d);(p/'contracts.json').write_text(json.dumps({'control':{**contract,'predicates':{'safe':True}}}))
 for safe,expected in [(False,70),(True,0)]:
  data='\n'.join(json.dumps(x) for x in [{'id':'A','safe':safe},{'id':'B','safe':safe},{'id':'META','cases':2}]);(p/'fixture.cjs').write_text('console.log('+json.dumps(data)+')')
  z=subprocess.run(['node',str(r/'checked-runner.cjs'),str(p/'contracts.json'),'control',str(p/'fixture.cjs')],capture_output=True,text=True,timeout=5);assert z.returncode==expected
print(json.dumps({'harness_controls':13,'positive_control':True,'empty_partial_duplicate_bad_count_exit_signal_early_exit_unsettled_rejected':True}))
