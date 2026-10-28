# R2.2: C13 plan and checked review context

CONTRACT 1.0.0 C05–C13 remains normative. The execution file is a flat C13 `InstallerPlan`; the internal `ExecutionPlan`/StagePlan view is derived by strict decoding, never persisted as an alternative execution format. Legacy `stages/created_at` files are historical evidence only and require explicit new producer review before effects.

## Serialization and identity

The strict public schema defines `schema_version:1`, installation/contract identity, physical `host_fingerprint`, `owner_session`, `generated_at`, `expires_at`, desired/version-lock/observations/plan hashes, `target`, `stage_scope`, `release_context` and flat `operations`. Additional C13-compatible fields are explicit, with unknown properties rejected. `stage_scope` preserves ordered dependency closure, optionality, capabilities and stage-wide gates even for empty/no-op dependencies; target records config-selected versus explicit stage provenance. Core review binds this provenance independently of submitted JSON.

Operations carry a closed concrete adapter action, operation/stage identity, exactly one resource, expected-before hashes (reviewed constraints/source observation/version lock), action-specific expected-after checks, required gates, retry/timeout, risk, execution classification, constraints, estimated effects and enumerated unknown-effect disclosures. Concrete actions are literal declarations in trusted producers; submitted command strings/resource names do not select an adapter. `fixture.counter` exists only for explicitly injected test producers, not the production registry. Unknown-effect disclosures are review limitations, never permission to replay unknown outcomes.

Canonical JSON recursively sorts object keys, preserves array order, and hashes UTF-8 bytes without only `plan_hash`. Parsing rejects duplicate decoded keys (including escaped aliases), depth over 128, invalid UTF-8/NUL and files over 1 MiB. Dates must be real canonical UTC ISO milliseconds, exactly 30 minutes apart. Future generation is refused; `now >= expires_at` is expired. A single injected clock drives plan and gate expiry. Finishing a bounded action after expiry may publish its verified progress; the next intent is forbidden. Resume/approve/recover do not renew timestamps.

## Trusted facts and admission

| Fact | Producer / persistent proof | Check and next action |
|---|---|---|
| Physical host | Checked machine ID + actual Ubuntu 24.04/architecture + existing installation state; plan/core review | Foreign/missing identity refuses before intent. Boot is not foreign-host identity. Reconcile host, never silently rebind copied state. |
| Owner session | Actual ordinary UID/configured username; Linux audit `sessionid` and `loginuid`, boot UUID; hash in exact plan/review | New PID in same login works. New boot/login requires revalidation, explicit new review and approvals. Unset/unreadable audit identity fails closed; perform a supported owner login. No env token, PID UUID or perpetual config session. |
| Version lock | Safe bounded schema-validated file; SHA-256 of exact UTF-8 bytes (including whitespace) | Same-path replacement, invalid/missing/truncated/symlink/substitution refuses; review valid new content explicitly. State lock/path hashes are not substitutes. |
| Release | Config release declaration plus actual safe artifact hash (bounded streaming 1 GiB/120s); stage policy adds manifest/commands/deployed-content and S06 pins | Applicable release closures require bytes matching declared SHA. Host-only S00–S04 do not require absent/live M0. Manifest/entry changes refuse; a path string is not artifact proof. |
| Observations | Ordered security projection of producer policy inputs; timestamps/irrelevant counters excluded | Initial reviewed source is checked, then committed operation frontier/current invariants after own verified effects. External significant drift refuses. Never rewrite submitted plan to match observations. |
| Target/closure | Trusted registry closure and original selected/explicit target, core review | Exact order, no-op prerequisites and stage requirements checked; submitted subset/superset/target cannot authorize itself. |
| Actions/gates | Canonical fresh producer policy compared with entire submitted semantics and published progress | Gate stripping, changed action/resource/risk/constraints/retry/timeouts/order refuse. Gate identity binds plan hash + exact operation/resource; that hash transitively binds all context. Stage-only gates remain mandatory. No auto approvals. |

Filesystem context inventory checks all ancestors (max64), ownership, writable modes, symlinks and regular types. Lock reads are bounded 1 MiB with before/after identity checks. Artifact streaming uses no-follow open and before/after file identity/size/mtime. File ownership is checked against the actual OS UID (501 in this local environment), separately from injected owner UID1000 in tests. Production does not inject identities. Root-sticky temporary ancestors are allowed for owned test copies; arbitrary group/world writable paths are not.

Gate approval, apply and resume use the same checked context, independent producer policy and committed review. Requests are frozen before lock; bytes and identity are rechecked after lock and before each action, including after read-only stage probes/hashing. Invalid approval is refused immediately. Recorded status/gate list do not probe/repair/migrate evidence. OS-level check/use races and privileged safe writes remain Q2; these checks do not claim complete OS TOCTOU elimination.

## Publication, progress and migration

Existing core state publication remains the only metadata writer. S00 reserved `setup_plan_review_v1` has exact fields `{version:1,phase,plan_hash,context_hash}`; phases are prepared/committed, bounded4096 bytes. Stage observation cannot overwrite it. Per-stage `setup_policy_basis_v1` supports strict versions1/2/3; v3 adds exact producer `catalog` and last non-executable policy `frontier` to original source, expected fingerprint, completion IDs and immutable operation/attempt/receipt publication records. Max64 KiB. Unsupported metadata is a blocker, never fresh state.

| Boundary | Durable evidence / restart behavior |
|---|---|
| Before proposal publication | Generate/validate in memory; no replacement of historical plan on failure. |
| Prepared state published | Full semantic catalog and carried publications are durable, review phase prepared; no gate/effect authorization. |
| New public plan published atomically | Temp write/fsync/rename/directory-fsync; prepared state still cannot authorize. |
| Committed review published | Existing state/journal/manifest generation protocol binds exact plan/context; only this phase authorizes approvals. |
| Intent/effect/receipt/verify/checkpoint/binding | Existing R1.4/R2.1.1 protocol unchanged: unknown effects block replay; each completed effect verified and published before next. |
| Interrupted metadata/final review publication | Preserve confirmed progress. Prepared/unsupported review requires explicit fresh review; do not promote metadata from old snapshots automatically. |

Generic v3 completion requires exact semantic catalog, journal checkpoint attempt/receipt binding and retained manifest publication (or a proven later same-resource successor). S03 additionally requires exact ordered prefix, semantic operation equivalence and current frontier postconditions, distinguishing arm/disarm despite shared resource. Carried records retain original operation/attempt/receipt identities. IDs/resources alone are insufficient. Legacy v1 reads the exact bound old plan, v2 uses immutable publications; action mapping is allowed only after all prior operation semantics match the current trusted action. Legacy execution approvals never become C13 approvals by hash conversion. Explicit fresh review is required; unknown/ambiguous legacy data remains preserved and blocked.

R211-O01 is still R3: a restored snapshot without committed review may refuse automatic resume. The original desired oracle remains known-red; explicit fresh producer review/approval is the supported workaround, with no replay. No recovery-proof relaxation is introduced here.

## Refusal classes and limits

Malformed/schema/semantic/tampered plan: exit2. Unsupported ordinary owner/identity: exit3. Missing/expired gate or ended session/expired plan: exit4. Context/policy drift, foreign state, unproven publication or legacy review: exit8. Unsafe metadata/release integrity: exit9. Runtime adapter errors retain their existing typed contract; pre-admission refusal publishes no target intent or false verified state and preserves confirmed receipts/checkpoints.

Local fake-adapter tests are not privileged qualification. Real S03 cutover remains a Q2 code blocker; VM/live/privileged/provider qualification is NOT RUN. R3/Q1B/Q2–Q6/application/production remain OPEN. No commits, push, branches, worktree, staging/index packaging, PR, merge, tag, release or deploy are authorized here or in generated follow-up prompts.

## R2.2.1 final admission fence (2026-10-26)

R2.2's earlier order left a detected gap: a request or already-read lock could change during the last archive hash. `finalPlanAdmission` now shares the effect/approval path: exact producer/owner admission → policy probes → one checked context capture (including archive hash) → current policy frontier probes again → bounded lock-byte/host-session revalidation → frozen request-byte check → final metadata fence for all captured files → synchronous TTL/gates → intent or approval. The second frontier observation checks changes during archive hashing; changes to context/request during those probes are caught by the reseal. No unbounded stability loop or repeated1GiB archive hash is used by this fence.

Per-admission witnesses are ordinary typed, nonpersistent values, not authorization metadata/cache. They bind canonical path plus dev/inode/size/mtime/ctime/mode/UID/GID/nlink/type. Final path/ancestor safety checks and parallel lstat snapshots follow all potentially long content/identity reads. Actual lock JSON is reread/validated (1MiB bound) and compared with its original bytes hash. Archive hash is reused only within this admission, conditional on unchanged file/path metadata. Owner/physical/session facts are reread after expensive work. Config/plan exact bytes are checked last and their identities participate in the same final fence. The existing streaming bounds, strict schema and ordinary-owner rules remain.

Plan publication uses this same reseal after producer/context reads and again after prepared+plan publication, before committing review; the published plan is checked against the exact serialization written by the producer. A failed seal cannot promote prepared review. Pre-intent refusal does not publish a new applying state or target event. An already completed operation keeps its receipt/checkpoint and is not replayed after fresh review.

Gate approve saves only after successful final admission. There is no approval save in finally. The sole explicit refusal-side metadata write retains historical behavior: a plan already expired when the command began, whose context/request/policy otherwise pass the full fence, may persist only `expired` gate statuses with unchanged identities/expiry and progress. Expiry reached during probes or any context failure publishes nothing. This invalidation never approves or renews a gate.

This is a finite final admission boundary, not a transactional OS filesystem snapshot. A malicious concurrent writer can still race individual final metadata syscalls or mutate files after the last fence; privileged safe filesystem operations and full OS/process isolation remain Q2/Q1B. No real privileged/SSH/Docker/VM/live qualification is claimed. No commits/push/branches/worktree/staging/PR/merge/tag/release/deploy are authorized by this note or generated prompts.

### Q1A-R3 finite cancel/review refinement (2026-10-27)

Effect admission now observes durable generation-bound cancellation after bounded context/request reseal and before the existing final metadata fence and synchronous TTL/gates. All long cancellation reads precede that fence. Gate approval and prepared/committed semantics are unchanged. A restored prepared/unproven review reports exit8 plus machine-readable fresh-review requirement; it is never promoted. The original R211 auto-resume oracle remains historical known-red; see [lock-cancel-r3.md](lock-cancel-r3.md) for the separate honest-outcome contract and limits.

R3.1 clarification (2026-10-28): cancel decode/schema checks are synchronous after the existing bounded control read and before generation comparison. Unknown/semantic-invalid formats refuse with8; valid stale and exact recognised legacy remain no-ops. No new await was added after the final metadata fence/TTL/gates. Process identity is explicit in every current-source cancellation caller; actual FS UID and injected application UID remain separate.
