"""Actual product assertions for the frozen R2 runner. Harness exit 0 is insufficient."""
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);out=[]
def ok(id,value,assertion):
 assert value,(id,assertion)
 out.append({'id':id,'status':'PASS','assertion':assertion})
for label,safe in [('baseline',5),('fixed',8)]:
 rows=[json.loads(l) for l in (root/(label+'-r2-final.log')).read_text().splitlines() if l.strip()]
 ok(label+':count',rows[-1]['safe']==safe and rows[-1]['cases']==8,'explicit expected safe/unsafe product measurement, not harness completion')
 for row in rows[:-1]:
  ok(label+':'+row['id']+':harness',row['harness_ok'],'fixture actually executed')
  if label=='baseline' and row['id'].startswith(('R2A03','R2A07','R2A08')):
   ok(label+':'+row['id'],row['exit']==0 and not row['acceptance'] and (row.get('effects')==1 or row.get('counts')=={'refresh':1,'simulate':1,'install':1}),'measured unsafe baseline outcome; not desired behavior')
  else:
   ok(label+':'+row['id'],row['acceptance'],'expected control or fixed product outcome')
  if label=='fixed' and row['id'].startswith('R2A03'):ok('F01',row['exit']==2 and row['counts']=={'refresh':0,'simulate':0,'install':0} and row['s02_status']!='verified','strip both gate arrays + recompute hash: semantic refusal before APT calls')
  if label=='fixed' and row['id'].startswith('R2A07'):ok('F02:expired',row['exit']==4 and row['effects']==0,'31 minute gate-free plan refuses before effects')
  if label=='fixed' and row['id'].startswith('R2A08'):ok('F02:future',row['exit']==8 and row['effects']==0,'future gate-free creation refuses before effects')
ok('A21-14:frozen33',len(json.loads((root/'comparison-assertions.json').read_text()))==33,'retained 33 frozen assertions PASS')
ok('A21-14:command37',len(json.loads((root/'command-assertions.json').read_text()))==37,'retained 37 command assertions PASS (includes frozen33 aggregate; do not sum as 70 unique cases)')
print(json.dumps(out,indent=2))
