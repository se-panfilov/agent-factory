# S10 service admission (M1/M2 gate)

S10 deploys `agent-factory.service` only for `profile=service` and only after explicit manual gates:

- `s10-db-migration-approved` — permits pause + backup + app migrator execution.
- `s10-service-enable-approved` — permits `systemctl enable/start` for `agent-factory.service`.

## Mandatory admission evidence

1. **M1 capabilities and real commands in `deployment-manifest.json`**  
   Required capabilities: `app-recover`, `app-serve`, `app-pause`, `app-stop`, `app-migrate`, `app-status`.  
   Required commands: `app_recover`, `app_serve`, `app_pause`, `app_migrate`, `app_status`, and stop command (`app_stop` or `app_stop_all` or `runner_stop`).

2. **M2 security evidence (not filename-only)**  
   File: `<setup_state_dir>/m2-security-evidence.json` with:
   - `status = "verified"`,
   - `guide_prs` including `PR8`, `PR9`, `PR11`,
   - `evidence_refs` linked to manifest `security_evidence_refs`,
   - non-empty `provenance`.

Missing any requirement returns:

- `exit code 5`
- `code: capability_missing`
- message `blocked: capability_missing`

## Apply flow

1. Validate S09 baseline evidence provenance (`s09-baseline-evidence.json`) and `ci_result=pass`.
2. Prepare `/opt/agent-factory/releases/<commit>` and `/var/lib/agent-factory/{state,auth,work}` ownership/permissions.
3. Run app pause command.
4. Create paired SQLite backup (`<setup_state_dir>/backups/s10-<commit>.sqlite3`) when DB exists.
5. Run existing app migrator command from manifest (`app_migrate`).
6. Render and verify systemd unit (`systemd-analyze verify`), install, `daemon-reload`, then explicit `enable` + `start`.
7. Verify paused startup using app status command (`app_status` must report paused).

Automatic unpause is never performed by S10.

## Rollback behavior

On apply failure after migration sequence starts, S10 attempts rollback:

1. stop service unit,
2. restore paired backup (if backup was created),
3. run app recover command.

If rollback itself fails, stage returns `exit code 8` (`s10_rollback_failed`) and requires manual recovery.
