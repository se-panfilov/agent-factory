"""Reconstruct ordinary files only. No commits/push/branches/worktrees/staging/index/PR/merge/tag/release/deploy."""
import argparse,hashlib,io,json,os,subprocess,tarfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--bundle',required=True,type=Path);p.add_argument('--out',required=True,type=Path);a=p.parse_args();b=a.bundle.resolve();dest=a.out.resolve();assert not dest.exists() or not any(dest.iterdir()),'Destination must be empty';dest.mkdir(parents=True,exist_ok=True)
identity=json.loads((b/'identity.json').read_text());env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}
archive=subprocess.check_output(['git','archive',identity['base_commit']],cwd=a.repo,env=env)
with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(dest,filter='data')
# Full patch already contains additions; never apply new-files.tar a second time.
subprocess.run(['git','apply','--binary',str(b/'full-local.patch')],cwd=dest,env=env,check=True)
checked={}
for row in (b/'tested-files.sha256').read_text().splitlines():
 digest,name=row.split('  ',1);actual=hashlib.sha256((dest/name).read_bytes()).hexdigest();assert digest==actual,name;checked[name]=actual
for name in json.loads((b/'deletions.json').read_text()):assert not (dest/name).exists(),name
print(json.dumps({'base':identity['base_commit'],'checked_files':len(checked),'manifest_sha256':hashlib.sha256((b/'tested-files.sha256').read_bytes()).hexdigest(),'out':str(dest),'index_used':False},indent=2))
