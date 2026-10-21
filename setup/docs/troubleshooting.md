# Troubleshooting (P02 core CLI/state)

This guide covers P02 (`init/preflight/plan/apply/status/resume/verify/gate/cancel/recover`) behavior under CONTRACT 1.0.0.

## Common outcomes

| Exit code | Meaning | Typical cause | Next action |
|---|---|---|---|
| 2 | CLI/config/schema error | Missing `--config`, invalid JSON/schema, invalid plan hash | Fix inputs and rerun command |
| 3 | Unsupported host / privileges | Preflight host checks fail | Use supported Ubuntu 24.04 host/user profile |
| 4 | Manual action required | Missing/expired gate in non-interactive mode | Approve gate for current plan hash |
| 7 | Installation lock owned elsewhere | Duplicate invocation or active owner lock | Wait/cancel; if stale, run `recover --lock-only` |
| 8 | Drift/recovery required | Stale plan, state/resource drift, corrupt state | Re-observe, regenerate plan, recover as required |
| 9 | Security boundary violation | Untrusted process execution attempt | Use trusted absolute binaries and reviewed release |

## Deterministic recovery flow

1. `factory-setup status --config PATH --refresh`
2. `factory-setup recover --config PATH --lock-only` (only for stale lock)
3. `factory-setup plan --config PATH [--stage S01]`
4. `factory-setup gate list --config PATH`
5. `factory-setup gate approve --config PATH --id <gate-id> --plan-hash <hash>` (if required)
6. `factory-setup resume --config PATH [--non-interactive]`

## State and plan safety rules

- `apply` never trusts old checkpoint alone: it re-observes stage state before side effects.
- Plan is hash-bound to desired config; config drift invalidates old plan/gates.
- Lock stale detection uses `boot_id + pid + process_start_ticks`; stale lock is not removed by normal `apply`.
- Intent is recorded before effect and receipt after effect in JSONL events.
- Torn last JSONL line is quarantined (tail-only) instead of marking the full log trusted.

## Cancel and lock behavior

- `cancel` writes a separate cancellation request atomically and is available while another process holds the main lock.
- `recover --lock-only` quarantines stale lock only after owner liveness checks.
- Active lock owner cannot be force-removed by normal apply/resume path.
