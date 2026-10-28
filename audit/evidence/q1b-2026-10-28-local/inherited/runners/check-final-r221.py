"""Final-byte completion/product audit of the ONE saved attempt; never splice runs. No commits/push/branches/worktree/index/PR/release/deploy."""
import json,sys,hashlib
from pathlib import Path
from completion import check
b=Path(sys.argv[1]);tree=Path(sys.argv[2]);r=b/'runners';logs=b/'logs';contracts=json.loads((r/'contracts.json').read_text());ledger=json.loads((logs/'commands.json').read_text());matrices=json.loads((logs/'matrices.json').read_text());checks=[]
for item in matrices:
 entry=next(x for x in ledger if x['stdout']==item['source_stdout']);key=item['contract']
 if item['name'].startswith('comparisons/fixed-') and key in ['command','r2']:key+='-fixed'
 rows=check((b/item['source_stdout']).read_text(),contracts[key],entry['exit_code']);checks.append({'matrix':item['name'],'exact_ids_unique_and_complete':True,'rows':len(rows),'predicates':contracts[key].get('predicates',{}),'pid':entry['pid']})
for name,n in [('comparison-assertions',33),('command-assertions',37),('r2-assertions',39)]:assert len(json.loads((logs/'comparisons'/f'{name}.stdout').read_text()))==n
assert json.loads((logs/'boundary-desired.stdout').read_text())['desired_pass']==14
assert json.loads((logs/'context-oracle.stdout').read_text())['pass']==5
for name in ['s03','v1','v2']:assert json.loads((logs/(name+'-oracle.stdout')).read_text())['product_pass']==13
before=json.loads((logs/'hashes-before.json').read_text());after=json.loads((logs/'hashes-after.json').read_text());assert before==after
for n,digest in before.items():assert hashlib.sha256((tree/n).read_bytes()).hexdigest()==digest
print(json.dumps({'original_replays':1,'instrumented_attempts':0,'no_splicing':True,'matrices':checks,'source_inputs_unchanged':len(before),'O02':'NOT REPRODUCED in this single attempt; cause OPEN, no runtime fix claimed'},indent=2))
