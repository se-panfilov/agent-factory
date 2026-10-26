# R2.1 trusted plan policy and runtime admission

This is local code behavior, not host qualification. Contract 1.0.0 and public CLI/config/state/plan shapes remain unchanged. In particular, this format still has `created_at`; the full C13 serialization and context binding are **R2.2 OPEN**.

## Trusted policy and submitted data

A plan is a proposal, not its own security policy. The trusted producer regenerates the complete stage policy (including ordered operations, parent/id/kind/resource/risk/preconditions/effects/timeout/retry, stage-only and operation gates, optional and capabilities). Core compares the submitted stage exactly. Registry DAG/profile/capability/entrypoint guards still run. A stage target and its prerequisite closure remain legal; comparison does not force every request to use all config-selected stages.

An explicit `plan` captures the producer observation and stores an internal `PolicyBasis` in the existing stage `versions.setup_policy_basis_v1` string. It contains an internal version, original source observation, plan/config hashes, an expected significant-input fingerprint and completed operation IDs. The record is not supplied by the submitted JSON. Its parser checks exact field sets, types, finite primitive values, hashes, stage identity and unique completion IDs; its UTF-8 serialization is capped at 64 KiB per stage. This is a versioned internal value in an existing extensible map, not a new public schema version or an authorization sidecar.

Why retain a basis: S03/S04 operation IDs and some preconditions contain observation hashes. Own package/timer/group/config changes alter those observations. A fresh producer plan alone loses the original reviewed sequence, while process-local memory cannot support restart. The existing committed state generation provides a durable, validated place for the original producer input and progress. Canonical policy is recomputed from that source rather than trusting any client hash or duplicated gate-name list. The original JSON key order inside the observation is retained because existing S03/S04 producer hashes use it.

`apply` checks exact submitted policy and current inputs under the lock, before target intent. Missing basis for a fresh legacy/current-format plan gets a strict fresh producer comparison, never weaker gate checks. If committed partial progress already exists, ordinary apply first requires an explicit producer review; matching config-bound operations are reverified during enrollment instead of replayed. Changed/malformed/unsupported basis is a blocker; it is not deleted/migrated into authorization. Explicit plan generation checks existing metadata before overwriting a plan. New enrollment does not silently adopt legacy unknown effects.

## Own progress and current policy

The significant-input fingerprint uses producer policy and status, not observed_at. Producer-ignored volatile counters do not affect that view. S04 supplies its security/resource checks and versions, excluding only the core-derived completed-resource list. S05 supplies a separate non-executable policy observation: archive/checkout/content checks run, but application probes do not run before a durable materialization receipt. Normal S05 observe/verify/probe behavior remains mandatory and unchanged.

After verified operation postconditions, core captures the expected policy input state and completion ID in the same state snapshot used by the existing operation checkpoint. A subsequent operation must match that expectation and current producer policy. A resource-level `verified` observation cannot erase still-unperformed reviewed orchestration: the producer catalog remains open until the reviewed sequence finishes. This preserves mandatory S03 rollback/verify/disarm and S05 probes.

Current producer requirements are compared to the remaining reviewed sequence. Newly required gates, changed resources/risks/constraints or missing/reordered steps refuse before the next intent. They are not silently executed under old approvals. A separate completion check also rejects newly required stage-only gates or actions after the last effect, before publishing final verified. Stage-wide verification never substitutes for that policy check. S03/S04 reconciliation returns **only** normalized ID/precondition fields; core continues to compare all other operation fields and gates. Reconciliation requires core-proven completed operations and their receipts:

- S03: observation-derived ID/hash; public IPv4/IPv6 post-cutover flags only after a bound cutover receipt. Pins, manual readiness and gate definitions remain strict.
- S04: observation-derived ID/hash; installed/managed markers only with their own proof, and daemon config hash only with its confirmed config receipt. Package-set hash, fixture and gates remain strict. Read-only stage admission checks current ownership, account/process membership, package/config progress and API safety.

For S02, a separate read-only admission checks current candidates/privilege/dpkg readiness before intent. A refresh may reveal new candidates, but cannot authorize installation of those candidates under the old review.

## Persistence and crash boundaries

| Boundary | Meaning / restart behavior |
|---|---|
| Explicit producer planning | Original observation/policy basis and gates enter the existing atomic state commit; plan file is still untrusted submitted data |
| Admission | Config/plan bytes rechecked after lock and before each operation; policy, time and approvals checked before intent |
| In-flight + intent | Existing protocol, no completed policy ID yet; unknown outcome never replayed |
| Effect evidence + postcondition verify | Receipt remains core-owned. Read-only post-policy observation prepares a next-state expectation; failures remain unresolved, never false verified |
| State snapshot, checkpoint append and manifest binding | Completion/expectation is included in the checkpoint state hash. Partial publication is handled by existing generation/journal/evidence admission; policy metadata cannot bypass it |
| Next operation | Uses only admitted policy and known committed progress; changed required actions cause refusal without making previous progress unknown |
| Final stage verify/publication | Current completion policy and verified input consistency checked; expected policy snapshot updated in final clean proof; no schema/generation/recovery algorithm change |
| Metadata-only diagnostics | Stage updates retain the core-owned reserved basis. Plain status does not write or probe |

No new persistence artifact is introduced. The small state helper change preserves the core-owned key when stage observations replace their ordinary versions. Ordinary load still validates manifest/journal/generation before policy admission. Marker/quarantine/foreign/unknown evidence refusal is unchanged. Existing crash/fault suite covers the snapshot/checkpoint/binding paths with this metadata present.

On explicit re-plan, completed operations carry only when their full canonical operation is unchanged, a matching config-bound receipt exists, and current operation postconditions (or whole-resource verified checks) are confirmed. A resource whose old postcondition no longer holds is not carried as complete: an explicit new review may authorize its reconciliation; unknown journal outcomes still block. Legacy enrollment without a postcondition verifier refuses rather than assuming completion. Old approvals are not transferred to a different plan hash. Resume does **not** re-plan or renew time; it reuses the existing reviewed plan. After a Docker login, generate/review the remaining plan and approve its gates before resume. Missing plan requires an explicit plan/review; damaged/unknown evidence remains a blocker first.

## Time, inputs and refusals

The injected clock is the sole clock for plan/gate expiry. `created_at` must round-trip exactly as the planner's `YYYY-MM-DDTHH:mm:ss.sssZ`, with a real finite date. Future creation refuses with no skew allowance. `now >= created_at + 30 minutes` is expired, including gate-free plans. Time and approvals are checked under lock and again at each operation admission. An already admitted bounded APT action is not killed for TTL; the next action is refused. Gate expiry remains independent and is never extended in place.

Bounded request snapshots (1 MiB each, unambiguous UTF-8 JSON without NUL/replacement characters) are compared after lock and before each action. Changed bytes refuse; core does not switch to a replacement plan or config. This closes the specified controlled lock-wait cases, not every possible filesystem/owner-session race; remaining concurrency/context binding is R2.2.

| Refusal | Existing exit code |
|---|---|
| Malformed JSON/schema/time, self-hash/producer policy mismatch, unreviewed policy identity | 2 |
| Significant input/current-policy drift, future time, unreadable/changed request, invalid internal basis/progress | 8 |
| Plan expired, missing/expired approval, existing stage manual prerequisites | 4 |
| Stage security/integrity violation | 9 |
| Unsupported capability/profile/entrypoint or unapprovable external prerequisite | Existing 5 guards |

Policy/TTL refusal before a new effect does not clear receipts, append a target intent, repair history or mark known progress unknown. Its error is returned without rewriting state evidence. Existing gate-approve expiry publication can mark gates expired without changing their expiry dates or receipts. Effects whose outcome is unknown retain the existing in-flight/recovery blocker. Optional failure status uses the trusted module's optional policy, not a forged client flag.

This package does not claim cryptographic plan authentication or protection against an owner who changes the trusted installer. Full generated_at/expires_at serialization, host/session/version-lock/release/public observations binding, other concurrency cases, Q1B/Q2–Q6 and production qualification remain OPEN/NOT RUN.

## R2.1.1 correction (2026-10-26)

The original R2.1 continuation claim was too broad for S03: same-plan restart lost the predecessor, and explicit re-plan could replay completed observation-derived IDs. See [access-continuation-r211.md](access-continuation-r211.md) for the v2 publication/alias proof and strict full-operation reconciliation. This correction does not retroactively claim that the original A21-08 validation covered these cases.

## R2.2 serialization supersession (2026-10-26)

Execution now uses the strict flat C13 format and independently committed context described in [plan-context-r22.md](plan-context-r22.md). The old stages/created_at representation in this historical design note is an internal decoded view or legacy historical proof only, never an executable wire fallback. Producer policy/TTL/no implicit replan protections remain.
