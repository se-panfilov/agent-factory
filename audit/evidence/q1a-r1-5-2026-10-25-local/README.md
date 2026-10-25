# R1.5 local evidence

This package contains local-only code/test changes. No commit/branch/push/PR was created.

`bundle/` contains the complete adding patch (including new files and report), redundant new-files tar + SHA manifest, tested-files/deletions manifests and identity. Use base commit d7d141106aa50f58c8ec9ac7c3991b4d9b42e6e6. The base differs from audited 2eb0265 only by four committed audit inputs; see logs/base-delta.json. Initial owner layer was empty. Do not apply new-files.tar a second time after applying full-local.patch.

Reconstruct without changing repository/index/branches:

    python3 runners/reconstruct.py --repo /path/to/agent-factory --bundle bundle --output /empty/temp/checkout

Use real Node 24.x on PATH (final run used v24.12.0/npm11.6.2):

    node --version
    npm --version
    npm --prefix /empty/temp/checkout/setup ci --ignore-scripts --no-audit --no-fund
    npm --prefix /empty/temp/checkout/setup run typecheck --silent
    npm --prefix /empty/temp/checkout/setup run test --silent

Create a separate ordinary temporary base copy with git archive and install/build its setup dependencies. Run identical frozen measurements against both built trees:

    python3 runners/run-evidence.py --baseline /temp/base --fixed /empty/temp/checkout --inputs inputs --logs /temp/measurements
    python3 runners/check-results.py /temp/measurements

The original runner is retained. `r14-new-probes-directory-contract.cjs` only adds safe /etc and /etc/ssh directory metadata to the original N03 fixture. Otherwise fixed correctly refuses an uninspectable parent before reaching Include parsing. `r14-comparison-fresh-gates.cjs` only regenerates and approves remaining S04 gates after login; the reordered config/restart effects require that fresh approval. Frozen fixture definitions are identical between baseline/fixed. Harness exit 0 is not product acceptance.

Red demonstration: overlay `red-layer/` on a separate base archive (no production edits), npm ci/build, then `node --test setup/dist/tests/integration/q1a-r15-stages.test.js`. Build should succeed; tests should fail with all five unsafe baseline outcomes. Exact actual commands are logs/red-commands.json. Do not overlay red-layer on the fixed tree. The dependency-copy MODULE_NOT_FOUND log is a harness error, not counted as product evidence.

Final logs: reconstructed-tests.log (364 pass, 0 fail/skip), validation-commands.json, independent-final/*, acceptance-matrix.json, comparison-assertions-r15.json. Earlier targeted/interim/red failures are retained and superseded by final validation; do not treat their outcomes as the expected fixed behavior. Machine fault/crash matrices are extracted from final full log, not synthetic re-creations. Reader and foreign-lock behavior is asserted in the tests. SHA256SUMS covers every archive entry except itself; the ZIP checksum lives beside the ZIP. ZIP entries use a fixed timestamp and sorted paths.

Manifest covers all tracked setup files and new setup helpers/tests, including schemas, lock/config/bootstrap/release/fixtures and setup docs; excludes node_modules/dist/Git, external audit/report packaging and transient runtime outputs. No deletions. Report was packaged after testing; it is deliberately outside the tested-code hash. Final-code SHA manifest is compared before/after validation and on final patch reconstruction. Pre-format reconstruction records are labeled intermediate; the only final formatting edit was removing a space on an otherwise blank test line, followed by a complete validation rerun.

Actual host was macOS15.5 arm64, not qualified Ubuntu. All host/network/privileged mutation adapters were fake/intercepted; only local test children were killed. Live/VM/privileged/Docker/sudo/SSH/OAuth/model/GitHub qualification NOT RUN. NodeAccessAdapter actual cutover and marker-only rollback/timer remain Q2 code blockers. Arbitrary Include graphs and complete OS-level TOCTOU elimination are not claimed. Q1A/AF-05/AF-06/production remain open.
