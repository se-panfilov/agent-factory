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


## R1.5 current-content execution admission

Every application command path (observe/replan, explicit verify, probe operation, repeat apply/resume) checks release/config-bound materialization evidence, command entries and current deployed bytes **before** entering the probe adapter. Required command entry files must be canonical relative paths present in `content_hashes`; only the installed Node interpreter/`node` plus a bound script, or a bound relative executable, is supported. Shell/sudo/external/unbound entries are refused. The actual adapter repeats the content check before each command. Root and every content path component must have the expected owner, safe write permissions, regular file/directory type and no symlink. Missing/unreadable/unsafe or mismatched content returns exit 9 `s05_deployed_integrity_failed`, with zero application commands. Missing required commands returns exit 5; false probe returns exit 5; a thrown operational probe error returns exit 6. Integrity refusal is not a runner failure.

A successful materialization receipt binds the application directory, archive SHA, source commit and (new receipts) canonical release manifest SHA. Legacy R1.4 receipts lacking the manifest SHA are accepted only with the same journal/config binding, exact directory/archive/commit, archive manifest reinspection and current content validation. A source commit marker alone never authorizes execution. Plain `status` does not refresh, execute or change evidence. Fresh successful probes remain mandatory; receipt identity does not replace them. A discovered failure cannot publish probe success or permit downstream effects. These checks do not claim to eliminate OS-level races between reading a file and executing it.

## R1.6 command identity and argv grammar

The R1.5 V03 claim was too broad: hashed `.cjs`/extensionless entries could still run a CWD decoy, and a hashed `--eval` filename could authorize Node options. R1.6 fixes that distinct admission/execution defect; the historical R1.5 report is retained.

`prepareOfflineCommands` is the single source of grammar and executable identity for both stage admission and the actual probe adapter. It prepares both required command keys before either invocation. Each immutable prepared command contains its kind, reviewed content entry, absolute executable and exact final argv:

- Node: `["node" | exact-installed-pinned-node-path, canonical-relative-file, ...applicationArgs]`. No manifest runtime options are supported before the entry. A leading `-`, stdin `-`, delimiter `--` or any option-shaped entry is refused with exit 9 even when that filename exists in the content map. The file must be bound to `content_hashes` and pass current ownership/type/content checks.
- The Node executable is the installed pin, outside the application content map. Its entry is always made absolute under the deployment root, independent of suffix (`.js`, `.mjs`, `.cjs`, `.ts`, extensionless). A nested name such as `bin/-runner.cjs` is allowed. No global CWD change or suffix-dependent fallback is used.
- Direct executable: `[canonical-relative-file, ...applicationArgs]`. The executable itself must be a content-map entry and is invoked by its absolute deployment path. No PATH lookup or external shell/sudo/env binary is admitted. Direct arguments are not rewritten as Node entries.

Application arguments after the file retain their order, values and array boundaries, including spaces, quotes, relative filenames and strings such as `--eval`. The adapter appends one `--help` after them. No Node delimiter is needed: the first argument is the absolute file path, so subsequent strings are application arguments. This placement is tested with actual Node 24 processes. These tests do not establish M0/service qualification or implement arbitrary loaders/runtime flags.

Both prepared commands are validated before the first child, and the existing current content/metadata check runs again before **each** help command. Drift between verify-help and stop-help refuses the second command. Missing mandatory commands, negative/timeout results and operational errors retain their typed failures. Trust receipts, manifest/config/archive binding, bounded process behavior and plain read-only status remain unchanged. This deterministic identity fix does not claim to eliminate OS-level hash-read/exec TOCTOU.
