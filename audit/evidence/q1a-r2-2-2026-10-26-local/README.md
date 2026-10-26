# R2.2 local handoff — PARTIAL

No agent commit exists. Production OPEN, privileged/VM/live NOT RUN. Do not commit/push/create branches/worktrees/PR/merge/tag/release/deploy or use staging/index to reconstruct/package. Initial content owner layer was empty; intercurrent index changes are retained separately, not undone.

Files: report.md (same bytes as repository audit report), identity.json, full-local.patch, code-local.patch, new-files.tar/json, deletions.json, tested-files.sha256, original-runners.json, runner-files.sha256, acceptance.json, logs, intermediate, initial, runners, inputs/inputs-c13. Full patch contains all additions in its declared source/docs/runner/fixture scope. **Do not apply new-files.tar after full patch**; it is a redundant explicit additions payload. Mutable package outputs/logs/identity/manifest/ZIP are delivered by this bundle, not recursively patched into themselves. No dependencies/dist/Git metadata/secrets are included.

Use an ordinary empty temporary folder, an existing local repository containing actual base f12791cf8416fc115d45246f0531ce103fa5e2e8, Python3 and real Node24/npm. No network service/credentials/privileged host operations are involved; locked npm ci may need access to its package cache/registry.

```
python3 BUNDLE/runners/reconstruct-r22.py --repo /absolute/repository --bundle /absolute/BUNDLE --out /absolute/empty-copy
python3 BUNDLE/runners/validate-r22.py --repo /absolute/repository --fixed /absolute/empty-copy --bundle /absolute/new-output-bundle --work /absolute/empty-validation-work
```

For replay, copy this bundle to a separate ordinary output folder first; this keeps the supplied logs/checksums immutable. `validate-r22.py` expects its --bundle to contain this bundle's runners/inputs/tested-files/identity. It performs Node/npm/ci/typecheck/full tests, current context baseline red/fixed, original S03, genuine legacy v1/v2→C13 explicit review, known-red final recovery and historical frozen comparisons. Every command has a bounded subprocess deadline and expected exit. First incomplete matrix stops validation; do not blindly retry to obtain green.

The delivered first combined run stopped with an unexplained deadline before comparison rows. Its exact output/ledger is retained in intermediate/reconstructed-driver-first. A separately recorded diagnostic continuation used trace-owned-fs.cjs, then completed remaining matrices. `finish-independent-r22.py` reproduces that diagnostic route; --remaining-only resumes from already checked complete comparison/composition logs, not missing output. `check-completeness-r22.py BUNDLE COPY` checks exact shape, original product assertion counts and all157 source hashes. These diagnostic successes do NOT establish harness stability; R211-O02 OPEN, overall PARTIAL.

The original desired final-recovery runner intentionally exits1 (R211-O01/R3); measured explicit new review gives resume0 with unchanged counts. Baseline desired context oracle intentionally exits1 (2/5); fixed expected5/5. Historical R2/command baselines remain unsafe measurements, not accepted product behavior. Do not sum overlapping33/37/39 assertions.

Source manifest algorithm: sorted repo-relative setup input paths, SHA256(file bytes), one `hex  path\n` per file; SHA256 of resulting UTF-8 manifest is tested-tree identity. Excludes dist/node_modules/Git/secrets/temp and mutable report/package outputs. Runner/fixture hashes are separately in runner-files.sha256; report/patch/manifest hashes are in identity and SHA256SUMS. Reconstruction verifies all157 inputs; hashes-before/after match. Final packaging re-reconstruction is recorded separately. ZIP and SHA256SUMS exclude themselves to avoid recursion.

Next human action: independent review of these local files. GitHub master alone does not contain the delta. R3/Q1B/Q2–Q6/application/production remain separate tasks.
