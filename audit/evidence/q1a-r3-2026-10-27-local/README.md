# Q1A-R3 local evidence — 2026-10-27

Code-level R3-F01…F04 + honest R211-O01 outcome. No commit/push/branches/worktree/PR/staging/index/merge/tag/release/deploy, remote messages/mutations, real privileged/Docker/provider/model/credential/VM actions. Publication is the owner's separate action.

## Result and identities

- Product baseline134ecd884ab77f537f1890b3dd456cc6592090ad/tree58a212fa5a30df32437db021f536338507890c47.
- Named reconstruction base **b92e833c3d743d2f15975ee6433b453f07f173b8**, tree dde4eb40ea514a7000714709773fd1a34906a6dd. Its delta is audit-only, setup unchanged.
- First observed index7d93f9… changed externally before complete capture; raw early index/unstaged split are unavailable. First complete capture e322277… and owner staged pyc are preserved unchanged. Attribution unknown. See initial/first-observation.json and report; A3-18 provenance PARTIAL.
- Final source snapshot:166 source/config/schema/package/test inputs, byte-equal to current checkout. Full tested-files.sha256 also includes104 exact external runner/fixture inputs (270 total). Dependencies are ci/lock-bound; node_modules/dist are excluded.
- Final single intended complete run:589/589,74 ordered unique R3 tests; boundary14, context5, S03 13, genuine v1/v2 each13; frozen33 with explicit C01 outcome mapping, command37 and R2-checker39. Sets overlap and must not be added. R3 adapted14/14. Completeness negative controls8/8 plus inherited13/13.
- Original O01/C01 auto-success expectations remain known-red. Separate mapped checkers require recovery8/fresh review and explicit-review no-replay. O02 historical runtime cause remains OPEN; a complete replay is not a runtime-cause fix.
- Actual macOS/APFS UID501, Node24.22.1/npm11.17.0. Application identity UID1000/Ubuntu24/amd64 and Node/bootstrap/daemon facts are explicit synthetic fixtures. Real host qualification NOT RUN.

## Single reconstruction payload

Use **full-local.patch exactly once** on an ordinary directory extracted from the named base:

```sh
mkdir /absolute/new-owned-directory
# Run in the source repo ONLY to read the named Git object; no branch/index mutation.
git archive b92e833c3d743d2f15975ee6433b453f07f173b8 | tar -x -C /absolute/new-owned-directory
cd /absolute/new-owned-directory
git apply --check /absolute/full-local.patch
git apply /absolute/full-local.patch
shasum -a 256 -c audit/evidence/q1a-r3-2026-10-27-local/tested-files.sha256
```

No new-files.tar exists. Do not apply agent-only.patch/owner-layer.patch in addition to full-local.patch. They are an **alternative split**: owner-layer.patch contains only the pre-existing staged pyc absent from b92e833; agent-only.patch contains the disjoint R3 source/report/evidence payload. They may be applied owner then agent instead of the full patch. No patch changes the Git index.

The patch is constructed by `git diff --no-index --binary --no-renames` between ordinary directory copies, without staging or index-based file enrollment. It includes additions/binaries/deletions, all changed setup files, report and sealed evidence payload. Owner audit files/old ZIP already exist in the named base. `external-change/base-head.patch` is retained locally but omitted from transport/payload because it duplicates the prior input archive in binary form; audit-delta-summary and exact input checksums preserve its identity/classification.

Generated capsule files (including their reconstruction/final-identity stdout/stderr command logs) are excluded from patch payload to avoid self-reference: full-local.patch, agent-only.patch, owner-layer.patch, evidence.zip/sha256, reconstruction.json, package-ledger.json, package-files.sha256, final-preservation.json, zip-verification.json. They are included as appropriate in evidence.zip. This is packaging metadata, not a second source overlay. Unzip evidence.zip to a **separate inspection directory**; do not copy its mirrored evidence payload over a reconstructed repository. Report is also included at package root for inspection; the source patch already installs the report in docs/audits.

The first packaging --check returned128 because an added-file diff header still contained the temporary directory prefix; no patch was applied. Failed check/raw/header/script are retained in development/package-attempt1*. The path-only packaging bug was corrected without changing tested product sources. Before transport, reconstruction.json records patch --check/apply exits and equality of all270 tested hashes, plus exact payload/report hashes. package-files.sha256 authenticates ZIP members (excluding itself); evidence.zip.sha256 authenticates the ZIP. No source changes occurred after final validation.

## Reproduce validation (ordinary local adapters only)

Select Node24 first. From the reconstructed source directory run:

```sh
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent
node /absolute/evidence/runners/r3-adapted-probes.cjs /absolute/reconstructed-repo > r3.jsonl 2> r3.stderr
python3 /absolute/evidence/runners/check-r3-adapted.py --mode desired r3.jsonl
```

For complete inherited validation, use runners/validate-r3-inherited.py in inherited/runners with --repo pointing to a repository holding the exact historical commit objects, --fixed pointing to the ordinary reconstructed source directory, --bundle pointing to a separate fresh copy of inherited, and --work to a new owned directory. Historical object IDs are explicit in the driver; no fetch is performed. `inherited/tested-files.sha256` is the166-source snapshot manifest. Main tested-files.sha256 includes external paths relative to repository root as they appear in the source patch.

Preserve stdout/stderr/exit/signal/duration separately. Every matrix uses exact ordered/unique IDs, counts/end markers and product predicates, never collector0 alone. `runners/MAPPING.md` explains every old→new barrier/oracle and its controls. Originals are unchanged. A historical FS object gets only an actual statfs bridge after engine switch for genuine v1/v2; historical state/receipts are not forged.

## Attempts and raw evidence

- baseline*.jsonl/ledgers: original14 cases; baseline24 is accepted Node24 run. Initial Node26 is retained and not counted as Node24 validation.
- attempt-1/: full intended run577/583, six outdated automatic lock-only0 fixture assertions. source-to-final.patch permits reversing current sources to that exact tested snapshot when separately investigating it.
- attempt-2/: same final source suite589/589, boundary/context/S03 complete, unbridged v1 incomplete with one row and typed FS-method refusal.
- diagnostic-first-incomplete*: exactly one targeted instrumented attempt on that v1 runner; beforeExit1/exit1, active=[]; no keepalive/timeout increase. Known harness API cause, O02 historical cause OPEN.
- inherited/logs/: **one final complete attempt**, no splicing/instrumentation. Original replay completeness contracts and current final-admission checker retained. Original O01/C01 known-red raw is separate from mapped acceptance.
- development/: failed/targeted runs retained; never used to splice final matrices. Own leftover development children were terminated by verified PID/parent identity; no pre-existing unrelated processes were stopped.
- final-inherited-check.json, final-r3-check.json: exact completion/product/source audits. r3-final-ledger and inherited/logs/commands.json contain actual commands, exits/signals/durations. Historical known-red raw remains in historical/ too.

NOT RUN: physical power loss, actual Ubuntu login/host/privileged paths, real Docker daemon, service adapter, full process-tree supervisor, VM/VPS, OAuth/provider/model/live/app qualification. Boot/PID-reuse/resource reconciliation is an honest typed manual path. Hostile same-UID/root filesystem attacks remain Q2.

Owner action: send report, full-local.patch, tested-files.sha256, evidence.zip and evidence.zip.sha256 to reviewer. No privileged run or credentials are requested.
