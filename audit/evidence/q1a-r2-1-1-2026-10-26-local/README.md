# Q1A-R2.1.1 local evidence — 2026-10-26

No commits, push, branches, worktrees, index staging (`git add`, including `-N`), PR, merge, tag, release or deploy are allowed. Preserve this prohibition in any generated follow-up prompts. No privileged/remote host actions are authorized. Work only in empty ordinary temporary directories. Keep the owner's checkout/dependencies intact.

The ZIP is self-contained evidence plus a source patch; it requires the repository's existing Git objects, Python3 and real Node major24/npm. It does not need a personal agent session directory. Recorded absolute paths/PIDs in logs document actual execution, not reconstruction dependencies. No credentials/secrets were used.

## Contents and identities

- `report.md` is byte-identical to `docs/audits/remediation-q1a-r2-1-1-2026-10-26.md` in the local checkout and full patch.
- `identity.json`: actual base commit/tree/branch, empty owner layer, initial/final index checksums, runtime, source identity and payload/report/patch hashes. There is no new tested commit.
- `full-local.patch` contains all source/docs/report additions and deletions. `agent-delta.patch` is identical because owner layer was empty. The patch deliberately excludes this recursively generated evidence folder; its complete contents are supplied here instead.
- `new-files.tar` / `new-files.json` explicitly enumerate all additions **already in full-local.patch**. Do not apply tar again after the full patch. `deletions.json` lists deletions (none in this package).
- `code-local.patch` is the source-only patch used to reconstruct the final validation copy before report packaging. Its setup bytes are identical to the full deliverable; it is diagnostic, not an extra patch to apply.
- `tested-files.sha256`: all148 relevant setup source/tests/helpers/config/lock/schema/bootstrap/release/fixture/docs inputs, excluding dist/dependencies/Git/temp/runtime/report/packaging. `SHA256SUMS` hashes the packaging separately, excluding itself and the ZIP/checksum to avoid self-reference.
- `runners/` and `inputs/`: frozen old runners/fixtures plus original S03 runner/oracle, portable reconstruction/validation, new test-layer baseline driver and separately labelled legacy transition adapter.
- `logs/`: final command/environment/test/comparison outputs, machine counters, actual inherited fault/crash matrix, source hashes before/after, package reconstruction. `intermediate/` contains exploratory and earlier successful runs, explicitly not final source validation.

## Verify and restore

First verify external `evidence.zip.sha256`, extract ZIP into an empty temporary folder and verify `SHA256SUMS` there. Run from a Node24 environment. Replace the example paths; do not reuse an occupied output folder.

```text
python3 /tmp/r211-delivery/runners/reconstruct-r211.py --repo /path/to/agent-factory --bundle /tmp/r211-delivery --output /tmp/r211-fixed
```

This performs read-only `git archive` of actual base6281df5796ec5dd82a6fee95b058bbc970f0ed16 and applies the full patch, then checks all setup hashes and deletions. No owner layer is needed; initial owner layer was empty. Do not stage anything. The final report and payload are verified independently by `SHA256SUMS` / identity hashes.

## Repeat measurements

Keep the extracted original evidence intact. Make a separate temporary copy of the bundle for new logs (the validation driver writes logs into its supplied bundle). Reconstruct an unpatched S03 baseline in another empty temporary folder using `git archive` of the actual base; ordinary archive extraction is sufficient. Example archive operation from the repository:

```text
git archive 6281df5796ec5dd82a6fee95b058bbc970f0ed16 -o /tmp/r211-base.tar
```

Extract that tar into `/tmp/r211-baseline`, then run:

```text
python3 /tmp/r211-run-bundle/runners/validate-r211.py --repo /path/to/agent-factory --fixed /tmp/r211-fixed --baseline /tmp/r211-baseline --bundle /tmp/r211-run-bundle --work /tmp/r211-measurements
```

The driver records actual argv/cwd/exit/elapsed; runs Node/npm versions, npm ci(ignore-scripts), typecheck and full suite in the reconstructed fixed tree; verifies source hashes before/after; builds baseline; executes unchanged S03 runner and desired oracle on both trees; checks genuine legacy transition; then archives/builds historical ca6d0b6 R2 and b888082 command baselines and runs frozen comparisons. `/tmp/r211-measurements` must have no conflicting previously created baseline subfolders. Dependencies are installed only in these ordinary temporary copies.

Expected: final suite446/446 with0failed/0skipped; S03 baseline desired oracle **exit1,3passes/10failures** (harness itself exit0), fixed13/13, legacy transition13/13; frozen33, command37 and R2checker39 assertions. These counts overlap; do not sum them. R2 historical baseline5safe/3unsafe versus fixed8safe/0unsafe. The three baseline purposes are different; do not substitute current corrected R2 code for ca6d0b6 in the original R2 oracle.

To reproduce the two newly added safe-expectation regression matrices on unchanged baseline production with only a compiled test layer:

```text
python3 /tmp/r211-run-bundle/runners/baseline-regression.py --baseline /tmp/r211-baseline --fixed /tmp/r211-fixed --output /tmp/r211-red-layer --logs /tmp/r211-red-logs
```

Requires both target trees built by validation. This copies the baseline setup tree to a fresh ordinary folder and overlays three fixed compiled test/helper files; production remains baseline. Expected result: runner script succeeds only when Node test run exits1 with two meaningful product failures (false S03 drift and install replay). No real privileged/remote operation is invoked.

## Additional existing limitation: package PARTIAL

R21-F01/F02 checkpoint-cancel continuation is fixed (original13/13 and446 suite PASS). The broader S03-specific final apply→re-plan→primary-loss→recover→resume case still refuses with2 `plan_policy_mismatch`, both on baseline and fixed, direct and plan-first. No replay; an explicit fresh review resumes0. Original frozen C01 remains PASS, but does not cover this case. See report and additional recovery logs; A211-12/package are PARTIAL, production OPEN.

`runners/access-final-recovery.cjs` is the unchanged additional desired oracle (expects resume0 and exits1 on both trees). `access-final-recovery-measurements.cjs` records both branches with `desired_acceptance:false` and separately verifies the explicit-review workaround. Run either against a built tree; only owned temporary fixture files are changed. Do not count harness0 as product PASS.

## Limits

Local fake external adapters and owned child processes are not real-host qualification. Physical power loss, Ubuntu/VPS/VM/live/sudo/APT/systemd/SSH/UFW/Docker daemon/OAuth/provider/model/GitHub writes/deployment are NOT RUN. NodeAccessAdapter real cutover/timer/rollback remains a Q2 code blocker. R2.2 full C13/context binding, R3/Q1B/Q2–Q6, AF backlog and production remain OPEN. Next action is independent review of these local files, with no push/credentials/VPS requirement.
