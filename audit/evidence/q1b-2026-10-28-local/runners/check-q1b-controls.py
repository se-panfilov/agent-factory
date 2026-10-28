import json,sys
from pathlib import Path
mode=sys.argv[1];rows=[json.loads(x) for x in Path(sys.argv[2]).read_text().splitlines() if x.strip()]
if mode=='persistence':
 assert [x['id'] for x in rows]==['cancel-checkpoint-persistence']
 x=rows[0];assert x['hits']==1 and x['result']['exitCode']==8 and x['result']['envelope']['error']['code']=='cleanup_unconfirmed'
 assert x['counts']==[1,0] and x['state']['in_flight_operation'] is not None
elif mode=='group-observation':
 assert [x['id'] for x in rows]==['OBSERVE-1','OBSERVE-2','RESULT','META']
 x=rows[-2];assert x['hits']==2 and x['result']['cleanup']=='unknown' and x['result']['signal'] is None and x['result']['exitCode']==0
 assert rows[-1]['complete'] is True and rows[-1]['duration_ms']<1500
elif mode=='scope-blocker':
 assert [x['id'] for x in rows]==['scope-blocker','META']
 assert rows[0]['result'] is None and rows[0]['rejected']=={'code':'process_cleanup_unknown','exitCode':8}
 assert rows[-1]['complete'] is True and rows[-1]['cases']==1
else:raise AssertionError(mode)
assert len({x['id'] for x in rows})==len(rows)
print(json.dumps({'mode':mode,'ids':[x['id'] for x in rows],'complete':True,'verdict':'PASS'}))
