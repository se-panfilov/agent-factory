"""Exact completion before product aggregation. No commits/push/branches/worktree/index/PR/release/deploy."""
import json
class Incomplete(Exception):pass
def check(text,contract,returncode):
 if returncode!=0:raise Incomplete('exit/signal '+str(returncode))
 try:rows=[json.loads(l) for l in text.splitlines() if l.strip()]
 except (ValueError,TypeError) as e:raise Incomplete('non-JSON output: '+str(e))
 ids=[r.get('id',r.get('mode')) for r in rows]
 if ids!=contract['ids'] or len(ids)!=len(set(ids)):raise Incomplete('wrong/missing/duplicate IDs: '+repr(ids))
 if contract['marker']:
  if ids[-1]!=contract['marker']:raise Incomplete('missing end marker')
  if 'cases' in rows[-1] and rows[-1]['cases']!=contract['cases']:raise Incomplete('declared count mismatch')
 for row in rows:
  if row.get('harness_ok') is False:raise Incomplete('fixture not executed: '+str(row.get('id')))
 for row in rows:
  if contract['marker'] is not None and row.get('id')==contract['marker']:continue
  for field,expected in contract.get('predicates',{}).items():
   if field not in row or row[field]!=expected:raise Incomplete('product predicate failed: '+str(row.get('id',row.get('mode')))+':'+field)
 return rows
