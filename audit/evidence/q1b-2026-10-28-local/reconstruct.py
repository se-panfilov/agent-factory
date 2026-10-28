"""Single plain-directory reconstruction. No commits/push/branches/worktree/PR/index/staging/merge/tag/release/deploy."""
import argparse,hashlib,io,json,os,subprocess,tarfile,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--git-source',required=True,type=Path);p.add_argument('--patch',required=True,type=Path);p.add_argument('--manifest',required=True,type=Path);p.add_argument('--payload',required=True,type=Path);p.add_argument('--out',required=True,type=Path);a=p.parse_args()
a.out.mkdir(parents=True,exist_ok=True);assert not list(a.out.iterdir()),'owned reconstruction output must be empty'
env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'};start=time.monotonic();base='9c9dc19f5ef7795e698c8f3ebaaa637621f38f8e'
raw=subprocess.check_output(['git','archive',base],cwd=a.git_source,env=env)
with tarfile.open(fileobj=io.BytesIO(raw)) as archive:archive.extractall(a.out,filter='data')
# No --index, --cached, --3way or temporary index. A directory archive has no Git index.
r=subprocess.run(['git','apply','--binary',str(a.patch.resolve())],cwd=a.out,env=env,capture_output=True,text=True)
assert r.returncode==0,(r.returncode,r.stdout,r.stderr)
def verify(file):
 count=0
 for line in file.read_text().splitlines():
  digest,name=line.split('  ',1);assert not Path(name).is_absolute() and '..' not in Path(name).parts
  actual=hashlib.sha256((a.out/name).read_bytes()).hexdigest();assert actual==digest,(name,digest,actual);count+=1
 return count
result={'base':base,'archive_only':True,'patch_applications':1,'index_used':False,'git_apply_exit':r.returncode,'tested_files_verified':verify(a.manifest),'payload_files_verified':verify(a.payload),'patch_sha256':hashlib.sha256(a.patch.read_bytes()).hexdigest(),'tested_manifest_sha256':hashlib.sha256(a.manifest.read_bytes()).hexdigest(),'duration_seconds':time.monotonic()-start,'output':str(a.out.resolve()),'verdict':'PASS'}
print(json.dumps(result,indent=2))
