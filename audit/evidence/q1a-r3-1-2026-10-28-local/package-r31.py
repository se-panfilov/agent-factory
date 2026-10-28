"""Plain-directory package. No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy."""
from pathlib import Path
import subprocess,shutil,tempfile,os,json,hashlib,time,zipfile
R=Path.cwd();O=Path(__file__).resolve().parent;BASE='ad274add0a7ed0a5e0923363ce9e9000bef7c013';REPORT=Path('docs/audits/remediation-q1a-r3-1-2026-10-28.md');env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'};ledger=[]
CAP={'full-local.patch','agent-only.patch','owner-layer.patch','evidence.zip','evidence.zip.sha256','reconstruction.json','package-ledger.json','package-files.sha256','final-preservation.json','zip-verification.json','reconstruction-check.stdout','reconstruction-check.stderr','reconstruction-apply.stdout','reconstruction-apply.stderr','final-head.stdout','final-head.stderr'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(name,args,cwd=R):
 t=time.monotonic();p=subprocess.run(list(map(str,args)),cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 ledger.append(dict(name=name,argv=list(map(str,args)),cwd=str(cwd),exit=p.returncode,signal=-p.returncode if p.returncode<0 else None,duration=time.monotonic()-t))
 (O/(name+'.stdout')).write_bytes(p.stdout);(O/(name+'.stderr')).write_bytes(p.stderr)
 assert p.returncode==0,(ledger[-1],p.stderr[:500]);return p.stdout

def copy(src,dst):
 dst.parent.mkdir(parents=True,exist_ok=True)
 if src.is_symlink():
  if dst.exists() or dst.is_symlink():dst.unlink()
  dst.symlink_to(os.readlink(src))
 else:shutil.copy2(src,dst)

def diff(old,new):
 p=subprocess.run(['git','diff','--no-index','--no-ext-diff','--no-textconv','--binary','--no-renames','old','new'],cwd=old.parent,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert p.returncode in (0,1),p.stderr
 lines=[]
 for line in p.stdout.splitlines(keepends=True):
  if line.startswith((b'diff --git ',b'--- ',b'+++ ')):
   for a,b in [(b'a/old/',b'a/'),(b'a/new/',b'a/'),(b'b/old/',b'b/'),(b'b/new/',b'b/')]:line=line.replace(a,b)
  lines.append(line)
 return b''.join(lines)

run('seal-inherited-check',['python3',O/'inherited/runners/check-final-r221.py',O/'inherited','/private/tmp/q1a-r31-final-2'])
run('seal-r31-check',['python3',O/'runners/check-final-r31.py',O,'/private/tmp/q1a-r31-final-2',R])
initial=json.loads((O/'initial/input-hashes.json').read_text());base_paths={p.decode() for p in subprocess.check_output(['git','ls-tree','-r','--name-only','-z',BASE],cwd=R,env=env).split(b'\0') if p}
owners=sorted(set(initial)-base_paths);assert len(owners)==3 and all(n.endswith('.pyc') for n in owners),owners
for n in owners:assert sha(R/n)==initial[n],n
# Owner delta is derived from captured filesystem hashes versus immutable tree, not staged enrollment.
stage=Path(tempfile.mkdtemp(prefix='r31-owner-',dir='/private/tmp'));old=stage/'old';new=stage/'new';old.mkdir();new.mkdir()
for n in owners:copy(R/n,new/n)
owner_patch=diff(old,new);(O/'owner-layer.patch').write_bytes(owner_patch)
stage=Path(tempfile.mkdtemp(prefix='r31-payload-',dir='/private/tmp'));old=stage/'old';new=stage/'new';old.mkdir()
p=subprocess.Popen(['git','archive',BASE],cwd=R,env=env,stdout=subprocess.PIPE);subprocess.run(['tar','-x','-C',str(old)],stdin=p.stdout,check=True);p.stdout.close();assert p.wait()==0
shutil.copytree(old,new,symlinks=True)
for n in sorted(base_paths):
 src=R/n;dst=new/n
 if src.exists() or src.is_symlink():copy(src,dst)
 elif dst.exists() or dst.is_symlink():dst.unlink()
extras=[Path(x) for x in subprocess.check_output(['rg','--files','setup','-g','!node_modules','-g','!dist'],cwd=R,text=True).splitlines()]+[REPORT]
for f in sorted(O.rglob('*')):
 if not f.is_file() or '__pycache__' in f.parts or f.suffix=='.pyc' or (f.parent==O and f.name in CAP):continue
 assert f.suffix!='.zip',str(f)
 extras.append(f.relative_to(R))
for rel in extras:copy(R/rel,new/rel)
agent_patch=diff(old,new);(O/'agent-only.patch').write_bytes(agent_patch);(O/'full-local.patch').write_bytes(owner_patch+agent_patch)
# Exactly one clean reconstruction and one application of the full payload.
restored=Path(tempfile.mkdtemp(prefix='r31-reconstructed-',dir='/private/tmp'));shutil.copytree(old,restored,dirs_exist_ok=True,symlinks=True)
run('reconstruction-check',['git','apply','--check',O/'full-local.patch'],restored)
run('reconstruction-apply',['git','apply',O/'full-local.patch'],restored)
tested={}
for line in (O/'tested-files.sha256').read_text().splitlines():
 d,n=line.split('  ',1);assert sha(restored/n)==d and sha(R/n)==d,n;tested[n]=d
assert len(tested)==286
payload={}
for rel in extras+[Path(x) for x in owners]:assert sha(restored/rel)==sha(R/rel),str(rel);payload[str(rel)]=sha(R/rel)
reconstruction=dict(base=BASE,base_tree='63f15f339f7520f382ec9e5eb485c7572d5304b7',check_exit=0,apply_exit=0,tested_hashes_match=len(tested),payload_hashes_match=len(payload),patch_sha256=sha(O/'full-local.patch'),report_sha256=sha(R/REPORT),owner_hashes={n:sha(R/n) for n in owners},single_apply=True,no_index_used=True,new_files_tar=False,reconstructed=str(restored))
(O/'reconstruction.json').write_text(json.dumps(reconstruction,indent=2)+'\n')
idx=R/'.git/index';assert idx.read_bytes()==(O/'initial/index.bytes').read_bytes()
preservation=dict(head=run('final-head',['git','rev-parse','HEAD','HEAD^{tree}']).decode().splitlines(),index_sha256=sha(idx),initial_index_bytes_unchanged=True,owner_files_unchanged=True,owners=owners)
(O/'final-preservation.json').write_text(json.dumps(preservation,indent=2)+'\n');(O/'package-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
members={}
for f in sorted(O.rglob('*')):
 if not f.is_file() or '__pycache__' in f.parts or f.suffix=='.pyc':continue
 rel=f.relative_to(O)
 if f.parent==O and f.name in {'evidence.zip','evidence.zip.sha256','package-files.sha256','zip-verification.json'}:continue
 assert f.suffix!='.zip',str(f)
 members[str(rel)]=f
members[REPORT.name]=R/REPORT
sums=''.join(sha(f)+'  '+n+'\n' for n,f in sorted(members.items()));(O/'package-files.sha256').write_text(sums);members['package-files.sha256']=O/'package-files.sha256'
with zipfile.ZipFile(O/'evidence.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for n,f in sorted(members.items()):z.write(f,n)
with zipfile.ZipFile(O/'evidence.zip') as z:
 assert z.testzip() is None
 for line in sums.splitlines():
  d,n=line.split('  ',1);assert hashlib.sha256(z.read(n)).hexdigest()==d,n
 verification=dict(crc='PASS',members=len(z.namelist()),internal_sha256=len(members)-1,patch_in_zip_equals_local=z.read('full-local.patch')==(O/'full-local.patch').read_bytes())
(O/'zip-verification.json').write_text(json.dumps(verification,indent=2)+'\n');(O/'evidence.zip.sha256').write_text(sha(O/'evidence.zip')+'  evidence.zip\n')
assert idx.read_bytes()==(O/'initial/index.bytes').read_bytes()
print(json.dumps(dict(reconstruction=reconstruction,zip=verification,zip_sha256=sha(O/'evidence.zip'),zip_bytes=(O/'evidence.zip').stat().st_size),indent=2))
