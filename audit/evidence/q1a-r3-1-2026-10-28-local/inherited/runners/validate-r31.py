"""One original replay, at most one targeted diagnostic, never retry-until-green. No commits/push/branches/worktrees/staging/index/PR/merge/tag/release/deploy."""
import argparse,hashlib,io,json,os,platform,subprocess,tarfile,time
from pathlib import Path
from completion import check,Incomplete
p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--fixed',required=True,type=Path);p.add_argument('--bundle',required=True,type=Path);p.add_argument('--work',required=True,type=Path);a=p.parse_args();b=a.bundle.resolve();r=b/'runners';prior=b/'prior-r22';fixed=a.fixed.resolve();repo=a.repo.resolve();work=a.work.resolve();work.mkdir(parents=True,exist_ok=True);out=b/'logs';out.mkdir(exist_ok=True);commands=[];matrices=[];first=None;contracts=json.loads((r/'contracts.json').read_text());env={**os.environ,'GIT_OPTIONAL_LOCKS':'0','TMPDIR':'/private/tmp' if platform.system()=='Darwin' else '/tmp'}
def run(name,argv,cwd=fixed,expect=0,contract=None):
 global first
 argv=list(map(str,argv));stdout=out/(name+'.stdout');stderr=out/(name+'.stderr');stdout.parent.mkdir(parents=True,exist_ok=True);stderr.parent.mkdir(parents=True,exist_ok=True);start=time.monotonic()
 with stdout.open('w') as f,stderr.open('w') as err:
  child=subprocess.Popen(argv,cwd=cwd,env=env,stdout=f,stderr=err)
  try:code=child.wait(timeout=600 if contract is None else 180)
  except subprocess.TimeoutExpired:child.kill();code=child.wait()
 row={'argv':argv,'cwd':str(cwd),'pid':child.pid,'exit_code':code,'signal':-code if code<0 else None,'elapsed_seconds':round(time.monotonic()-start,3),'stdout':str(stdout.relative_to(b)),'stderr':str(stderr.relative_to(b)),'expected_exit':expect,'env_allowlist':{k:env[k] for k in ['PATH','TMPDIR','LANG','LC_ALL'] if k in env}};commands.append(row);(out/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
 if contract:
  try:rows=check(stdout.read_text(),contracts[contract],code);status='COMPLETE'
  except Incomplete as e:
   rows=[];status='INCOMPLETE';row['classification']=str(e)
   if first is None:first=(name,argv,cwd,contract)
  matrices.append({'name':name,'contract':contract,'status':status,'row_count':len(rows),'source_stdout':row['stdout']});(out/'matrices.json').write_text(json.dumps(matrices,indent=2)+'\n');return status=='COMPLETE'
 assert code==expect,(name,code,expect)
 return True
def hashes():
 h={}
 for line in (b/'tested-files.sha256').read_text().splitlines():
  digest,n=line.split('  ',1);value=hashlib.sha256((fixed/n).read_bytes()).hexdigest();assert value==digest,n;assert hashlib.sha256((repo/n).read_bytes()).hexdigest()==digest,n;h[n]=value
 return h
before=hashes();(out/'hashes-before.json').write_text(json.dumps(before,indent=2)+'\n')
for name,argv in [('node',['node','--version']),('npm',['npm','--version']),('ci',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund']),('typecheck',['npm','--prefix','setup','run','typecheck','--silent']),('test',['npm','--prefix','setup','run','test','--silent'])]:run(name,argv)
assert (out/'node.stdout').read_text().startswith('v24.')
(out/'environment.json').write_text(json.dumps({'node':(out/'node.stdout').read_text().strip(),'npm':(out/'npm.stdout').read_text().strip(),'os':platform.platform(),'arch':platform.machine(),'uid':os.getuid(),'injected_owner':1000,'real_host_qualification':'NOT RUN'},indent=2)+'\n')
run('completion-controls',['python3',r/'test-completion.py'])
def matrix(name,runner,contract,*args):return run(name,['node',runner,*args],contract=contract)
# Mandatory functional matrices precede the bounded O02 original replay.
bound=out/'boundaries';bound.mkdir(exist_ok=True)
for name,runner,contract in [('context-boundary-probes',r/'original/context-boundary-probes.cjs','boundary-context'),('release-boundary-probes',r/'release-boundary-final-admission.cjs','boundary-release')]:
 assert matrix('boundaries/'+name,runner,contract,fixed)
 (bound/(name+'.jsonl')).write_bytes((bound/(name+'.stdout')).read_bytes())
run('boundary-desired',['python3',r/'original/check-boundary-results.py',bound,'--expect','fixed'])
assert matrix('r31',b.parent/'runners/r31-boundary-probes.cjs','r31',fixed)
run('r31-oracle',['python3',b.parent/'runners/check-r31-boundaries.py','--mode','desired',out/'r31.stdout'])
run('r31-outcomes',['python3',b.parent/'runners/check-r31-outcomes.py',out/'r31.stdout'])
run('current-callers',['node',b.parent/'runners/audit-current-callers.cjs',fixed,b.parent/'runners'])
assert matrix('r3',b.parent/'runners/r3-explicit-identity.cjs','r3',fixed)
run('r3-oracle',['python3',b.parent/'runners/check-r3-adapted.py','--mode','desired',out/'r3.stdout'])
run('r3-checker-controls',['python3',b.parent/'runners/check-r3-checker-controls.py',out/'r3.stdout'])
assert matrix('context',prior/'runners/context-binding-c13.cjs','context',fixed);run('context-oracle',['python3',prior/'runners/original/check-context-binding.py',out/'context.stdout','--expect','fixed'])
assert matrix('s03',b.parent/'runners/s03-explicit-identity.cjs','s03',fixed);run('s03-oracle',['python3',prior/'runners/original/check-access-continuation.py',out/'s03.stdout','--expect','fixed'])
def archive(sha,name):
 tree=work/name;tree.mkdir();data=subprocess.check_output(['git','archive',sha],cwd=repo,env=env)
 with tarfile.open(fileobj=io.BytesIO(data)) as t:t.extractall(tree,filter='data')
 run(name+'-ci',['npm','--prefix','setup','ci','--ignore-scripts','--no-audit','--no-fund'],tree);run(name+'-build',['npm','--prefix','setup','run','build','--silent'],tree);return tree
for sha,name in [('6281df5796ec5dd82a6fee95b058bbc970f0ed16','v1'),('f12791cf8416fc115d45246f0531ce103fa5e2e8','v2')]:
 tree=archive(sha,name);assert matrix(name,b.parent/'runners/legacy-to-c13-r3.cjs','s03-legacy',tree,fixed);run(name+'-oracle',['python3',prior/'runners/original/check-access-continuation.py',out/(name+'.stdout'),'--expect','fixed'])
run('final-recovery-known-red',['node',prior/'runners/original/access-final-recovery.cjs',fixed],expect=1)
run('final-recovery-original-measurements-known-red',['node',prior/'runners/original/access-final-recovery-measurements.cjs',fixed],expect=1)
assert matrix('final-recovery',b.parent/'runners/r211-honest-recovery.cjs','final-recovery',fixed)
recovered=[json.loads(l) for l in (out/'final-recovery.stdout').read_text().splitlines()]
assert all(x['recover']==8 and x['repeat']==8 and x['recovery_error']=='context_review_unproven' and x['review_required'] is True and x['resume_authorized'] is False and x['resume']==8 and x['explicit_review_resume']==0 and x['before']==x['after'] and x['checkpoint_retained'] for x in recovered)
command=archive('b888082167b5edc50977a6dcda997b40e962da8d','command-baseline');r2=archive('ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff','r2-baseline')
c=out/'comparisons';frozen=c/'frozen';frozen.mkdir(parents=True,exist_ok=True)
def measured(name,runner,contract,*args):
 ok=matrix('comparisons/'+name,runner,contract,*args)
 # Original oracle filenames are copies of this ONE attempt only; never splice runs.
 src=c/(name+'.stdout');target=c/(name if name.endswith('.log') or name.endswith('.jsonl') else name+'.jsonl');target.write_bytes(src.read_bytes());return ok
for label,tree in [('baseline',command),('fixed',fixed)]:
 for mode in ['adapter','stage']:measured(f'{label}-{mode}-final.jsonl',prior/'runners/original/command-identity-probes.cjs','command',tree,mode)
for label,tree in [('baseline',r2),('fixed',fixed)]:measured(label+'-r2-final.log',prior/'runners'/('original' if label=='baseline' else 'c13')/'r2-admission-probes.cjs','r2',tree)
for name,script,key,inputs in [('new-probes','r14-new-probes.cjs','new','frozen-r14-fixtures'),('new-probes-adapted','r14-new-probes-directory-contract.cjs','new','frozen-r14-fixtures'),('comparison','r14-comparison-fresh-gates.cjs','comparison','input-r14/frozen-fixtures'),('full-lifecycle','full-lifecycle.cjs','full','input-r14/frozen-fixtures'),('lifecycle-controls','lifecycle-controls.cjs','controls','input-r14/frozen-fixtures'),('s06-noop','s06-noop-probe.cjs','s06','input-r14/frozen-fixtures'),('stage-compat','stage-compat-probes.cjs','compat','input-r14/frozen-fixtures')]:measured('frozen/fixed-'+name+'.jsonl',prior/'runners/c13'/script,key,fixed,prior/'inputs-c13'/inputs)
if first:
 name,argv,cwd,contract=first
 # Exactly ONE instrumented attempt on the FIRST incomplete runner; no keepalive/timeout increase.
 instrumented=[argv[0],'--require',str(r/'diagnostic.cjs'),*argv[1:]]
 run('diagnostic-first-incomplete',instrumented,cwd=cwd,contract=contract)
else:
 run('comparisons/comparison-original-known-red',['python3',prior/'runners/original/check-results.py',frozen],expect=1)
 run('comparisons/comparison-assertions',['python3',b.parent/'runners/check-frozen-r3.py',frozen]);(c/'comparison-assertions.json').write_bytes((c/'comparison-assertions.stdout').read_bytes())
 run('comparisons/command-assertions',['python3',prior/'runners/original/check-r16.py',c]);(c/'command-assertions.json').write_bytes((c/'command-assertions.stdout').read_bytes())
 run('comparisons/r2-assertions',['python3',prior/'runners/original/check-r21.py',c]);(c/'r2-assertions.json').write_bytes((c/'r2-assertions.stdout').read_bytes())
after=hashes();assert before==after;(out/'hashes-after.json').write_text(json.dumps(after,indent=2)+'\n')
(out/'replay-verdict.json').write_text(json.dumps({'status':'INCOMPLETE' if first else 'COMPLETE','first_incomplete':first[0] if first else None,'original_replays':1,'instrumented_attempts':1 if first else 0,'cause':'NOT ESTABLISHED','tracing_is_fix':False,'no_splicing':True},indent=2)+'\n')
print(json.dumps({'functional_checks':'complete','independent_replay':'INCOMPLETE' if first else 'COMPLETE','O02':'cause OPEN; not claimed fixed','source_hashes_unchanged':len(after)}))
raise SystemExit(70 if first else 0)
