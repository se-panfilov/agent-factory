"""Deterministic local evidence ZIP. No commits/push/branches/worktree/index/PR/release/deploy."""
import hashlib,json,sys,zipfile
from pathlib import Path
b=Path(sys.argv[1]).resolve()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
checks=['report.md','identity.json','full-local.patch','code-local.patch','tested-files.sha256','runner-files.sha256','new-files.tar','new-files.json','deletions.json','acceptance.json','logs/commands.json']
(b/'packaging-hashes.json').write_text(json.dumps({n:sha(b/n) for n in checks},indent=2)+'\n')
excluded={'evidence.zip','evidence.zip.sha256','SHA256SUMS'}
files=sorted(p for p in b.rglob('*') if p.is_file() and str(p.relative_to(b)) not in excluded and '__pycache__' not in p.parts)
assert not any(any(part in ['node_modules','dist','.git'] for part in p.relative_to(b).parts) for p in files)
(b/'SHA256SUMS').write_text(''.join(sha(p)+'  '+str(p.relative_to(b))+'\n' for p in files))
files=sorted(files+[b/'SHA256SUMS'])
with zipfile.ZipFile(b/'evidence.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:
  info=zipfile.ZipInfo(str(p.relative_to(b)),date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=0o100644<<16
  z.writestr(info,p.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
with zipfile.ZipFile(b/'evidence.zip') as z:
 assert z.testzip() is None
 for p in files:assert z.read(str(p.relative_to(b)))==p.read_bytes()
(b/'evidence.zip.sha256').write_text(sha(b/'evidence.zip')+'  evidence.zip\n')
print(json.dumps({'zip_sha256':sha(b/'evidence.zip'),'zip_bytes':(b/'evidence.zip').stat().st_size,'files':len(files),'deterministic_metadata':'sorted paths; 1980-01-01 UTC; Unix0644; DEFLATE9','internal_and_external_bytes_match':True},indent=2))
