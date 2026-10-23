# Q1A-R1.1 remediation report — 2026-10-23

**Repository:** `se-panfilov/agent-factory`  
**Branch:** `fix/q1a-r1-journal-recovery`  
**Baseline under review:** `4d536cc4917e3f6f468fe41a62e2cfb31718361c`  
**Supersedes:** `docs/audits/remediation-q1a-r1-2026-10-23.md` for R1 journal/recovery conclusions only.

## 1) Verified code/test tree identity

- Tested remediation commit: `c123cd3b8793dcf96ab24836feb4acfe2f3f3bf9`
- `git rev-parse HEAD` at final packaging: `c123cd3b8793dcf96ab24836feb4acfe2f3f3bf9`
- Working tree status at final packaging: **dirty** (uncommitted evidence artifacts and report updates for this handoff)
- No history rewrite, no reset, no merge.

Relevant changed files in this pass:

- `setup/src/adapters/filesystem.ts`
- `setup/src/core/state.ts`
- `setup/src/core/engine.ts`
- `setup/tests/unit/apt.test.ts`
- `setup/tests/integration/core-engine.test.ts`
- `setup/tests/integration/core-q1a.test.ts`
- `setup/tests/integration/core-q1a-r1-state-recovery.test.ts`
- `audit/evidence/q1a-r1-1-4d536cc/*`
- `agent-factory-q1a-r1-evidence-4d536cc.zip`
- `setup/docs/privileges.md`
- `setup/docs/troubleshooting.md`
- `setup/docs/qualification.md`
- `docs/audits/remediation-q1a-r1-2026-10-23.md` (superseding note only)
- `docs/audits/remediation-q1a-2026-10-23.md` (superseding note only)
- `docs/audits/remediation-q1a-r1-1-2026-10-23.md` (this report)

## 2) Implemented protocol (attempt → effect evidence → verification → checkpoint)

Internal journal/recovery protocol was aligned as versioned, strict, and fail-closed:

| Step | Durable artifact | Required identity | Failure outcome |
|---|---|---|---|
| Intent | `events.jsonl` record `code=intent` | `installation_id + attempt_id + operation_id + stage + sequence + checksum` | `journal_recovery_required` |
| Effect evidence | `events.jsonl` record `code=effect` | Same attempt identity; valid transition after intent | `journal_recovery_required` |
| Verify | `events.jsonl` record `code=verify` | Same attempt identity; valid transition after effect | `journal_recovery_required` |
| Checkpoint | `events.jsonl` record `code=checkpoint` + `state_hash` | Same attempt identity; valid transition after verify | `journal_recovery_required` |
| Recovery decision | `recovery-required.json` with `recovery_commit.phase=prepared` | Candidate hash + source persisted before restore | `exit 8`, marker preserved |
| Recovery commit | Primary rewrite via `restorePrimaryState` (no `saveState` rotation) + `recovery_commit.phase=primary_restored` | Candidate trust checks passed | `exit 8`, retryable |
| Cleanup | Marker removal after committed restore | Serialized lock path | `recovery_marker_clear_failed`/`recovery_commit_pending_cleanup` with idempotent retry |

Protocol constraints enforced:

- Attempt ID is distinct from operation ID (old receipt cannot close new attempt).
- Strict sequence/checksum/type/transition validation.
- Legacy journal format is treated as uncertainty (not as completion proof).
- Reader stays read-only; quarantine/repair only in writer/recovery paths.

## 3) N00/N01/N02/N03/N06/N07 failing-before vs passing-after

Baseline probe run was executed in a clean detached worktree at `4d536cc` with temporary non-committed scripts.  
Post-fix probe run was executed with equivalent temporary scripts against the current working tree.

| Probe | Baseline (`4d536cc`) | After fix (`fix/q1a-r1-journal-recovery`) |
|---|---|---|
| N00 (real S00→S01) | `plan=0`, `apply=8` (`journal_recovery_required`) | `plan=0`, `apply=0`, `status=0`, `resume=0` |
| N01 (real S02 install) | `plan=0`, `apply=0`, `status=8`, `resume=8` | `plan=0`, `apply=0`, `status=0`, `resume=0` |
| N02 (real S02 no-op) | `plan=0`, `apply=0`, `status=8`, `resume=8` | `plan=0`, `apply=0`, `status=0`, `resume=0` |
| N03 (`intent(X), receipt(X), intent(X)` + old checkpoint) | `recover=0` | `recover=8` (`journal_recovery_required`) |
| N06 (corrupt newer primary + old previous + empty journal) | `recover=0` after corruption marker path | `recover=8` (`recovery_unresolved`) |
| N07 (quarantine fault + marker-clear fault) | retry stuck at `recover2=8` (`recovery_candidate_invalid`) | `recover1=8` (`recovery_marker_clear_failed`), `recover2=0` idempotent completion |

## 4) Acceptance J01…J12

Acceptance coverage is implemented in `setup/tests/integration/core-q1a-r1-state-recovery.test.ts` (`J01`…`J11`), plus full-suite execution for `J12`.

| ID | Result | Evidence |
|---|---|---|
| J01 | PASS | `J01 real S00->S01 lifecycle...` |
| J02 | PASS | `J02 real S02 install/refresh/no-op repeat...` |
| J03 | PASS | `J03 new attempt, duplicate/gap/reorder/stage mismatch...` |
| J04 | PASS | `J04 effect evidence without verify/checkpoint...` |
| J05 | PASS | `J05 corrupt newer in-flight... remains unresolved` |
| J06 | PASS | `J06 interrupted recovery boundaries keep candidate durable...` |
| J07 | PASS | `J07 committed recovery with marker cleanup failure...` |
| J08 | PASS | `J08 malformed marker, oversized/growing journal and EACCES...` |
| J09 | PASS | `J09 fault injections assert exact hit and fail when disabled...` |
| J10 | PASS | `J10 pending evidence blocks ordinary effects...` |
| J11 | PASS | `J11 child writer lock barrier blocks recover...` |
| J12 | PASS | Full setup suite passes with added acceptance tests (`116 passed, 0 failed`) |

## 5) J06/J09 injected fault table (actual injections)

### J06 (recovery boundaries, independent fixtures per boundary)

| Boundary | Fault injected | Hit count | Durable evidence after fault | Retry result |
|---|---|---:|---|---|
| marker-prepare-write | `writeText(recovery-required.json.tmp-*) => EIO` | 1 | marker/state evidence preserved, no false completion | second recover succeeds |
| marker-prepare-fsync | `fsyncFile(recovery-required.json.tmp-*) => EIO` | 1 | marker/state evidence preserved | second recover succeeds |
| marker-prepare-rename | `rename(recovery-required.json.tmp-* -> recovery-required.json) => EIO` | 1 | marker/state evidence preserved | second recover succeeds |
| primary-write | `writeText(state.json.tmp-*) => EIO` | 1 | previous candidate remains parseable and trusted | second recover succeeds |
| primary-fsync | `fsyncFile(state.json.tmp-*) => EIO` | 1 | previous candidate remains parseable and trusted | second recover succeeds |
| primary-rename | `rename(state.json.tmp-* -> state.json) => EIO` | 1 | previous candidate remains parseable and trusted | second recover succeeds |
| primary-fsync-dir | `fsyncDir(state dir) => EIO` at primary commit boundary | 1 | no fallback corruption; lock-only cleanup may be needed if stale lock remains | second recover succeeds (after lock-only cleanup when required) |

### J09 (fault quality + negative control)

| Case | Fault injected | Hit count | Expected outcome | Result |
|---|---|---:|---|---|
| Fault-on | `rename(state.json.tmp-* -> state.json) => EIO` | 1 | recover non-success with preserved evidence | PASS |
| Fault-off (fresh fixture) | none | 0 | recover success | PASS |

## 6) Commands executed on Node 24 and outcomes

```bash
PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" node -v
# v24.12.0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup ci --ignore-scripts --no-audit --no-fund
# exit 0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run typecheck --silent
# exit 0

PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" npm --prefix setup run test --silent
# exit 0 (116 passed, 0 failed)
```

## 7) R1/A/AF history and superseding status

- `docs/audits/remediation-q1a-r1-2026-10-23.md` remains historical for R1, but is superseded by this report for journal/checkpoint/recovery conclusions.
- `docs/audits/remediation-q1a-2026-10-23.md` remains historical for A/AF matrix at that date; this pass adds newer evidence for AF-05/AF-06 partial closure boundaries only.
- This report **does not** claim Q1A/AF-05/AF-06 fully closed and does not start R2/Q1B.

## 8) Remaining unknown/blocked boundaries (explicit)

- No live apt/Docker/provider reconciliation proof in this pass; unknown external side effects remain blocked by recovery barriers.
- No process-tree supervisor or per-effect cancel in-flight orchestration beyond current guardrails.
- Public `restore`/`update` remain intentionally blocked (containment preserved).
- VM/VPS, real sudo/systemd/SSH/firewall/OAuth/model/provider checks are **NOT RUN**.

## 9) Reproduction bundle

- Attached archive: `agent-factory-q1a-r1-evidence-4d536cc.zip`
- Source evidence directory (included in zip): `audit/evidence/q1a-r1-1-4d536cc/`
