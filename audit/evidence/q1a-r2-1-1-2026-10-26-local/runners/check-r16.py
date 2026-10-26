import json,pathlib,sys
r=pathlib.Path(sys.argv[1]);results=[]
def ok(id,condition,assertion):
 assert condition,(id,assertion)
 results.append({'id':id,'status':'PASS','assertion':assertion})
for mode in ['adapter','stage']:
 for label in ['baseline','fixed']:
  rows=[json.loads(l) for l in (r/f'{label}-{mode}-final.jsonl').read_text().splitlines()]
  for row in rows[:-1]:
   id=row['id'];calls=row['invocations'];ok(label+':'+mode+':'+id+':schema',row['manifest_schema_valid'],'real application-manifest schema accepts fixture')
   if label=='baseline' and id.startswith(('W02','W03','W04')):
    ok(label+':'+mode+':'+id,not row['acceptance'] and len(calls)==2 and any('UNREVIEWED' in c['stdout'] or 'UNBOUND_OPTION' in c['stdout'] for c in calls),'measured unsafe baseline outcome, not desired behavior')
   elif id.startswith('W04'):
    ok(mode+':W04',row['validation']=='refused' and row['error']['code']=='s05_command_content_unbound' and not calls and row['result'] is None,'typed refusal, zero executable invocations and no stage verification')
   else:
    ok(label+':'+mode+':'+id,row['acceptance'] and len(calls)==2 and all(c['stdout']=='REVIEWED_ENTRY\n' and c['exit']==0 and c['args'][0]==row['hashed_path'] for c in calls),'actual child runs checked absolute entry twice, not the CWD decoy')
    if mode=='stage':ok(label+':stage:'+id+':verification',row['result']['stage_status']=='verified','supported command can still verify at stage level (synthetic archive/receipt)')
old=json.loads((r/'comparison-assertions.json').read_text());ok('W12:frozen-33',len(old)==33 and all(x['status']=='PASS' for x in old),'all 33 retained frozen product assertions pass')
print(json.dumps(results,indent=2))
