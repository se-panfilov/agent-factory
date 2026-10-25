# Q1A-R2.1 local evidence

Do not commit, push, create branches/worktree/PR/merge/tags/releases or deploy. Do not use the Git index for reconstruction or packaging. Keep this prohibition in every future agent prompt unless the human explicitly changes authorization. Owner publication is not part of this task.

Canonical identity is bundle/identity.json; historical inputs may contain old identities and are not the tested R2.1 identity. Actual base is ca6d0b6f2a75f3c97a80468bbc2bdcbe2db7a4ff. Initial staged/unstaged/new-file owner layer was empty; input files and index were preserved.

Reconstruct into an empty ordinary temporary directory (no checkout/reset/branch/worktree):

    python3 runners/reconstruct.py --repo /path/to/agent-factory --bundle bundle --output /empty/temp/fixed
    python3 runners/validate.py --checkout /empty/temp/fixed --bundle bundle --logs /temp/validation

Use real Node major24 on PATH. Final recorded environment: Node v24.12.0/npm11.6.2, macOS15.5 arm64, UID501. Validation runs versions, npm ci --ignore-scripts --no-audit --no-fund, typecheck and full tests in that disposable copy, checking hashes before/after. The owner's dependencies are not removed.

Full-local.patch includes all product/source/tests/docs/report modifications and additions. New-files.tar is a redundant explicit payload, not an extra layer to apply after that patch. Deletions are empty. Packaging/report have separate hashes outside the tested setup input manifest. No self-referencing hash or fictional tested commit is used.

Create a separate base directory using git archive of the actual base, then npm ci/build setup there. For the unchanged historical R1.6 command checker only, also archive/build b888082167b5edc50977a6dcda997b40e962da8d (R1.5). This is its known unsafe baseline, not a new R1.6 finding. The R2 runner always compares the actual R2 baseline to fixed:

    python3 runners/measure-r21.py --baseline /temp/base --fixed /empty/temp/fixed --historical-command-baseline /temp/historical-r15 --inputs inputs --logs /temp/measurements

Original R2 runner and oracles are unchanged. Adapter/stage command modes remain separate; stage command mode uses synthetic archive/checkout/receipt plus actual hashes/argv/Node process. Real engine/S02 tests use fake APT only; TTL/counter producers are explicitly synthetic. Harness exit0 is not product acceptance: check-r21.py verifies baseline 5 safe/3 unsafe and fixed8 safe, zero effects for refusal, and positive controls. Old checkers retain 33 frozen assertions and 37 command assertions, with overlap (one command assertion aggregates the old33).

Old retained runner adapters are unchanged: r14-new-probes-directory-contract adds safe parent directory metadata only; r14-comparison-fresh-gates performs the required new remaining-plan approvals after Docker login. Their frozen input fixtures are applied identically to baseline/fixed. No new source-contract adapter was needed.

Baseline red proof: overlay red-layer/ on another base archive, npm ci/build, then `node --test setup/dist/tests/integration/q1a-r21-admission.test.js`. Build succeeds; 4 tests yield 1 pass/3 fail. The pass is the pre-existing gate-expiry control, the failures are stripped policy and expired/future gate-free plans. Do not overlay red tests on fixed. The recorded commands/elapsed/exits and raw logs are included. Intermediate key-order/TS-private-fixture/continuation bugs are retained as debug evidence and superseded by final validation, not counted as baseline exploits or final successes.

Final evidence: logs/final-validation/tests.log (429 pass, 0 fail/skip), comparison-commands.json, r2-product-assertions.json, comparison-assertions.json, command-assertions.json, acceptance-matrix.json and actual matrix rows. R21 tamper rows include before/after state/previous/manifest/journal/marker hashes. Separate worker rows record actual PIDs and persistent fake APT counters. Retained crash/fault matrices are extracted from the final full suite, not regenerated synthetic claims.

PolicyBasis is typed/bounded internal metadata in the existing stage versions map, not a new public schema or sidecar. Canonical producer policy and current inputs remain independent of submitted JSON. Existing generation/journal admission remains authoritative. Legacy known progress without a basis requires explicit review and current postcondition verification; unknown effects are never replayed. See bundle/report.md and setup/docs/plan-admission-r21.md after reconstruction for persistence/legacy/crash rules and narrow S03/S04 normalization.

Manifest covers all tracked setup inputs and new source/helpers/tests/docs/config/locks/schemas/fixtures/bootstrap/release files. Excludes node_modules/dist/Git metadata, audit/report/packaging and temporary outputs; secrets are not collected. SHA256SUMS covers every archive file except itself; ZIP checksum is external. Report/patch inside ZIP match the output folder bytes.

R2.2 full C13 serialization/context binding/remaining concurrency, R3/Q1B/Q2–Q6 and production stay OPEN. Real-host/VM/privileged/live qualification NOT RUN. No real sudo/APT/systemd/SSH/UFW/Docker-daemon, credentials/OAuth/provider/model/GitHub writes, VM/VPS provisioning or release/deploy were performed. Only owned local test processes ran. Owner's next action is to pass local report/patch/payload/identity/manifest/ZIP/checksum to review; no push, credentials, sudo or VPS is needed.
