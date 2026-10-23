# Troubleshooting (P15 consolidated)

This guide maps installer failures to exact causes and safe next actions under CONTRACT 1.0.0.

| Exit | Typical public code(s) | Meaning | Safe next action |
|---|---|---|---|
| 2 | `config_required`, `config_schema_error`, `plan_hash_invalid` | CLI/config/schema input error | Fix args/schema and regenerate plan |
| 3 | `unsupported_host`, `bootstrap_unsupported`, adapter capability probe failures | Unsupported host/privilege baseline | Use Ubuntu 24.04 amd64 owner account; satisfy prerequisites |
| 4 | `*_gate_required`, `*_approval_required` | Manual approval/re-login/reboot required | Approve exact gate for current `plan_hash`, then resume |
| 5 | `unsupported_stage`, `*_capability_missing`, `*_version_lock_invalid` | Blocked by missing evidence/capability/artifact | Provide reviewed artifact/capability evidence and rerun |
| 6 | `*_download_failed`, `*_build_failed`, `*_verify_failed` | Operation/verification failed after bounded retries | Inspect local evidence, fix root cause, rerun from observe/plan |
| 7 | `lock_owned_by_another` | Another installer owns lock | Wait, cancel, or run `recover --lock-only` if stale |
| 8 | `state_resource_drift`, `*_plan_drifted`, `recovery_required`, `state_recovery_required`, `journal_recovery_required`, `recovery_unresolved`, cleanup failure | Drift/recovery required | `status --refresh`, inspect marker/journal/previous evidence, run `recover` (not lock-only) when safe, then re-plan |
| 9 | `*_pin_mismatch`, `*_signature_failed`, security checks | Security boundary/integrity violation | Replace with reviewed signed artifacts, never bypass checks |
| 10 | optional-stage failure codes | Explicit optional stage failed/blocked | Fix optional stage or rerun without explicit optional target |

## Fast incident triage flow

1. `factory-setup status --config PATH --refresh`
2. `factory-setup recover --config PATH --lock-only` (only for stale lock path)
3. `factory-setup plan --config PATH [--stage ID]`
4. `factory-setup gate list --config PATH`
5. `factory-setup gate approve --config PATH --id <gate-id> --plan-hash <hash>`
6. `factory-setup resume --config PATH [--non-interactive]`

## State and recovery notes (Q1A-R1)

- `status` without `--refresh` and `gate list` are diagnostic/read-only paths and do not quarantine, initialize, or repair state files.
- `recover --lock-only` handles only stale lock ownership and **does not clear** recovery marker, journal uncertainty, or in-flight blockers.
- Full `recover` has three truthful outcomes:
  - `recovery_not_required` (state is already consistent),
  - `recovered_previous_generation` (trusted previous snapshot restored),
  - `exit 8` (`recovery_unresolved`) when outcome cannot be proven.
- Do not delete recovery artifacts (`recovery-required.json`, `state.json.previous`, `events.jsonl`) to bypass blockers; preserve evidence and reconcile first.

## Release/transport issues

| Symptom | Cause | Next action |
|---|---|---|
| `release-verify` checksum mismatch | archive tampered or wrong checksum file | recopy archive and checksum from trusted source |
| signature verify failure | wrong key or corrupted archive/signature | verify owner public key, rebuild/re-sign reviewed archive |
| unsafe tar entry found | malformed/untrusted archive | reject artifact, rebuild from reviewed source only |

## Bootstrap issues

| Symptom | Cause | Next action |
|---|---|---|
| root execution refused | bootstrap must run as owner user | switch to owner user and rerun |
| unsupported OS/arch | non-Ubuntu24.04 amd64 host | use supported host or keep status blocked |
| `signed SHASUMS verification failed` | keyring/source mismatch | update reviewed keyring/source pins, rerun |

## Drift/idempotency issues

| Symptom | Cause | Next action |
|---|---|---|
| second run not no-op | observed pins/resources changed | inspect `versions.lock.json` and host resources, re-plan |
| verified state but resource missing | checkpoint drift | reconcile real resource state and run recover/verify |
| resource exists but no receipt | interrupted between effect/receipt | run recover/reconcile path before new mutations |
