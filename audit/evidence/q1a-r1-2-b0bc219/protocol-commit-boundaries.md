# Commit protocol boundaries (R1.2)

| Boundary | Durable artifact(s) | Identity/generation proof | Commit point | Crash before boundary | Crash after boundary |
|---|---|---|---|---|---|
| B0 state persistence | `state.json`, `state.json.previous`, `state-commit.json` | `state-commit.last_state_hash == hash(state.json)`, `generation++` | `state-commit.json` fsync/rename | Reader/recover returns exit 8 (`state_recovery_required`/`state_generation_mismatch`) if torn/mismatch evidence | Reader accepts generation only when hash and installation match |
| B1 operation intent | `events.jsonl` record `code=intent` | `installation_id + attempt_id + operation_id + stage + sequence + checksum` | Journal append+fsync+dir-fsync | No effect is assumed; unresolved operation remains blocked | Journal marks operation unresolved until full chain closes |
| B2 effect evidence | `events.jsonl` record `code=effect` | Same attempt identity; strict transition from intent | Journal append+fsync+dir-fsync | Unknown external effect is preserved as unresolved evidence | Recover blocks ordinary effects until reconciliation |
| B3 verification | `events.jsonl` record `code=verify` | Same attempt identity; strict transition from effect | Journal append+fsync+dir-fsync | Operation remains unresolved | Recover blocks ordinary effects until checkpoint proof |
| B4 checkpoint | `events.jsonl` record `code=checkpoint` with `state_hash` | Same attempt identity; strict transition from verify | Journal append+fsync+dir-fsync | Operation remains unresolved (`journal_recovery_required`) | Latest checkpoint candidate is available for manifest binding |
| B5 checkpoint proof binding | `state-commit.json.last_effect_checkpoint` | Exact match to latest journal checkpoint (`attempt_id`, `operation_id`, `stage`, `sequence`, `state_hash`) | Manifest fsync/rename | Reader/recover rejects (`state_checkpoint_proof_mismatch` / `state_checkpoint_evidence_missing`) | Reader accepts only if journal + manifest proof aligns |
| B6 recovery decision prepare | `recovery-required.json.recovery_commit.phase=prepared` | Immutable `candidate_state_hash` + source (`previous`) | Marker fsync/rename | No restore attempted; decision evidence remains | Resume must use the same candidate hash, else `recovery_unresolved` |
| B7 primary restore | `state.json` rewrite via `restorePrimaryState`, then manifest update | Restored hash must match prepared candidate and trusted installation identity | State+manifest fsync/rename | `recovery_primary_persist_failed` (exit 8), marker and previous evidence remain | Marker advances to `primary_restored` and cleanup may continue |
| B8 marker cleanup | remove `recovery-required.json` | Marker phase already `primary_restored`, primary hash matches decision | Marker remove+dir-fsync | `recovery_marker_clear_failed`/`recovery_commit_pending_cleanup` (exit 8), idempotent retry path | Recover reports `recovered_previous_generation` / `recovery_not_required` when consistent |

## Reader/recover invariants

- Readers never repair or rewrite evidence in diagnostic mode.
- Unknown journal/in-flight/marker evidence is never auto-cleared.
- Recovery cannot start from missing-primary+previous unless candidate hash is proven by commit manifest **and** latest checkpoint identity.
- Prepared decision is immutable across resume; any previous/current substitution returns exit 8 with evidence preserved.
