"""Product assertions for frozen independent measurements (not harness_ok alone)."""
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);out=[]
def rows(name):return [json.loads(l) for l in (p/name).read_text().splitlines() if l.strip()]
def ok(case,value,assertion):
 assert value,(case,assertion)
 out.append({'id':case,'status':'PASS','assertion':assertion})
for name in ['fixed-new-probes.jsonl','fixed-new-probes-adapted.jsonl']:
 rr=rows(name)
 for r in rr:
  if r['id']=='META':continue
  ok(r['id']+':'+name,r.get('harness_ok') and r.get('acceptance'), 'frozen runner explicit product acceptance')
  if r['id'].startswith('N01'):ok(r['id']+':zero-entry',r['probes_after_known_hash_failure']==0 and r['observed']['exit']==9 and r['observed']['code']=='s05_deployed_integrity_failed','zero additional probe with typed integrity refusal')
  if r['id'].startswith('N02_docker'):ok('N02:durable-pause',r['group_calls']==1 and r['restart_calls']==0 and r['inflight'] is None and r['stage_status']=='awaiting_manual' and r['journal_tail'][-1]['code']=='checkpoint','group checkpoint precedes safe manual pause; restart absent')
 if 'adapted' in name:ok('N03:include-specific',rr[-2]['refused']=='s03_include_unsupported','valid directory fixture reaches explicit unsupported Include refusal')
c={r['id'][:3]:r for r in rows('fixed-comparison.jsonl') if r['id'].startswith('C')}
r=c['C01'];ok('C01',all(x['recover']['exit']==8 and x['retry']['exit']==8 and x['recover']['code']=='context_review_unproven' and x['retry']['code']=='context_review_unproven' and x['recover']['data']['review_required'] is True and x['retry']['data']['resume_authorized'] is False and x['primary_restored'] and x['last_effect_checkpoint_after'] for x in r['cases']),'direct/plan-first bytes restore with retained checkpoint; prepared review explicitly requires fresh review on repeat')
r=c['C02'];ok('C02',r['recover']['exit']==8 and r['history_preserved'] and r['before']==r['after'],'newer unknown refuses without history changes')
r=c['C03'];ok('C03',r['recover']['exit']==8 and r['manifest_preserved'] and not r['primary_exists'],'manifest-only not fresh')
r=c['C04'];ok('C04',r['recover']['exit']==8 and r['plan_exit']==8 and r['next_apply']['exit']==8 and r['quarantine_still_exists'] and r['readonly_evidence_unchanged'],'quarantine blocks recovery/plan/apply; evidence retained')
r=c['C05'];j=r['journal'];ok('C05',sum(x['phase']=='checkpoint' for x in j)==2 and j[-1]['phase']=='intent' and r['inflight'] and r['recover']['exit']==8,'two completed operations durable; late install unknown not replayable')
r=c['C06'];ok('C06',r['probe_calls']>=1 and r['apply_exit']!=0 and r['recorded_status']!='verified' and not any('probe-release' in x['operation'] and x['phase'] in ['verify','checkpoint'] for x in r['journal']),'failed actual probe called and has no successful proof')
r=c['C07']['resume_evidence'];ok('C07',r['old_session']['exit']==4 and r['active_session']['exit']==0 and r['repeat']['exit']==0 and r['install_calls']==r['group_calls']==1,'old session blocked; active/repeat succeed after fresh reviewed remaining plan without install/group replay')
r=c['C08'];ok('C08',r['rollback_calls']==1 and r['disarm_calls']==0 and r['apply_exit']!=0,'failed tailnet rolls back without disarm')
r=c['C09'];ok('C09',r['recover']['exit']==8 and r['before']==r['after'] and not r['decision_changed'],'prepared conflict refused before evidence writes')
ok('C10',all(x['apply_calls']==0 and x['apply']['exit']==0 for x in c['C10']['cases']),'empty/verify-only never apply')
r=c['C11'];ok('C11',r['engine_cutover_calls']==0 and r['engine_stage_calls']==0 and r['apply_exit']!=0,'reviewed drift blocks cutover before effects')
r=c['C12'];ok('C12',r['retry']['exit']==8 and r['marker_preserved'] and r['evidence_preserved'],'synthetic cleanup control preserves contradictory evidence')
print(json.dumps(out,indent=2))
