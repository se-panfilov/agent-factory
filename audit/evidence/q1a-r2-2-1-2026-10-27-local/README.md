# R2.2.1 local handoff — overall PARTIAL

F01/F02 functional PASS; O02 cause OPEN (one complete original replay does not establish stability). O01 final recovery remains known-red with explicit-review workaround. Real-host/privileged/VM/live NOT RUN. No commits/push/branches/worktrees/staging/index/PR/merge/tag/release/deploy are authorized here or in generated prompts.

Initial base is ad84212831892d18ab4dbcaab0d1bfecdc103f1b, not the externally advanced HEAD564bb057. The first read showed staged/unstaged owner files, but the full snapshot followed the external audit-only commit564bb057. Separate staged bytes before that commit were not fully captured. The final owner audit input bytes are retained; packaging basead842 + owner layer reproduces them. Baseline actually used564bb057, with setup identical toad842. Work started26Oct; bundle completed27Oct local time; old absolute command paths are historical, portable scripts take the current bundle path. No agent commit exists. Full-local.patch = owner-layer.patch + agent-delta.patch. It includes additions; **do not apply new-files.tar again**. Source/report/static runner/fixture inputs are in the patch; mutable evidence logs/identity/manifests/archive/payloads are delivered separately, avoiding recursive self-reference.

In an ordinary empty temporary folder with a local repository containing the historical commits, Python3 and actual Node24/npm:

```
python3 BUNDLE/runners/reconstruct-r221.py --repo /absolute/repository --bundle /absolute/BUNDLE --out /absolute/empty-copy
python3 BUNDLE/runners/validate-r221.py --repo /absolute/repository --fixed /absolute/empty-copy --bundle /absolute/OUTPUT-BUNDLE --work /absolute/empty-validation-work
```

First copy this bundle into OUTPUT-BUNDLE so supplied logs/checksums stay immutable. No worktree/checkout/branch/index is used. Locked npm ci runs in the reconstructed copy/historical archives, not owner dependencies. It may need its normal package cache/registry. No privileged/daemon/provider/credential effects are permitted.

Validator executes ci/typecheck/full suite, new boundaries and original product oracle, context/S03/genuine v1/v2 migrations, known-red recovery/workaround, and exactly one original independent replay. Every matrix has a contract in runners/contracts.json: exact ordered unique IDs, declared counts, marker (or exact terminal-row contract), exit/signal and product predicates where applicable. Original aggregate product oracles remain unchanged. Never interpret raw exit0, harness_ok or a partial original oracle array as product PASS. `check-final-r221.py` requires complete matrices and full33/37/39 product assertions; overlapping counts are not summed.

The historical original scripts under prior-r22 and reviewer-evidence are preserved inputs, not standalone acceptance entrypoints. Use the completion/product wrapper. `checked-runner.cjs` prevents empty/partial/early exit0/unsettled main from successful standalone completion; `test-completion.py` exercises deterministic positive/negative controls. Optional fixed command/R2 contracts require acceptance=true; unsafe historical baselines retain only their original observed-defect oracle. Never select a measurement contract to claim fixed PASS.

On the FIRST incomplete original runner, validator permits exactly one targeted diagnostic attempt with diagnostic.cjs, unchanged timeout, separate stdout/stderr and async FS/child/beforeExit/exit events. It never splices its result into the original run. In the delivered run no incomplete occurred: original_replays1, instrumented_attempts0, cause NOT ESTABLISHED. Do not retry until random green or claim tracing fixes runtime. Historical incomplete attempts are in reviewer-evidence and prior package evidence references.

Source manifest is sorted repo-relative158 setup input paths: SHA256(bytes), two spaces, path, LF; SHA256 of this UTF-8 file identifies tested local bytes. Excludes node_modules/dist/Git metadata/secrets/temp. Static runner/fixture hashes and report/package hashes are separate, avoiding self-reference. Reconstruction checks every source and new payload file; new source/helpers/docs are included. Full patch contains new files; tar is redundant explicit payload only.

Final report is report.md, identical to docs/audits/remediation-q1a-r2-2-1-2026-10-27.md. Logs contain actual commands/cwd/PID/exit/signal/elapsed/env allowlist and actual/injected environments separately. Baseline desired oracle exit1 is expected red (14 complete6 desired PASS/8 FAIL), observed-current0 is not product PASS. Final recovery desired exit1 is expected known-red; explicit new review yields resume0 without replay.

Next action: independent human review of report, patch/payload/identity/manifests/ZIP/checksum. Master alone does not represent local agent delta. Stop after this package; R3/Q1B/Q2–Q6 and production require separate tasks.
