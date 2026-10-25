# R1.6 local evidence

No commits, push, branches, worktree, PR, merge, tags, releases or deploy. Do not use git index for reconstruction/packaging. Initial owner layer was empty; no owner work was discarded. These prohibitions apply to any follow-up agent prompt unless the human explicitly changes authorization.

`bundle/` contains identity, report, full-local.patch, new-files.tar/json, tested-files.sha256 and deletions.json. Patch includes all new source/helper/test/report files; the tar is a redundant alternative, not an extra layer to apply after the patch. Packaging itself is a separate layer (no self-referencing hash). All product/source/test/docs/report changes are encoded. No source deletions.

Reconstruct in an ordinary empty temporary folder, using the repository only as the source of the actual base commit (420e5456d3e05b1c4f9b7202cacebb82baaf61eb):

    python3 runners/reconstruct.py --repo /path/to/agent-factory --bundle bundle --output /empty/temp/fixed
    python3 runners/validate.py --checkout /empty/temp/fixed --bundle bundle --logs /temp/final-validation

Use actual Node major24 on PATH. Recorded final run: Node v24.12.0/npm11.6.2, macOS15.5 arm64, UID501. The validation runner performs version checks, npm ci --ignore-scripts --no-audit --no-fund, typecheck and the complete test suite, checking manifest before and after. It operates only on that disposable copy, not the owner's dependencies.

Create a separate ordinary temporary base folder with git archive of that base; npm ci/build setup there. No branch, commit or index change is needed. Preserve exact base bytes and run the original audit harness on both built trees:

    python3 runners/command-measurements.py --baseline /temp/base --fixed /empty/temp/fixed --logs /temp/commands
    python3 runners/run-evidence.py --baseline /temp/base --fixed /empty/temp/fixed --inputs inputs --logs /temp/frozen
    python3 runners/check-results.py /temp/frozen

`check-r16.py` expects command JSONL files plus `comparison-assertions.json` (the output of check-results.py) in its argument directory. It checks actual product outcomes; harness completion/exit0 is not acceptance. Adapter/stage modes remain separate, the latter explicitly synthetic archive/checkout/receipt. The original command-identity runner and fixtures were not adapted. Both files are checked against the audit ZIP bytes.

The old retained R1.5 runner adaptations remain unchanged: r14-new-probes-directory-contract adds only safe parent-directory metadata; r14-comparison-fresh-gates re-approves remaining S04 plan after a new group session. Frozen fixture data is identical on both trees. `inputs/` includes both old frozen fixture sets and the R1.5 audit/task; no separate private archive or session folder is required.

Red proof: overlay red-layer/ onto another base archive, npm ci/build, then `node --test setup/dist/tests/integration/q1a-r16-commands.test.js`. Build succeeds and all three initial safe expectations fail. Do not overlay red tests on fixed. Exact red commands/exit and raw output are included. Expanded intermediate errors (caller path alias, executable mode, empty schema-invalid argument) are harness issues, not product failures; final fixed logs supersede them.

Final evidence: logs/final-validation (397 pass, 0 fail/skip), logs/command-identity-assertions.json, logs/comparison-assertions.json (33 retained assertions), real-commands.json (actual binary/argv/CWD/stdout/schema), grammar-refusals.json (option files and zero-call results), probe-controls.json, acceptance-matrix.json and final reconstruction/repository checks. Historical fault/crash matrices are extracted from this final full test run. Do not substitute historical report acceptance claims for these assertions.

Manifest covers every tracked setup input and the new helpers/tests: source/config/schema/locks/bootstrap/release/fixtures/setup docs. Excludes dependencies/dist/Git metadata, external audit/report/packaging and temporary outputs. Report has a separate hash. All archive entries except SHA256SUMS itself are covered by the internal checksums; ZIP hash is external.

Only local stdout/argv Node/shebang fixtures and owned crash-test children run. Inspector/preload/import negatives never reach a child. No real sudo/APT/systemd/SSH/UFW/Docker daemon, credentials/OAuth/provider/model/GitHub/network/provisioning/VM/release/deploy qualification. Production, Q1B/Q2, actual privileged executor/cutover and OS-level TOCTOU remain OPEN; real-host qualification NOT RUN. The owner's next action is to pass these local artifacts to review, not publish or deploy them.
