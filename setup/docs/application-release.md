# S05 application release deployment

S05 deploys an **already reviewed application release artifact** (M0 for supervised, M1 for service) and never creates runner code on the host. The stage accepts only owner-provided release archives plus `release.source_commit`/`release.sha256` from config and enforces immutable deployment semantics.

## What S05 validates before mutation

- archive exists and its SHA-256 equals config pin;
- `deployment-manifest.json` exists and matches `application-manifest.schema.json`;
- manifest `source_commit` equals configured `release.source_commit`;
- required capabilities are present (`runner-readonly` for supervised; service commands for service profile);
- archive has no traversal paths, symlink/hardlink entries, or special files;
- existing checkout is not dirty, not on mutable branch, and origin matches allowlist.

If M0 is absent/invalid, S05 returns an explicit blocker (`s05_m0_release_missing` or `s05_deployment_manifest_invalid`) with exit code 5.

## Safety properties

- no destructive git reset/clean/stash;
- no auto-adoption of wrong branch/remote;
- no deployment from mutable/untrusted content;
- no uncontrolled shell execution;
- no automatic build execution without owner gate.

S05 always requires owner gates:

- `s05-application-release-reviewed`
- `s05-source-commit-reviewed`
- `s05-dockerfile-build-reviewed`

The third gate is mandatory for this release to ensure explicit review of Dockerfile/build-context risk before any trusted build-related workflow in later stages.

## Apply/verify behavior

1. Re-observe and validate preconditions (drift-safe).
2. Extract release archive into isolated staging under `setup_cache_dir/application-release/<source_commit>/...`.
3. Verify every `content_hashes` entry from deployment manifest.
4. Materialize a new immutable checkout in `paths.application_dir` (no reset of existing dirty tree).
5. Run offline `--help` probes for `runner_verify` and `runner_stop`.

Any hash/probe mismatch fails closed with explicit stage error and next action.

R1.4 execution detail: production engine supplies one operation per apply call. Extraction and materialization each use their own operation-owned staging and each declare extraction/hash verification in the plan (two extractions on a fresh deploy). No unverified process-local staging cache is reused. A matching deployed commit can only support the materialization operation's no-op after deployed content verification; it cannot prove offline probes. The probe receipt records the exact archive SHA and commit. Apply, stage-wide verify, and observation of an existing deployment execute current bounded offline probes. Plain recorded status/gate diagnostics do not spawn commands and retain their recorded age. A failed explicit verify invalidates the recorded verified stage.
