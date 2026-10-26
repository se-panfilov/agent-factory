# R2.1.1: admitted S03 progress and explicit review

Local protocol clarification, 2026-10-26. Public contract 1.0.0, CLI/config/state/plan shapes and recovery protocol are unchanged. Real SSH/firewall/timer execution remains a Q2 code blocker; fake adapter results are not host qualification.

## Identity and predecessor

The public producer keeps observation-derived operation IDs for compatibility. Core reconciles the **full semantic operation**, not a resource name or hash suffix. The stage can normalize only observation-derived ID/hash constraints and, after a proven cutover receipt, the two public-exposure constraints. Core compares parent, kind, resource, risk, gates, all other preconditions, effects, timeout and retry exactly. Arm and disarm remain distinct semantic operations even though they share a resource.

`restoreOperationProgress` runs only after ordinary state/journal/manifest admission under the lock. Both explicit planning and all-stage apply admission invoke it, as does execution context construction. It reconstructs an exact ordered prefix from the trusted producer catalog and selects its exact frontier. It never selects an arbitrary last receipt or all receipts for a resource.

A frontier needs a retained config-bound manifest receipt with matching stage, resource, original operation ID, attempt, receipt hash, checkpoint sequence and state hash. Every prefix publication needs the corresponding ordered journal checkpoint binding. Then S03 reobserves and checks the frontier's full postcondition hash, manual readiness, rollback templates, ownership, reviewed diff and pin invariants. No effect/intent is admitted on failure. The fingerprint expected after the previous operation is checked independently by existing policy admission.

Historical intermediate observations need not equal current bytes after subsequent legitimate effects. Their exact published semantic operations and ordered checkpoint bindings prove history; the frontier receipt proves current facts. This permits the manifest's existing per-stage/resource compaction: an arm receipt may be superseded by disarm, but its distinct checkpoint publication must remain provable. A disarm receipt cannot stand in for an arm publication.

## Internal metadata v2

The existing reserved `versions.setup_policy_basis_v1` key accepts versions 1 and 2 (key retained for compatibility). Version 2 adds `progress`, aligned one-to-one with `completed`:

- `currentId`: alias in the current reviewed catalog;
- `operation`: complete immutable originally published operation;
- `attemptId`: original attempt UUID;
- `receiptHash`: original durable receipt SHA-256.

No state hash is embedded recursively. Strict parsing checks exact field sets, operation enums/types/stage, ordered aliases, unique IDs/attempts and hashes, with the existing 64 KiB bound. The original source observation preserves JSON key order, since legacy producer IDs use it. This is core-owned metadata, not submitted authorization or a second persistence store.

Before publication, a new operation's postconditions are actually verified. Its new metadata record and expected current-policy fingerprint enter the same state snapshot used by the existing operation checkpoint and manifest binding. The publication is usable only after ordinary evidence admission and matching journal/manifest proof; metadata alone is insufficient.

| Boundary | Meaning after interruption |
|---|---|
| Before effect admission | TTL, request bytes, trusted policy, gates and current S03 admission still apply; no progress invented |
| In-flight / intent / effect before verified publication | Unknown outcome blocks, no replay |
| Postcondition verify / state snapshot before checkpoint | Existing partial-publication rules apply; no standalone metadata authorization |
| Checkpoint append before manifest binding | Journal uncertainty/generation rules block unsafe continuation |
| Manifest binding durable | Exact completed prefix can be restored in a new process |
| Cancel after a completed checkpoint | Exit 130, null in-flight; next command restores predecessor before admission |
| Final verification / clean proof | Existing stage-wide verify and final publication protocol; operation progress is not stage success |
| Metadata-only plan/gate changes | Retain original publication identity and prefix; ordinary clean proof rules remain authoritative |

SIGKILL tests cover effect-before-verify, checkpoint-before-binding and binding-durable boundaries with genuine S03 engine writers. Existing initial/operation/final publication fault matrices remain part of the suite. Physical power-loss durability is NOT RUN.

## Resume and explicit re-plan

Ordinary resume uses the same still-valid plan and gates; no implicit re-plan, TTL renewal or process-local stage memory. Before every remaining operation, its admission compares current raw observation with the confirmed predecessor, not the original pre-install snapshot.

Explicit re-plan first restores/validates existing progress, then compares the old/new trusted catalogs. Completion carries only across full semantic equivalence and current frontier invariants. It retains the original publication operation/attempt/hash and records the new reviewed alias separately. The public plan can still present the complete catalog; the core-validated internal completion prefix unambiguously identifies the remaining executable suffix. A fully completed installation produces a public no-op while retaining the complete internal historical catalog. A resource-level `verified` observation cannot erase unfinished orchestration.

Every new plan has its own identity and requires its own approvals; remaining security requirements never inherit old approvals. Changed completed semantics are a blocker requiring explicit reconciliation, not replay. External content/ownership/pin/manual/diff drift is refused before plan publication or target intent. A new review does not normalize an unresolved security violation.

## Expected own cutover changes

The injected access adapter may provide a bounded staged target content proof after staging/validation: inventory, SSH and firewall hashes. The stage receipt carries that proof through arm/cutover/tailnet/disarm; the core supplies only the admitted predecessor. Cutover may produce those exact hashes while preserving ownership, manual readiness, pins/login, templates and reviewed diff. Without this proof, cutover must preserve current content hashes. Other operations cannot change reviewed access inputs. Unexpected cutover changes trigger rollback and retain uncertainty, never a successful next checkpoint.

This optional adapter method does not implement a real privileged executor. The real NodeAccessAdapter still has its existing cutover/timer blocker. No assertion of OS-level atomic cutover or full TOCTOU protection is made.

## Legacy policy

Version-1 R2.1 basis first requires the exact schema-valid old plan, with its self-hash matching the admitted basis plan hash and its whole stage policy matching the trusted producer from the original source. This bounded read is historical proof, not TTL renewal or new authorization. Missing/replaced plan or changed producer semantics block. It can be upgraded in memory only when its completed IDs are an exact prefix, each publication is unambiguous in the admitted journal and the frontier is retained/matching/current. Missing historical intermediate receipts are acceptable only with the exact ordered journal binding (including arm/disarm distinction). The next normal core publication persists v2; no repair writes are performed merely to admit it. Missing/ambiguous/foreign/unsupported proof blocks without deletion.

R1.6/basisless known S03 progress is explicitly unsupported for automatic transfer: no reviewed source policy means no safe semantic enrollment. Likewise a retained publication with an empty claimed prefix blocks. Preserve evidence for a separately reviewed migration/reconciliation; never call it fresh or reset it. Existing version-1 handling of other stages is unchanged.

R2.2 full C13 serialization/context binding, R3/Q1B/Q2–Q6 and production remain OPEN. No commits/push/branches/worktree/PR/release/deploy are authorized by this document or any generated follow-up prompt.

## R2.2 context and legacy transition (2026-10-26)

See [plan-context-r22.md](plan-context-r22.md): new-format same-session continuation preserves the admitted prefix; boot/login changes require explicit review and fresh approvals. Strict v1/v2 historical publications migrate only after exact semantic/current-frontier checks; v3 also retains the complete core catalog. R211-O01 automatic final recovery remains R3, with explicit reviewed continuation as the supported no-replay workaround.
