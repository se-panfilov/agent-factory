# Q1A remediation report — 2026-10-23

> **Historical note (A/AF matrix update):**  
> This report remains the historical Q1A snapshot. For newer R1.1 journal/recovery evidence and superseding AF-05/AF-06 boundary details, see `docs/audits/remediation-q1a-r1-1-2026-10-23.md`.

**Repository:** `se-panfilov/agent-factory`  
**Working branch:** `fix/core-q1a`  
**Source baseline commit (requested):** `eb187a845820aed6ef7ebafcbd2f9ac9853179a3`  
**Previous remediation reference:** `91c9899662ac8b524b874a03ce3e831cb1835d01`  
**Verified source tree before edits:** HEAD=`eb187a845820aed6ef7ebafcbd2f9ac9853179a3` (dirty tree preserved, no reset/rollback)

## Scope of this pass

Cross-cutting Q1A core remediation in `setup` (engine/state/gates/lock/admission), regression tests, and docs.  
No live/VM qualification, no real privileged host operations, no OAuth/model/GitHub write/provisioning.

## Files changed in this pass

- Core:
  - `setup/src/core/engine.ts`
  - `setup/src/core/state.ts`
  - `setup/src/core/gates.ts`
  - `setup/src/core/lock.ts`
  - `setup/src/core/plan.ts`
- Tests:
  - `setup/tests/integration/core-q1a.test.ts` (new)
  - `setup/tests/integration/core-engine.test.ts`
  - `setup/tests/integration/verification-auth.test.ts`
- Docs:
  - `setup/docs/privileges.md`
  - `docs/audits/remediation-q1a-2026-10-23.md` (this file)

## Invariants changed (Q1A)

1. `verify` and `status` use stage-status aggregation for envelope/exit mapping (no success-shaped `ok` on blocked mandatory observation).
2. Stage-only gates are persisted and included in required approvals even when `operations=[]`.
3. Gate TTL semantics are strict: `now >= expires_at` => expired; expired gate approve returns non-zero and does not silently renew TTL.
4. Gate identity is no longer keyed only by gate id; upsert uses `(id, plan_hash, operation_id)` to avoid cross-operation overwrite.
5. Generic `apply` admission validates profile/capabilities/dependency ordering/closure and stage↔operation gate representation consistency.
6. Generic `apply` blocks dedicated-command stages (`S08`, `S14`) and no longer suggests generic `S14` fallback for update entrypoints.
7. `restore`, `update plan`, `update apply`, `inference probe` are explicit blocked containment paths (before mutation).
8. Cancel checks happen before first effect, between stages, and before each stage apply (stage B no longer runs after stage A cancel request).
9. Optional stage with no effects may remain `skipped` without being forced into `postcondition_not_verified`.
10. Corrupted/missing state recovery barrier is durable (`recovery-required` marker); repeated loads do not silently reinitialize into fresh state.
11. Ordinary writer routes are serialized through installation lock; `status` without refresh remains read-only snapshot.

## Q1A acceptance matrix (A01–A16)

| ID | Result | Evidence |
|---|---|---|
| A01 | **PASS** | `setup/tests/integration/core-q1a.test.ts`: `A01 subprocess lifecycle preserves approvals across process boundaries and cwd changes` |
| A02 | **NOT RUN** | No subprocess regression yet for real S05–S07 factories in this pass (existing S05/S06/S07 tests are in-process integration) |
| A03 | **PASS** | `A03 verify does not report success for unsupported host observation` |
| A04 | **PASS** | `A04 optional disabled/skipped stays successful and does not become verified` |
| A05 | **PASS** | `A05 expired gate cannot be approved and stays expired in persisted state` |
| A06 | **PASS** | `A06 stage-only required gate is persisted even without operations` |
| A07 | **NOT RUN** | Partial coverage exists (`validatePlanConsistency rejects stale desired hash`, `S04 apply rejects plan when daemon config hash drifted after approval`), but full tamper matrix from A07 not fully implemented as one acceptance test |
| A08 | **NOT RUN** | Full fault-injection matrix for every current/previous/journal write/fsync/rename boundary not implemented in this pass |
| A09 | **PASS** | `A09 corrupted state remains recovery-required across repeated loads` |
| A10 | **NOT RUN** | Specific scenario “previous older than latest intent + effect happened without receipt + safe resume decision” not fully covered |
| A11 | **NOT RUN** | Partial concurrency evidence exists (`apply returns exit 7 on duplicate invocation lock`, lock recovery tests), but full writer-concurrency matrix not completed |
| A12 | **NOT RUN** | Partial lock-owner scenarios exist; full PID reuse/reboot/partial owner/concurrent recover matrix not completed |
| A13 | **PASS** | `A13 cancel requested in stage A stops before stage B mutation` |
| A14 | **PASS** | `A14 update and restore public entrypoints stay explicitly blocked` + `verification-auth` regression for S08 via resume/apply policy blocker |
| A15 | **PASS** | `A15 CLI parse errors return sanitized JSON envelope with exit 2` (unknown/duplicate/missing/rejected enum; sanitized envelope shape) |
| A16 | **PASS** | Positive controls: `plan/apply/resume flow writes intent+receipt and remains idempotent`, `S02/S04/S14` idempotence and guarded re-run tests |

## Commands run (truthful)

| Command | Exit | Result |
|---|---:|---|
| `npm --prefix setup ci --ignore-scripts --no-audit --no-fund` | 0 | Success; npm reported engine warning (`package requires node >=24 <25`, runner node was `v26.5.1`) |
| `npm --prefix setup run typecheck --silent` | 0 | Success |
| `npm --prefix setup run test --silent` | 0 | Success: **93 passed, 0 failed** |

## AF-01…AF-31 matrix (code vs evidence vs qualification)

Legend: **FIXED/PARTIAL/OPEN** for code-level status in this pass; VM/live qualification is separate.

| AF | Code status | Regression evidence status | VM/live qualification |
|---|---|---|---|
| AF-01 | PARTIAL | A01 PASS; A02 NOT RUN | NOT RUN |
| AF-02 | PARTIAL | A05 PASS, A06 PASS | NOT RUN |
| AF-03 | PARTIAL | Partial admission regressions only | NOT RUN |
| AF-04 | PARTIAL | A03 PASS, A04 PASS | NOT RUN |
| AF-05 | PARTIAL | A09 PASS; A08/A10 NOT RUN | NOT RUN |
| AF-06 | PARTIAL | A13 PASS; A11/A12 NOT RUN | NOT RUN |
| AF-07 | OPEN | No Q1B privileged executor proof | NOT RUN |
| AF-08 | OPEN | No Q2 privileged write confinement proof | NOT RUN |
| AF-09 | OPEN | No full qualified S03 rollback/cutover proof | NOT RUN |
| AF-10 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-11 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-12 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-13 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-14 | PARTIAL | Cancel checkpoints + lock coverage improved; process-tree supervision still missing | NOT RUN |
| AF-15 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-16 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-17 | OPEN | Live unknown-result handling not fully qualified | NOT RUN |
| AF-18 | OPEN | Restore explicitly blocked (containment only) | NOT RUN |
| AF-19 | OPEN | Restore payload integrity/confinement still pending | NOT RUN |
| AF-20 | OPEN | Snapshot/transaction completeness pending | NOT RUN |
| AF-21 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-22 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-23 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-24 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-25 | OPEN | Update flows explicitly blocked (containment only) | NOT RUN |
| AF-26 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-27 | PARTIAL | Existing strict CLI/config tests; A15 parse-envelope regression PASS | NOT RUN |
| AF-28 | PARTIAL | Added Q1A regressions; full package/VM acceptance matrix pending | NOT RUN |
| AF-29 | OPEN | Not addressed in Q1A scope | NOT RUN |
| AF-30 | PARTIAL | No full secret-safe logging redesign; output-limit issue not fully closed | NOT RUN |
| AF-31 | OPEN | No Q2 host-level isolation qualification | NOT RUN |

## Explicitly blocked/contained public paths after Q1A

- `restore` command: blocked before payload read/copy.
- `update plan` / `update apply`: blocked (no generic `S14` bypass advice).
- `inference probe`: blocked until reviewed implementation.
- Generic `apply` refuses `S08` and `S14` stages.

## NOT RUN / known blockers

- Disposable VM validation, real sudo/apt/systemd/SSH/firewall, real Docker daemon hardening checks.
- OAuth login against real provider and live model calls.
- Full A02/A07/A08/A10/A11/A12 acceptance scenarios.
- Q1B/Q2 items: process-tree cancellation, narrow privileged executor, complete host admission and privileged adapter qualification.
