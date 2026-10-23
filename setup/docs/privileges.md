# Privilege boundary and mutation map (Q1A snapshot)

This file documents **implemented behavior** after Q1A remediation, not target architecture.

## Serialization model

`setup/src/core/lock.ts` provides one installation lock for ordinary writers. In current code, the following commands run under this lock before state mutation:

- `init`, `preflight`, `plan`, `apply`, `resume` (via `plan` + `apply`), `verify`, `status --refresh`
- `gate approve`
- `backup create`, `backup verify`
- `auth login`, `auth status`
- `smoke`, `inference disable`

Read-only paths (`status` without `--refresh`, `gate list`, blocked `restore/update/inference probe`, diagnostic read inside `cancel`/`recover`) do not write state.  
`cancel`/`recover --lock-only` use a separate protocol by design and are not ordinary writer bypasses.

## Operation → privilege/admission matrix

| Operation | CLI argv shape | UID policy | Trusted inputs / paths | Gate / admission | Postcondition evidence | Recovery path | State |
|---|---|---|---|---|---|---|---|
| Initialize installer state | `factory-setup init --profile ... --config PATH` | No root requirement in command itself; writes only setup state/config paths | Config schema + local setup paths | Contract/schema validation | State file exists and envelope returned | Re-run init with same config; lock prevents concurrent writer races | **Implemented** |
| Record preflight observation (S01) | `factory-setup preflight --config PATH` | No explicit owner check; state mutation only | S01 observe output + setup state dir | Stage registration + lock | Persisted `S01` observed status/checks | `verify`/`status --refresh` after fixing host preconditions | **Implemented** |
| Build plan + persist required approvals | `factory-setup plan --config PATH [--stage ID]` | No explicit owner check; no host mutation | Config hash, selected closure, stage plans, state dir | Plan consistency + in-flight barrier + lock; stage-only and operation gates persisted | `plan.json` + persisted required approvals (id, operation_id, ttl, status) | Re-plan after drift/expiry | **Implemented** |
| Approve manual gate | `factory-setup gate approve --config PATH --id ID --plan-hash HASH` | No owner check; state mutation only | Existing persisted gate records | Lock + plan hash + gate id + TTL check (`now >= expires_at` => expired) | Gate status becomes `approved`; expired gates return non-zero and remain expired | New plan + new gate approval | **Implemented** |
| Execute generic stage plan | `factory-setup apply --config PATH --plan PATH` | For mutating stage operations: ordinary owner only (`uid != 0`, username == `expected_user`) | Reviewed plan bytes, state/journal, stage adapters | Admission checks (installation/contract/profile/capabilities/dependency order/gate consistency), lock, **shared in-flight barrier before ordinary effects**, per-op gate binding, cancel checks before/between effects | Attempt-scoped journal transitions (`intent -> effect -> verify -> checkpoint`) + `stage.verify()`/`stage.observe()`; invalid order/legacy records force recovery | `recover`/`resume` with durable in-flight marker | **Implemented (core), not production-qualified** |
| Resume | `factory-setup resume --config PATH [--stage ID]` | Same as `apply` | Recomputed plan from current config + persisted state | Same as `plan` + `apply`; generic apply policy still enforced | Same as `apply` | Same as `apply` | **Implemented (core)** |
| Refresh recorded status | `factory-setup status --config PATH --refresh` | No owner check; state mutation only | Selected stage closure observations | Lock + state load; no silent init in read-only mode | Persisted observed status/drift + age metadata in envelope | `plan`/`apply`/`recover` depending on drift | **Implemented** |
| Read recorded status only | `factory-setup status --config PATH` | Read-only | Persisted state snapshot | No hidden writes | Envelope marks `recorded_state_only=true` | Run `status --refresh` / `verify` for fresh observation | **Implemented** |
| Verify selected installation closure | `factory-setup verify --config PATH [--stage ID]` | No owner check for verify itself | Stage verify+observe over selected closure | Lock + closure resolution (selected stages by default) | Aggregated stage outcomes and C03 exit code mapping | `plan`/`recover`/`resume` depending on typed failure | **Implemented** |
| Backup create (S11) | `factory-setup backup create --config PATH` | Ordinary owner required | Backup config + state/app paths | Lock + S11 operation policy | Backup id/path + retention/prune data in envelope | Backup verify or recover | **Implemented (core)** |
| Backup verify (S11) | `factory-setup backup verify --config PATH [--backup-id ID]` | No explicit owner check | Backup bytes + manifest | Lock + verification checks | Verified backup metadata in envelope | Restore remains blocked (see below) | **Implemented (core)** |
| Auth login/status (S08) | `factory-setup auth login|status --config PATH` | `auth login`: ordinary owner required; `auth status`: no owner gate | Auth dir and state paths | Lock + command-specific checks; **ordinary auth login blocked when unresolved in-flight exists (pre-adapter)** | Persisted S08 observation | Re-login when missing/expired auth | **Implemented (core)** |
| Smoke run | `factory-setup smoke --config PATH --provider fake|live --fixture toy` | Ordinary owner required | Selected provider/fixture + stage adapters | Lock + provider constraints + stage policy; **blocked before provider/process adapter call when unresolved in-flight exists** | Envelope data for provider/fixture/status | Cancel/recover depending on failure mode | **Implemented (core), live qualification OPEN** |
| Disable inference scheduling | `factory-setup inference disable --config PATH` | Ordinary owner required | Inference compose/runtime paths | Lock + S12 checks; **blocked before adapter call when unresolved in-flight exists** | Envelope confirms blocked scheduling and stop status | `resume`/`verify` | **Implemented (core)** |
| Cancel run | `factory-setup cancel --config PATH` | No owner check for request file; emergency path uses adapter policy | Cancel request file / emergency resource stop logic | Request is bound to run identity; consumed by running apply between effects | Request path (normal) or emergency stop details | Resume/recover after inspection | **Implemented (core)** |
| Recover (full + lock-only) | `factory-setup recover --config PATH [--lock-only]` | No root escalation | Recovery marker/previous snapshot/journal evidence + lock metadata | `--lock-only`: stale-owner proof only. Full recover: (1) no-op when state is consistent, (2) restores trusted `.previous` snapshot only for supported proven case, (3) returns exit 8 for unresolved marker/journal/in-flight evidence without cleanup-by-deletion | Recovery outcome (`recovery_not_required` / `recovered_previous_generation`) or explicit blocked reason/evidence | Keep evidence, then manual reconciliation or resume/re-plan per outcome | **Implemented for state/recovery core; external reconciler remains blocked** |
| Restore | `factory-setup restore --config PATH --backup-id ID --plan PATH` | No mutation allowed in Q1A | N/A (blocked before payload handling) | Hard blocked by entrypoint policy | Returns blocked envelope/exit before side effects | Q4 restore transaction/payload hardening required | **Blocked (containment)** |
| Update plan/apply | `factory-setup update plan|apply ...` | No mutation allowed in Q1A | N/A (blocked) | Dedicated update flow intentionally blocked | Returns blocked envelope/exit | Q5 update admission + transaction work required | **Blocked (containment)** |
| Inference probe | `factory-setup inference probe --config PATH --checks ...` | No mutation allowed in Q1A | N/A (blocked) | Explicit capability blocker | Returns blocked envelope/exit | Reviewed implementation required | **Blocked (containment)** |

## Important boundaries still not claimed as done

- No claim of completed narrow privileged executor (`sudo` boundary and process-tree supervision are Q1B/Q2).
- No claim of complete per-effect cancellation/cleanup semantics across every stage internals; this pass aligns journal/recovery protocol but does not finish full process-tree cancellation model.
- No claim that S03 rollback, S04 host isolation, or live/provider paths are production-qualified.
- No claim that restore/update/inference probe implementations are complete; these are intentionally blocked entrypoints in Q1A.
