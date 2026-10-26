"""Reconstruct only in an empty ordinary folder. No commits/push/branches/worktrees/index/PR/release/deploy."""
import argparse,hashlib,io,json,os,subprocess,tarfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--bundle',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
repo=a.repo.resolve();bundle=a.bundle.resolve();out=a.output.resolve();assert not out.exists() or not any(out.iterdir()),'output must be empty';out.mkdir(parents=True,exist_ok=True)
identity=json.loads((bundle/'identity.json').read_text());env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}
raw=subprocess.check_output(['git','archive',identity['base_commit']],cwd=repo,env=env)
with tarfile.open(fileobj=io.BytesIO(raw)) as t:t.extractall(out,filter='data')
# Initial owner layer is empty for this package. Explicit guard prevents silent loss on reuse.
assert identity['initial_owner_layer']==[]
patch=bundle/'full-local.patch';assert hashlib.sha256(patch.read_bytes()).hexdigest()==identity['sha256']['full-local.patch']
subprocess.run(['git','apply',str(patch)],cwd=out,env=env,check=True)
for line in (bundle/'tested-files.sha256').read_text().splitlines():
 digest,name=line.split('  ',1);assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest,name
for name in json.loads((bundle/'deletions.json').read_text()):assert not (out/name).exists(),name
print('All reconstructed setup inputs match tested-files.sha256; additions already applied by full-local.patch (do not apply new-files.tar twice).')
