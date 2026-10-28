# Q1A-R3.1 local evidence, 2026-10-28

No commits/push/branches/worktree/PR/staging/index (including git add -N)/merge/tag/release/deploy. No remote messages/mutations, real sudo/APT/systemd/SSH/UFW/Docker-daemon/credentials/OAuth/provider/model/VM/VPS actions. These bans also govern any later AI-agent prompts. Owner publication is separate.

Named reconstruction base: **ad274add0a7ed0a5e0923363ce9e9000bef7c013**, tree63f15f339f7520f382ec9e5eb485c7572d5304b7. It differs from reviewed product e217f397b952942b62e847788dc2e6698ad6d7e5 only by audit inputs. Exact product baseline is still e217/tree41fe20304e340133bd7e217aceea674c466015e3. All270 previous tested inputs match its plain baseline archive.

## Final result and scope

R31-F01…F04 code-level fixes: strict cancellation format validation; discovery independent of advisory inventory; structured typed emergency failures/publication/confirmed prefix; mandatory explicit ProcessAdapter in current callers. No lock/mutex/recovery/review rewrite. Public CLI/config/C13/state/pins/dependencies unchanged.

Final intended attempt2 is one complete run with its own ledger:645/645 tests (old589 retained, new56); R31/R3 each14; boundary14/context5; S03/genuine v1/v2 each13; accepted honest O01/fresh-review no-replay; mapped frozen33, command37 and R2-checker39 (overlap, do not sum). Extra machine-outcome checker14; current-call AST census22; inherited/R3 completeness controls. Exact ordered IDs/names/counts/META, predicates and exits are checked. No splicing/instrumentation in final run.

Actual Node24.22.1/npm11.17.0, macOS/APFS UID501. Explicit injected application identity1000/factory/Ubuntu24/amd64 is separate from actual FS identity. Actual second Linux/UID0 isolated environment is NOT RUN; no root/owner/OS check was weakened. Historical O02 cause remains OPEN. Original O01/C01 auto-success oracles are historical known-red, accepted mapping unchanged.

Main tested-files.sha256 covers167 source/config/schema/package/test inputs and119 external runner/fixture/reference inputs (286). It includes actual mapped bytes, not an original checksum substituted for a modified runner. Ledgers identify which executable scripts ran; originals are preserved as reference/known-red inputs. All inputs are checked against both the final plain snapshot and current checkout before/after.

## Reconstruct once, without index

Use an empty owned directory and the exact named Git object:

```sh
mkdir /absolute/new-owned-directory
git archive ad274add0a7ed0a5e0923363ce9e9000bef7c013 | tar -x -C /absolute/new-owned-directory
cd /absolute/new-owned-directory
git apply --check /absolute/full-local.patch
git apply /absolute/full-local.patch
shasum -a 256 -c audit/evidence/q1a-r3-1-2026-10-28-local/tested-files.sha256
```

Full-local.patch is applied **once**. No new-files.tar exists. Owner-layer.patch + agent-only.patch are a disjoint **alternative** to full-local.patch, never an addition to it. Owner layer contains only the three originally staged pyc files absent from the named base, with exact bytes preserved. Earlier owner audit files/ZIP are already in named base. Patch assembly uses ordinary directory copies and git diff --no-index --binary; neither index nor staging enrolls files.

Unzip evidence.zip to a **separate inspection directory**. Its mirrored evidence files/report are for inspection, not another overlay onto the already patched repository. Full patch already installs source/report/evidence payload. Generated capsule metadata is excluded from patch self-reference: full-local.patch, agent-only.patch, owner-layer.patch, evidence.zip/sha256, reconstruction.json, package-ledger.json, package-files.sha256, final-preservation.json, zip-verification.json, and reconstruction/final-identity stdout/stderr. These are packaging metadata, not missing executable inputs. Old ZIP/node_modules/dist/whole repo/temp trees are not transported.

Reconstruction.json records actual check/apply exits, all286 tested hash matches, payload/report/owner matches. Package-files.sha256 checks ZIP members except itself; evidence.zip.sha256 checks the ZIP. CRC and member hashes are verified before delivery. Owner index bytes/hash are compared to the full initial capture; no historical missing R3 index bytes are invented.

## Re-run validation safely

Use Node24, only injected adapters and owned temp storage:

```sh
npm --prefix /absolute/reconstructed/setup ci --ignore-scripts --no-audit --no-fund
npm --prefix /absolute/reconstructed/setup run typecheck --silent
npm --prefix /absolute/reconstructed/setup run test --silent
node /absolute/evidence/runners/r31-boundary-probes.cjs /absolute/reconstructed > r31.jsonl 2> r31.stderr
python3 /absolute/evidence/runners/check-r31-boundaries.py --mode desired r31.jsonl
python3 /absolute/evidence/runners/check-r31-outcomes.py r31.jsonl
```

For full inherited validation use inherited/runners/validate-r31.py with --repo pointing to the repository holding the exact historical Git objects, --fixed to the reconstructed ordinary directory, --bundle to a separate fresh copy of inherited, --work to a new owned directory. Main and inherited manifests use repository-relative paths; their actual runner copies must exist under the same audit/evidence/q1a-r3-1-2026-10-28-local prefix. The script verifies both actual --repo and --fixed bytes; do not substitute the inspection ZIP layout for that source layout. Historical commits are explicit in the driver; it does no fetch. See runners/MAPPING.md for identity/FS API bridges and unchanged historical oracles.

## Raw attempts and evidence

- initial/: full pre-edit HEAD/tree/status, index bytes/hash/entries, staged/unstaged patches and input hash inventory. Three owner pyc preserved. No HEAD/index transition observed during this pass.
- inputs/: exact reviewer checksum/README/identity and independent270 baseline hash check. R3-evidence.zip SHA2561af65770d6a9d48d8fe520905b01488d7eb56e2066b187d4e34c4bce24591293 was read and recomputed; old ZIP not nested.
- r31-baseline.jsonl/stderr, baseline-ledger and oracles: exact e217/Node24 original14,7 desired red; collector0, baseline0, desired1. Deliberate red is not product acceptance or runtime failure.
- reviewer-reference/: unmodified supplied raw root UID failure/diagnostic/runner mapping observations, separate from our actual UID501 runs.
- targeted*.stdout/stderr and callers-targeted: meaningful development probes; not spliced into final matrices. Initial127/127, identity/admission7/7, final R31 targeted56/56.
- attempt-1/: intended run stopped at typecheck2 on new test `.map(JSON.parse)` callback type (TS2345), before suite/matrices. Exact old test source/manifest/raw retained; replace that one source file only when separately reproducing this historical failed attempt. The correction is `.map(line => JSON.parse(line))`, no compiler-policy change. Not an unexplained incomplete runner; no diagnostic keepalive required.
- inherited/logs/: one final complete ledger from ci/typecheck/suite through all original/mapped matrices and independent oracles. Source hashes before/after match286; O02 not claimed fixed.
- final-checks-ledger, final-inherited-check.json, final-r31-check.json: actual final completeness/source audits, both exit0. Package-ledger and reconstruction.json cover packaging checks separately.

NOT RUN: actual root-isolated Linux/ordinary-owner PAM host session, privileged/live/Docker-daemon paths, VM/VPS, physical power loss, full process tree/deadline qualification, hostile root/OS filesystem isolation and production M0/M1/M2 factory deployment. S05 currently depends on Docker; no Docker-free profile/proof is invented. Missing daemon/status capabilities remain truthful manual blockers, no automatic install/retry/unpause.

Owner action: send the five requested files to reviewer. No privileged run, production VPS or credentials are requested.
