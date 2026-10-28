"""Ordinary directory reconstruction. No commits/push/branches/worktrees/staging/index/PR/merge/tag/release/deploy."""
import argparse,io,tarfile,subprocess,os,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();b=a.bundle.resolve();dest=a.out.resolve();assert not dest.exists() or not any(dest.iterdir());dest.mkdir(parents=True,exist_ok=True);i=json.loads((b/'identity.json').read_text());env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}
data=subprocess.check_output(['git','archive',i['base_commit']],cwd=a.repo,env=env)
with tarfile.open(fileobj=io.BytesIO(data)) as tar:tar.extractall(dest,filter='data')
subprocess.run(['git','apply','--binary',str(b/'full-local.patch')],cwd=dest,env=env,check=True)
count=0
for line in (b/'tested-files.sha256').read_text().splitlines():
 digest,n=line.split('  ',1);assert hashlib.sha256((dest/n).read_bytes()).hexdigest()==digest,n;count+=1
for n in json.loads((b/'deletions.json').read_text()):assert not (dest/n).exists(),n
for item in json.loads((b/'new-files.json').read_text())['files']:assert hashlib.sha256((dest/item['path']).read_bytes()).hexdigest()==item['sha256'],item['path']
print(json.dumps({'base':i['base_commit'],'source_inputs_checked':count,'new_payload_files_checked':len(json.loads((b/'new-files.json').read_text())['files']),'full_patch_applied_once':True,'tar_applied_again':False,'index_used':False,'out':str(dest)},indent=2))
