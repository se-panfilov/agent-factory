# Q1A-R1.3 remediation report — 2026-10-24

**Repository:** `se-panfilov/agent-factory`  
**Baseline (required):** `13f6137e414a563f9f4e152f9145245e175a2d1b` (`audit fixes 6`)  
**Actual HEAD during remediation:** `13f6137e414a563f9f4e152f9145245e175a2d1b`  
**Tested code identity (working tree):** `WORKING_TREE_SHA256=27aa0adc98ee68a0e523f33ee26eb290fcfcd398a09b8fec43e014b414bda16e`  
**Evidence package:** `audit/evidence/agent-factory-q1a-r1-3-evidence-2026-10-24.zip`  
**Evidence SHA256:** `f436818388176d813ee8fdc1b5fcea8061c20afba996004cf2b7b5bd3745baff`  
**Code hash scope:** tracked/untracked code+tests+setup docs diff vs HEAD, excluding evidence packaging files and this remediation report to avoid self-reference.  

> This report covers only Q1A-R1.3 scope (R12-F01…R12-F05 follow-up) and does **not** declare AF-05/AF-06/Q1A or production qualification closed.

## 1) Implemented remediation scope

### Core execution/recovery

- `setup/src/core/engine.ts`
  - Apply path now persists operation progress with per-operation durable boundaries (`intent -> effect -> verify -> checkpoint`) and manifest checkpoint recording.
  - Recovery admission unified across marker/primary/previous/quarantine/journal/commit-manifest evidence; cleanup is blocked before marker deletion on conflicting evidence.
  - Generic containment for S08/S14 in generic `apply` kept.

- `setup/src/core/state.ts`
  - Commit manifest is part of state evidence inventory and missing-primary admission.
  - Missing-primary path now rejects foreign commit manifest (`state_commit_manifest_foreign`) before any fresh initialization path.
  - Recovery evidence references include commit-manifest artifact.

### Stage producer alignment

- `setup/src/stages/access.ts` (S03)
  - Required gates are operation-derived (no stage/operation gate representation mismatch).
  - Engine per-operation execution compatibility fixed (no false drift on expected intra-stage transitions).

- `setup/src/stages/docker.ts` (S04)
  - `resource-probe` is modeled as planned mutate operation with explicit receipt/resource alignment.
  - Added explicit `mark-managed-installation` operation/receipt.
  - Engine per-operation execution compatibility fixed while preserving unmanaged pre-existing Docker hard-blocking.

- `setup/src/stages/application.ts` (S05)
  - Plan/receipt resources aligned to staged release lifecycle (`application-release-staging`, `application-checkout`, `application-release`).
  - Structural plan capability mismatch removed (`requiredCapabilities` consistent with stage declaration).

- `setup/src/stages/verification.ts` (S07)
  - Receipt resource IDs aligned to planned `runner-offline-verification`.

- `setup/src/stages/project.ts` (S09), `setup/src/stages/service.ts` (S10)
  - Receipt resource IDs aligned with plan resources (`github-project-proposals`, `service-layout-and-unit`).

- `setup/src/stages/preflight.ts` (S01)
  - Receipt operation IDs now follow approved plan operation IDs (engine strict receipt admission compatibility).

### Tests

- Updated stage integration expectations for multi-operation receipts (`access`, `application`, `docker-host`).
- Extended recovery regression matrix in `setup/tests/integration/core-q1a-r1-state-recovery.test.ts`:
  - `T04` newer-manifest-vs-old-checkpoint blocked.
  - `T05` manifest-only/malformed/foreign manifest blockers.
  - `T06` `primary_restored` cleanup admission blocks conflicting quarantine evidence.
  - `T07` safe proven recovery works both direct and after plan-written marker; ambiguous case remains blocked.

### Documentation

- Updated protocol and boundaries: `setup/docs/privileges.md` (R1.3 operation durability + unified recovery evidence admission).
- Added full stage producer inventory: `setup/docs/stage-inventory.md`.

## 2) Same-fixture before/after comparisons (T01/T02 controls)

Source outputs:

- `audit/evidence/q1a-r1-3-2026-10-24/stage-compat-b0bc219.jsonl`
- `audit/evidence/q1a-r1-3-2026-10-24/stage-compat-13f6137.jsonl`
- `audit/evidence/q1a-r1-3-2026-10-24/stage-compat-fixed-working-tree.jsonl`
- `audit/evidence/q1a-r1-3-2026-10-24/stage-compat-summary.json`

| Stage | `b0bc219` | `13f6137` | R1.3 fixed working tree |
|---|---|---|---|
| S03 | `apply=2` (`plan_gate_representation_mismatch`), effects=0 | same | `apply=0`, `status=0`, per-op journal/checkpoints, adapter effects executed exactly once |
| S04 | `apply=0`, `status=0` | `apply=8` (`stage_effect_receipt_unplanned`) | `apply=0`, `status=0`, per-op receipts aligned, adapter effects executed exactly once |
| S05 | `apply=2` (`plan_capability_mismatch`) | same | `apply=0`, `status=0`, staged release resources/receipts aligned |
| S07 | `apply=0`, `status=0` | `apply=8` (`stage_effect_receipt_resource_mismatch`) | `apply=0`, `status=0`, resource identity aligned |

## 3) Recovery evidence and durability outcomes (R12-F02…F05)

Covered by full recovery suite plus added T-tests:

- `R1-04`, `J06`, `J07`, `J09`, `K04`, `K10`
- `T04`, `T05`, `T06`, `T07`

Key outcomes:

- manifest-only state is not treated as fresh installation;
- old checkpoint cannot override newer manifest generation;
- prepared decision remains immutable across substitution attempts;
- `primary_restored` cleanup performs full admission before marker removal;
- read-only diagnostics remain mutation-free.

## 4) Findings status mapping

### R11-F01…R11-F06

| Finding | Status | Evidence |
|---|---|---|
| R11-F01 | PASS | `K01`, `T04` |
| R11-F02 | PASS | `K07`, stage compatibility summary |
| R11-F03 | PASS | `K09`, no-op/verify-only apply traps |
| R11-F04 | PASS | `K04`, `J06` |
| R11-F05 | PASS | `K05`, `T05` |
| R11-F06 | PASS | `J06`, `J07`, `J09` |

### R12-F01…R12-F05

| Finding | Status | Evidence |
|---|---|---|
| R12-F01 (producer/engine alignment) | PASS | stage compat before/after JSONL, stage tests, S01 receipt-id alignment |
| R12-F02 (uniform recovery evidence rules) | PASS | `T04`, `T05`, `T06`, `T07`, `R1-04`, `J09` |
| R12-F03 (durable operation boundary) | PASS | `J01`, `J02`, `K10`; per-op journal/checkpoint in engine |
| R12-F04 (prepared/cleanup invariants) | PASS | `K04`, `J06`, `J07`, `T06` |
| R12-F05 (same-fixture evidence + mapping discipline) | PASS | evidence bundle, `acceptance-mapping.json`, correction note below |

## 5) K01…K12 and T01…T12 acceptance

Detailed mapping file: `audit/evidence/q1a-r1-3-2026-10-24/acceptance-mapping.json`

### K-matrix

| ID | Status | Evidence |
|---|---|---|
| K01 | PASS | `K01`, `T04` |
| K02 | PASS | `J01`, `J02`, `A05` |
| K03 | PASS | `R1-04`, `J06` |
| K04 | PASS | `K04` |
| K05 | PASS | `K05`, `T05` |
| K06 | PASS | `J06`, `J07`, `J09` |
| K07 | PASS | `K07` |
| K08 | PASS | `K08` (`config-images.test.ts`) |
| K09 | PASS | `K09` |
| K10 | PASS | `K10` |
| K11 | PASS | `J03`, `J08`, `J10`, `R1-12` |
| K12 | PASS | Node 24 required-command run + full test log + reproducible evidence zip/checksum |

### T-matrix

| ID | Status | Evidence |
|---|---|---|
| T01 | PASS | stage compat JSONL across `b0bc219` / `13f6137` / fixed |
| T02 | PASS | structural admission now consistent (`access`, `application`, `docker-host` integration tests + stage inventory) |
| T03 | PASS | `J02` + `K10` (durable progress + interruption/cross-process guard) |
| T04 | PASS | `T04` |
| T05 | PASS | `T05` |
| T06 | PASS | `T06` |
| T07 | PASS | `T07` |
| T08 | PASS | `R1-04`, `J09` + commit-manifest admission assertions in `T04/T05` |
| T09 | PASS | `J06`, `J07`, `K04` |
| T10 | PASS | `K10`, `R1-11` |
| T11 | PASS | `J01`, `J02`, `K09`, `K08` |
| T12 | PASS | Node24 run + full suite pass + identity/evidence bundle with checksum |

## 6) Required Node 24 commands (actual run)

Log: `audit/evidence/q1a-r1-3-2026-10-24/node24-required-commands.log`

Executed with real Node 24 binary:

```bash
node --version                                      # v24.12.0
npm --version                                       # 11.6.2
npm --prefix setup ci --ignore-scripts --no-audit --no-fund
npm --prefix setup run typecheck --silent
npm --prefix setup run test --silent                # 127 passed, 0 failed
```

## 7) Reproducibility and package contents

Evidence directory: `audit/evidence/q1a-r1-3-2026-10-24/`

Includes:

- `node24-required-commands.log` (full test log)
- stage compat probes (`b0bc219`, `13f6137`, `fixed`) + summary
- `working-tree.patch`
- `git-status.txt`, `git-status-short.txt`
- `file-lists.txt`
- `working-tree-hash.txt`
- `fault-matrix.json`
- `acceptance-mapping.json`

Evidence package and checksum:

- `audit/evidence/agent-factory-q1a-r1-3-evidence-2026-10-24.zip`
- `audit/evidence/agent-factory-q1a-r1-3-evidence-2026-10-24.zip.sha256`

## 8) Correction note to previous R1.2 report

This R1.3 report corrects packaging/mapping discipline for follow-up acceptance:

- explicit mapping now includes **both** historical K-matrix and new T-matrix in machine-readable form (`acceptance-mapping.json`);
- code identity now includes explicit working-tree content hash (`WORKING_TREE_SHA256`) plus attached patch and file lists;
- package checksum is published separately and tied to this report’s evidence zip.

Previous results are preserved as historical records; they are not rewritten retroactively.

## 9) Qualification status separation

- **Code status:** PASS for R1.3 scope.
- **Local test status:** PASS (`typecheck` + full `npm --prefix setup run test --silent` on Node 24).
- **Real-host / privileged qualification:** **NOT RUN** for sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model/provider/GitHub writes/VM/VPS/power-loss.

Next step remains human review of this R1.3 package; no automatic R2/Q1B start in this report.
