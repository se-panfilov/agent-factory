"""Local reconstruction only. No commits/push/branches/worktree/PR/index mutation."""
import argparse,subprocess,pathlib,json,tarfile,io,os,hashlib
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--bundle',required=True);p.add_argument('--output',required=True);a=p.parse_args();b=pathlib.Path(a.bundle).resolve();o=pathlib.Path(a.output).resolve();o.mkdir(parents=True,exist_ok=True);assert not any(o.iterdir()),'output must be empty';ident=json.loads((b/'identity.json').read_text());env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}
archive=subprocess.check_output(['git','archive',ident['base_commit']],cwd=a.repo,env=env)
with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(o,filter='data')
subprocess.run(['git','apply',str(b/'full-local.patch')],cwd=o,env=env,check=True)
m=(b/'tested-files.sha256').read_bytes();assert hashlib.sha256(m).hexdigest()==ident['tested_manifest_sha256']
for l in m.decode().splitlines():
 h,n=l.split('  ',1);assert hashlib.sha256((o/n).read_bytes()).hexdigest()==h,n
for row in json.loads((b/'new-files.json').read_text()):assert hashlib.sha256((o/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
for n in json.loads((b/'deletions.json').read_text()):assert not (o/n).exists(),n
print(json.dumps({'match':True,'manifest_sha256':hashlib.sha256(m).hexdigest(),'files':len(m.decode().splitlines())}))
