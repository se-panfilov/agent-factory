"""Ordinary-directory packaging; no commits/push/branches/worktree/PR/index mutations/merge/tag/release/deploy."""
import pathlib,subprocess,tempfile,shutil,hashlib,json,os,time,zipfile
R=pathlib.Path.cwd();O=pathlib.Path(__file__).resolve().parent
BASE='b92e833c3d743d2f15975ee6433b453f07f173b8'
REPORT=pathlib.Path('docs/audits/remediation-q1a-r3-2026-10-27.md')
OWNER=pathlib.Path('audit/evidence/q1a-r2-2-1-2026-10-27-local/runners/__pycache__/completion.cpython-313.pyc')
CAPSULE={'full-local.patch','agent-only.patch','owner-layer.patch','evidence.zip','evidence.zip.sha256','reconstruction.json','package-ledger.json','package-files.sha256','final-preservation.json','zip-verification.json'}
ledger=[]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(name,args,cwd=R,expected=0,save=True):
 t=time.monotonic();p=subprocess.run(list(map(str,args)),cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'})
 row=dict(name=name,argv=list(map(str,args)),cwd=str(cwd),exit=p.returncode,signal=-p.returncode if p.returncode<0 else None,duration=time.monotonic()-t);ledger.append(row)
 if save:(O/(name+'.stdout')).write_bytes(p.stdout);(O/(name+'.stderr')).write_bytes(p.stderr)
 assert p.returncode==expected,(row,p.stderr[:500]);return p.stdout

def diff_dirs(old,new):
 p=subprocess.run(['git','diff','--no-index','--binary','--no-renames','old','new'],cwd=old.parent,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'})
 assert p.returncode in (0,1),p.stderr
 output=[]
 for line in p.stdout.splitlines(keepends=True):
  if line.startswith((b'diff --git ',b'--- ',b'+++ ')):line=line.replace(b'a/old/',b'a/').replace(b'b/new/',b'b/')
  output.append(line)
 return b''.join(output)

def copy(src,dst):
 dst.parent.mkdir(parents=True,exist_ok=True)
 if src.is_symlink():
  if dst.exists() or dst.is_symlink():dst.unlink()
  dst.symlink_to(os.readlink(src))
 else:shutil.copy2(src,dst)

# Fresh explicit exit capture for final validators, after source/runner freeze.
run('seal-inherited-check',['python3',O/'inherited/runners/check-final-r221.py',O/'inherited','/private/tmp/q1a-r3-final-snapshot-2'])
run('seal-r3-check',['python3',O/'runners/check-final-r3.py',O,'/private/tmp/q1a-r3-final-snapshot-2',R])
# Failed attempt1 is reproducible without a repository archive: reverse this exact source-only delta.
stage=pathlib.Path(tempfile.mkdtemp(prefix='q1a-r3-attempt-diff-',dir='/private/tmp'));old=stage/'old';new=stage/'new';old.mkdir();new.mkdir()
for line in (O/'attempt-1/tested-files.sha256').read_text().splitlines():
 d,n=line.split('  ',1);p=pathlib.Path('/private/tmp/q1a-r3-final-snapshot')/n;assert digest(p)==d
 copy(p,old/n);copy(R/n,new/n)
(O/'attempt-1/source-to-final.patch').write_bytes(diff_dirs(old,new))
# Owner split contains only the preserved pre-existing pyc payload, disjoint from agent delta.
stage=pathlib.Path(tempfile.mkdtemp(prefix='q1a-r3-owner-diff-',dir='/private/tmp'));old=stage/'old';new=stage/'new';old.mkdir();new.mkdir();copy(R/OWNER,new/OWNER)
owner_patch=diff_dirs(old,new);(O/'owner-layer.patch').write_bytes(owner_patch)
# Build ordinary directory snapshots directly from a named tree and filesystem bytes. No index-based enrollment.
stage=pathlib.Path(tempfile.mkdtemp(prefix='q1a-r3-source-diff-',dir='/private/tmp'));old=stage/'old';new=stage/'new';old.mkdir()
p=subprocess.Popen(['git','archive',BASE],cwd=R,stdout=subprocess.PIPE,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'})
subprocess.run(['tar','-x','-C',str(old)],stdin=p.stdout,check=True);p.stdout.close();assert p.wait()==0
shutil.copytree(old,new,symlinks=True)
base_paths=subprocess.check_output(['git','ls-tree','-r','--name-only','-z',BASE],cwd=R).split(b'\0')
for raw in base_paths:
 if not raw:continue
 relative=pathlib.Path(raw.decode());src=R/relative;dst=new/relative
 if src.exists() or src.is_symlink():copy(src,dst)
 elif dst.exists() or dst.is_symlink():dst.unlink()
extras=[pathlib.Path(p) for p in subprocess.check_output(['rg','--files','setup','-g','!node_modules','-g','!dist'],cwd=R,text=True).splitlines()]+[REPORT]
for src in sorted(O.rglob('*')):
 if not src.is_file() or '__pycache__' in src.parts or src.suffix=='.pyc':continue
 rel=src.relative_to(O)
 if src.parent==O and src.name in CAPSULE:continue
 if rel==pathlib.Path('external-change/base-head.patch'):continue # old archive duplicate; identity recorded separately
 extras.append(src.relative_to(R))
for relative in extras:copy(R/relative,new/relative)
agent_patch=diff_dirs(old,new);(O/'agent-only.patch').write_bytes(agent_patch)
(O/'full-local.patch').write_bytes(owner_patch+agent_patch)
# One reconstruction from the named base, then compare every tested and sealed payload byte.
restored=pathlib.Path(tempfile.mkdtemp(prefix='q1a-r3-reconstructed-',dir='/private/tmp'));shutil.copytree(old,restored,dirs_exist_ok=True,symlinks=True)
run('reconstruction-check',['git','apply','--check',O/'full-local.patch'],restored)
run('reconstruction-apply',['git','apply',O/'full-local.patch'],restored)
tested={}
for line in (O/'tested-files.sha256').read_text().splitlines():
 d,n=line.split('  ',1);assert digest(restored/n)==d and digest(R/n)==d,n;tested[n]=d
assert len(tested)==270
payload={}
for relative in extras+[OWNER]:
 assert digest(restored/relative)==digest(R/relative),str(relative)
 payload[str(relative)]=digest(R/relative)
assert digest(restored/REPORT)==digest(R/REPORT)
reconstruction=dict(base=BASE,base_tree='dde4eb40ea514a7000714709773fd1a34906a6dd',patch_sha256=digest(O/'full-local.patch'),check_exit=0,apply_exit=0,tested_hashes_match=len(tested),payload_hashes_match=len(payload),report_hash=digest(R/REPORT),owner_hash=digest(R/OWNER),no_index_used=True,new_files_tar=False,single_apply=True,reconstructed=str(restored))
(O/'reconstruction.json').write_text(json.dumps(reconstruction,indent=2)+'\n')
# Preserve actual observed index after the external transition; never write it.
index=R/'.git/index';assert index.read_bytes()==(O/'initial/index.bytes').read_bytes()
preservation=dict(head=run('final-head',['git','rev-parse','HEAD','HEAD^{tree}']).decode().splitlines(),index_sha256=digest(index),after_complete_capture_index_unchanged=True,pre_event_index_sha256='7d93f9b3ffb62ae9eb7864ebfb363eb1a38503720369fd25f396e4a8fdf26ef8',pre_event_index_bytes_available=False,owner_binary_unchanged=digest(R/OWNER)==json.loads((O/'owner-layer.json').read_text())['owner_binary_sha256'])
(O/'final-preservation.json').write_text(json.dumps(preservation,indent=2)+'\n')
(O/'package-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
# Transport contains no old ZIP, node_modules/dist/temp tree or itself. No source overlay from ZIP is needed.
members={}
for f in sorted(O.rglob('*')):
 if not f.is_file() or '__pycache__' in f.parts or f.suffix=='.pyc':continue
 rel=f.relative_to(O)
 if rel==pathlib.Path('external-change/base-head.patch') or rel.name in {'evidence.zip','evidence.zip.sha256','package-files.sha256','zip-verification.json'}:continue
 assert f.suffix!='.zip',str(f)
 members[str(rel)]=f
members['remediation-q1a-r3-2026-10-27.md']=R/REPORT
checksums=''.join(digest(f)+'  '+n+'\n' for n,f in sorted(members.items()))
(O/'package-files.sha256').write_text(checksums);members['package-files.sha256']=O/'package-files.sha256'
with zipfile.ZipFile(O/'evidence.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for n,f in sorted(members.items()):archive.write(f,n)
with zipfile.ZipFile(O/'evidence.zip') as archive:
 assert archive.testzip() is None
 for line in checksums.splitlines():
  d,n=line.split('  ',1);assert hashlib.sha256(archive.read(n)).hexdigest()==d,n
 verification=dict(crc='PASS',members=len(archive.namelist()),internal_sha256=len(members)-1,patch_in_zip_equals_local=archive.read('full-local.patch')==(O/'full-local.patch').read_bytes())
(O/'zip-verification.json').write_text(json.dumps(verification,indent=2)+'\n')
(O/'evidence.zip.sha256').write_text(digest(O/'evidence.zip')+'  evidence.zip\n')
assert index.read_bytes()==(O/'initial/index.bytes').read_bytes()
print(json.dumps(dict(reconstruction=reconstruction,zip=verification,zip_sha256=digest(O/'evidence.zip'),zip_bytes=(O/'evidence.zip').stat().st_size),indent=2))
