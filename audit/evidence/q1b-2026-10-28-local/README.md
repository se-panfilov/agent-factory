# Q1B local evidence — 2026-10-28

Five handoff files: docs/audits/remediation-q1b-2026-10-28.md and this directory's full-local.patch, tested-files.sha256, evidence.zip, evidence.zip.sha256. No commits/push/branches/worktree/PR/staging/index mutations/merge/tag/release/deploy. No privileged/live/remote operations.

Named patch base: **9c9dc19f5ef7795e698c8f3ebaaa637621f38f8e** (tree379636ade3a05190ee310e104248c2d20deea5bc). It differs from reviewed01d804ff… only by three audit additions; product setup bytes were identical. Owner layer is six staged pyc; initial/staged.patch is already included in full-local.patch. Applying it additionally would duplicate payload. There is no new-files.tar. Source patch applies exactly once, without --index/--cached. Index bytes remain stored locally for preservation checks, excluded from ZIP. The actual checkout index SHA256 remained e5503faaadfaa12ee075548da143c08eae12c558ef870112387e6ee14a8451aa.

## Evidence map

- baseline.jsonl/baseline.stderr + ledger.jsonl: original5-case collector on exact reviewed product,2 desired green/3 red; separate baseline0/desired1 oracle. Baseline collector0 means completion only.
- runners/q1b-baseline-probes.cjs and check-q1b-baseline.py: unchanged reviewer inputs. q1b-mapped-probes.cjs adds only mandatory internal policy. mapping.md explains original/mapped wiring. Existing R31/R3/S03/current explicit identities and genuine old API/C13 bridges remain separate.
- inherited/logs/: **final attempt3**, full ci/typecheck/test697/697 +22 complete inherited matrices +2 Q1B matrices +3 controlled fault checks,62 command entries. commands.json contains exact argv/cwd/exit/signal/duration. All645 baseline test names retained;52 new names exact ordered/unique. Source hashes303 before=after=snapshot=checkout. Independent final-check-3.stdout verifies actual environment, names, predicates, ledger and hashes.
- attempts/attempt1: complete695/695 before reproduced cancellation/checkpoint fault; attempts/attempt2: complete696/696 before bounded observer/unknown-scope fixes. Their outputs are independent, never merged. Superseded input files are only selected differing inputs, not whole source/temp trees. These attempts are not the final verdict.
- persistence-before/after, group-observation-before/after, scope-blocker-before/after: exact controlled defects and fixes. The deliberate observer-fault beforeExit70 is an intentionally injected never-resolving observer with a finite child, a known new fault; it is not the cause of historical O02. reviewer-inputs/original-q1b-* supplemental scripts are original bytes generated in this pass, not attributed to the reviewer.
- reviewer-inputs/: original reviewer README/checksums/audit and Q1B baseline raw, separately labelled Linux UID0 reference. Actual execution here was macOS15.5 arm64/Node24.22.1/npm11.17.0/UID501; application identity1000 is injected. No process.getuid/root/OS bypass.
- initial/, final/: identities, index SHA/entries/staged patch, hashes, preservation scan. No unexplained HEAD/index movement observed; all initial owner bytes preserved.
- reconstruction.json + patch-payload.sha256: single plain-directory archive+patch reconstruction and exact hashes. historical-inputs.json binds every archived historical setup input to its immutable commit. It does not replace genuine old engines with current code.

O01 remains recover8/fresh explicit review/no replay; original automatic-success oracles remain known-red. O02 historical cause remains OPEN. There were no unexplained incomplete final matrices and no instrumented replay/keepalive. Frozen33/command37/R2-checker39 overlap and are not summed.

## Reconstruct once (read-only Git, no index)

Use a repository containing the named base and historical commits and an owned empty output directory. `git archive` supplies base bytes; the patch includes all new/binary/deleted payload. The packaged reconstruct.py performs exactly this and verifies every tested and patch payload hash:

```text
python3 reconstruct.py --git-source /absolute/base-repository --patch /absolute/full-local.patch --manifest /absolute/tested-files.sha256 --payload /absolute/patch-payload.sha256 --out /absolute/empty-owned-directory
```

Do not extract ZIP runners as source overlays into that output: they are a separately inspectable evidence copy. Compare them to reconstructed paths, or use the paths already added by the patch. Do not apply initial/staged.patch in addition to full-local.patch.

For an optional reviewer replay with Node24, make a fresh ordinary directory copy of reconstructed source for npm ci. Run validate-q1b.py from an owned copy of evidence/inherited, with --fixed pointing to that source snapshot and --bundle to that owned evidence/inherited. The manifest is supplied in both evidence/tested-files.sha256 and inherited/tested-files.sha256. Use --repo to point to the reconstructed current-source directory. It needs read-only historical objects: GIT_DIR may point to the original base repository's .git with GIT_OPTIONAL_LOCKS=0; archive reads objects and does not mutate index. No checkout/worktree is required. All source/runner hashes are checked before/after. Use fresh --work and output paths; do not overwrite this evidence's raw attempts.

The actual final command is in the report and final-driver-3 outputs; exact per-command argv are in commands.json. CI is only in the owned snapshot; dependencies/pins were not changed. A real Linux/root-isolated/PAM/privileged host is **NOT RUN** and is not required from the owner for handoff.

## Exclusions and integrity

Patch contains source/test/docs and exact external runner/fixture bytes plus owner layer. Generated raw logs, initial/final captures, attempts, tested manifests, payload manifests, archive/checksum, reconstruction records/script and README/observations are sealing metadata outside the self-referential patch payload. They are in ZIP where applicable. Report is a patch payload and is also copied into ZIP for convenient reading. full-local.patch is a separately delivered artifact, not recursively embedded in evidence.zip. ZIP has no prior evidence ZIP, node_modules/dist, Git/index database, full repository or transient deployment trees. Initial/staged.patch is evidence only when using the full patch. No credentials/auth files were read or packaged.

SHA256SUMS inside ZIP covers every packaged file other than itself. evidence.zip.sha256 covers the archive. The full-local.patch and tested-files.sha256 hashes are recorded in package-metadata.json; that metadata does not feed back into the patch. No physical power-loss, hostile FS/root attacks, malicious setsid containment or real Docker daemon cleanup qualification is claimed.

The owner's only next action: send the five files to the reviewer. Publication remains separate.
