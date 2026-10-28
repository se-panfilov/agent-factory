"""Fail on missing/empty/incomplete output, independently of subprocess exit. No commits/push/branches/worktree/index/PR/release/deploy."""
from pathlib import Path
import hashlib,json,sys
b=Path(sys.argv[1]);fixed=Path(sys.argv[2]);logs=b/'logs';out=[]
def rows(n):return [json.loads(x) for x in (logs/n).read_text().splitlines() if x.strip()]
for name,n,cases in [('context-baseline.jsonl',6,5),('context-fixed.jsonl',6,5),('access-fixed.jsonl',14,13),('access-legacy.jsonl',14,13),('access-v2-legacy.jsonl',14,13),('comparisons/baseline-r2-final.log',9,8),('comparisons/fixed-r2-final.log',9,8),('comparisons/frozen/fixed-new-probes.jsonl',7,6),('comparisons/frozen/fixed-new-probes-adapted.jsonl',7,6),('comparisons/frozen/fixed-comparison.jsonl',13,None)]:
 rr=rows(name);assert len(rr)==n and rr[-1]['id']=='META',(name,'incomplete',len(rr))
 assert all(x.get('harness_ok',True) for x in rr),(name,'harness failed')
 if cases is not None:assert rr[-1]['cases']==cases
 out.append({'log':name,'rows':len(rr),'complete':True})
for label in ['baseline','fixed']:
 for mode in ['adapter','stage']:
  rr=rows(f'comparisons/{label}-{mode}-final.jsonl');assert len(rr)==5 and rr[-1]['cases']==4
for name,n in [('full-lifecycle',1),('lifecycle-controls',3),('s06-noop',1),('stage-compat',5)]:
 rr=rows('comparisons/frozen/fixed-'+name+'.jsonl');assert len(rr)==n,(name,len(rr))
 for x in rr:
  assert x.get('harness_ok',True) and x.get('acceptance',True) and x.get('passed',True) and (x.get('status','PASS') in ['PASS',0]),(name,x)
rr=rows('access-final-explicit-review.jsonl');assert len(rr)==2 and all(x['resume']!=0 and x['explicit_review_resume']==0 and x['before']==x['after'] and x['checkpoint_retained'] for x in rr)
for name,n in [('comparison',33),('command',37),('r2-product',39)]:assert len(json.loads((logs/f'comparisons/{name}-assertions.json').read_text()))==n
before=json.loads((logs/'hashes-before.json').read_text());after={}
for digest_path in (b/'tested-files.sha256').read_text().splitlines():
 digest,name=digest_path.split('  ',1);value=hashlib.sha256((fixed/name).read_bytes()).hexdigest();assert digest==value,name;after[name]=value
assert before==after;(logs/'hashes-after.json').write_text(json.dumps(after,indent=2)+'\n')
print(json.dumps({'complete_matrices':out,'tested_input_hashes_unchanged':len(after),'stability':'OPEN: prior incomplete deadline run preserved, traced replay is diagnostic, not a stability fix'},indent=2))
