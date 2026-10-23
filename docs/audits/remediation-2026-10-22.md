# Remediation matrix — 2026-10-22 audit (AF-01..AF-31)

> **Historical note:** This AF matrix is preserved as the 2026-10-22 snapshot. Newer Q1A/R1/R1.1 evidence is documented in `docs/audits/remediation-q1a-2026-10-23.md`, `docs/audits/remediation-q1a-r1-2026-10-23.md`, and `docs/audits/remediation-q1a-r1-1-2026-10-23.md`.

**Current HEAD:** `7d845248e7fcd089a36afc8b395b38c7226e09e7`  
**Audit base commit:** `7d845248e7fcd089a36afc8b395b38c7226e09e7`  
**Scope of this remediation pass:** core Q1-focused code fixes + regression tests; no real privileged/live/VM execution.

## Commands executed

- `npm --prefix setup run typecheck --silent`
- `npm --prefix setup run test --silent`

Result: **84 passed, 0 failed** (setup suite).  
VM/real sudo/apt/systemd/SSH/firewall/Docker daemon/OAuth/model calls: **NOT RUN**.

## AF matrix

| AF-ID | Applicability | Status | Changed paths | Failing-before / passing-after evidence |
|---|---|---|---|---|
| AF-01 | Applicable | **PASS (code-level)** | `setup/src/core/types.ts`, `setup/src/core/engine.ts`, `setup/src/core/plan.ts`, `setup/src/stages/*.ts` | Added explicit `StageContext.config`; removed `lastConfig` process-coupling. Added regression: `plan and apply work across separate engine processes` (core-engine integration). |
| AF-02 | Applicable | **PASS (code-level)** | `setup/src/core/gates.ts`, `setup/src/core/engine.ts`, `setup/tests/unit/core.test.ts` | `upsertPlanGates` preserves valid approvals and TTL; single clock for gate checks in engine. Added unit regressions for preserved approval + expiry rejection. |
| AF-03 | Applicable | **PARTIAL** | `setup/src/core/engine.ts` | No full contract-hash closure yet; apply now enforces post-verify observed `verified` status and fresh lock-scoped state reload. |
| AF-04 | Applicable | **PARTIAL** | `setup/src/stages/preflight.ts`, `setup/src/core/engine.ts` | Preflight now checks exact Ubuntu 24.04 ID/VERSION_ID, arch, root/systemd/user/node/inodes resources and blocks unsupported hosts; verify writes observed status (not forced verified). |
| AF-05 | Applicable | **PARTIAL** | `setup/src/core/state.ts` | State save switched to no-delete primary strategy + `.previous` recovery path when primary missing/corrupt. |
| AF-06 | Applicable | **PARTIAL** | `setup/src/core/lock.ts`, `setup/src/core/engine.ts`, `setup/tests/integration/core-engine.test.ts` | Cancel request bound to lock identity; release refuses foreign lock owner; plan/gate-approve now lock-protected. |
| AF-07 | Applicable | **OPEN** | — | Sudo/admission model remains incomplete in this pass. |
| AF-08 | Applicable | **OPEN** | — | Privileged write hardening not fully implemented in this pass. |
| AF-09 | Applicable | **OPEN** | — | S03 production-grade SSH/firewall adapter semantics not implemented in this pass. |
| AF-10 | Applicable | **OPEN** | — | Signed apt repo prerequisite/pin qualification not completed. |
| AF-11 | Applicable | **OPEN** | — | Offline package reproducibility/provenance gaps remain. |
| AF-12 | Applicable | **OPEN** | — | Bootstrap path/quoting/locking hardening not fully addressed in this pass. |
| AF-13 | Applicable | **OPEN** | — | Full installer↔M0 manifest contract reconciliation remains. |
| AF-14 | Applicable | **PARTIAL** | `setup/src/adapters/process.ts` | Added trusted env control (`PATH` guarded), `LC_ALL=C`, structured `outputLimitExceeded` signal. Full process-group cancellation matrix remains open. |
| AF-15 | Applicable | **OPEN** | — | S06 image/runtime command conformance still incomplete. |
| AF-16 | Applicable | **OPEN** | — | Auth/login runtime flow redesign not completed in this pass. |
| AF-17 | Applicable | **OPEN** | — | Live smoke reservation/reconciliation logic still incomplete. |
| AF-18 | Applicable | **OPEN** | — | Dedicated restore gating path remains incomplete. |
| AF-19 | Applicable | **OPEN** | — | Restore payload/link integrity hardening remains incomplete. |
| AF-20 | Applicable | **PARTIAL** | `setup/src/operations/backup.ts`, `setup/schemas/config.schema.json`, `setup/src/core/config.ts` | Added typed `operations.backup_path` + `retention_days` config support and wired retention usage. Full WAL/restore consistency remains open. |
| AF-21 | Applicable | **OPEN** | — | Runtime bounded `/out` enforcement still open. |
| AF-22 | Applicable | **OPEN** | — | Full project/control/auth/work boundary hardening still open. |
| AF-23 | Applicable | **OPEN** | — | Ownership namespace convergence remains open. |
| AF-24 | Applicable | **OPEN** | — | Service admission/rollback strictness gaps remain. |
| AF-25 | Applicable | **OPEN** | — | Update plan/apply dedicated robust flow still blocked (verbs parse + blocked envelope only). |
| AF-26 | Applicable | **OPEN** | — | Inference health evidence is not fully remediated in this pass. |
| AF-27 | Applicable | **PARTIAL** | `setup/src/cli.ts`, `setup/src/core/config.ts`, `setup/schemas/config.schema.json`, `setup/src/core/validators.ts`, `setup/src/core/engine.ts` | Strict CLI parser: unknown/duplicate/missing args => exit 2 envelope; added documented verb parsing (`update`, `inference probe`), version from package metadata, supervised defaults S01..S07, optional `operations` config section with validation. |
| AF-28 | Applicable | **PARTIAL** | `setup/tests/integration/core-engine.test.ts`, `setup/tests/unit/core.test.ts` | Added regression tests for separate-process plan/apply and gate lifecycle/expiry semantics. Full VM qualification matrix remains NOT RUN. |
| AF-29 | Applicable | **OPEN** | — | GitHub baseline/evidence trust-chain work not completed in this pass. |
| AF-30 | Applicable | **PARTIAL** | `setup/src/adapters/process.ts` | Output sanitization signal improved; full secret-safe logging/retention redesign remains open. |
| AF-31 | Applicable | **OPEN** | — | S04 exact cgroup/resource enforcement verification remains open. |

## Remaining blockers

1. Privileged adapters, S03 real rollback, and S04 enforcement proof (AF-08/09/31) require dedicated implementation + VM qualification.
2. Package/release/M0 contract and runtime conformance (AF-11/13/15/23) remain open.
3. Auth/live/restore/security-hardening and service/update/inference/platform advanced flows (AF-16..26,29,30) remain open.

## NOT RUN evidence

- Disposable VM suite: **NOT RUN**
- Real sudo/apt/systemd/firewall/SSH cutover: **NOT RUN**
- Real Docker daemon enforcement on host: **NOT RUN**
- Real OAuth and live model smoke: **NOT RUN**
