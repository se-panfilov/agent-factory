"""Verify reconstructed bytes and portable payload. No commits/push/branches/worktrees/index/PR/merge/tag/release/deploy."""
import argparse,hashlib,json,tarfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--bundle',required=True,type=Path);p.add_argument('--copy',required=True,type=Path);a=p.parse_args();b=a.bundle.resolve();copy=a.copy.resolve();count=0
for line in (b/'tested-files.sha256').read_text().splitlines():
 digest,n=line.split('  ',1);assert hashlib.sha256((copy/n).read_bytes()).hexdigest()==digest,n;count+=1
runners=0
relative=Path('audit/evidence/q1a-r2-2-2026-10-26-local')
for line in (b/'runner-files.sha256').read_text().splitlines():
 digest,n=line.split('  ',1);assert hashlib.sha256((b/n).read_bytes()).hexdigest()==digest,n;assert hashlib.sha256((copy/relative/n).read_bytes()).hexdigest()==digest,n;runners+=1
payload=json.loads((b/'new-files.json').read_text());assert payload['already_in_full_patch'] and not payload['apply_tar_after_patch']
with tarfile.open(b/'new-files.tar') as tar:
 assert sorted(tar.getnames())==sorted(x['path'] for x in payload['files'])
 for entry in payload['files']:
  data=tar.extractfile(entry['path']).read();assert hashlib.sha256(data).hexdigest()==entry['sha256'];assert data==(copy/entry['path']).read_bytes()
assert (b/'report.md').read_bytes()==(copy/'docs/audits/remediation-q1a-r2-2-2026-10-26.md').read_bytes()
print(json.dumps({'tested_inputs':count,'runner_fixture_inputs':runners,'new_payload_files':len(payload['files']),'reconstructed_all_hashes_match':True,'report_bytes_match':True,'duplicate_tar_application':False},indent=2))
