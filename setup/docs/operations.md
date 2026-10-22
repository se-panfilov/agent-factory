# S11 operations: backup, health, emergency, restore

This stage implements deterministic operations for **S11** after P10 with no fake-success paths:

- `factory-setup backup create --config PATH`
- `factory-setup backup verify --config PATH [--backup-id ID]`
- `factory-setup restore --config PATH --backup-id ID --plan PATH`
- `factory-setup cancel --config PATH --emergency`

## Backup profiles

### Level1 (supervised/service, no service DB required)

Allowlisted payload:

- `state/**`
- `deployment-manifest.json`
- `policy-level1.json`

Excluded:

- `auth/**`
- raw credentials/token files from auth path

Behavior:

1. Build backup in temporary directory.
2. Hash every payload file and write `manifest.json`.
3. Verify hashes before publish.
4. Atomically publish backup ID directory.
5. Retention removes only owned verified backups older than 14 days and **never removes the latest known-good backup**.

If backup create fails (including disk pressure), old verified copies are kept.

### Service DB add-on

If service DB exists, backup also runs SQLite `.backup` and integrity check. If required service app capability/commands are missing, command returns **blocked** (exit code 5) with manual next action; no success-shaped fallback.

## Health checks (status/verify)

S11 health is AI-free and bounded:

- service active probe
- docker health probe
- disk free threshold: 15%
- RAM available threshold: 10%
- 5-minute RAM window threshold: 10%
- optional external heartbeat status via `s11-external-heartbeat.json` secret reference metadata

Degraded health causes explicit non-verified S11 state with reasons.

## Safe restore

`restore` verifies backup first, restores through staging, and applies guarded swap:

- keeps/rewrites `state/PAUSED` (no automatic unpause)
- preserves unknown usage semantics by forcing `unknown_usage=true` in restored live-smoke state and keeping max consumed count
- does not copy auth material
- does not delete backups during restore

## Emergency cancellation (owned resources only)

`cancel --emergency` does not require installation lock and performs durable pause plus bounded stop:

1. writes `state/PAUSED`
2. runs manifest stop command (`app_stop|app_stop_all|runner_stop`)
3. stops only containers confirmed as owned by label `agent-factory.installation_id=<installation_id>`
4. skips foreign containers and reports them

If app stop capability is missing, emergency returns **blocked** with explicit manual runbook action.

## Manual runbook (SSH/VPS/reboot)

Use these steps when installer reports blocked/degraded or host tools are unavailable:

1. **SSH access lost or unstable**
   - use provider console first
   - verify user and `/home/.../work/agent-factory/state/PAUSED`
   - recover network/firewall using owner-reviewed access runbook from S03 docs

2. **Docker/systemd unavailable during emergency**
   - stop app from provider console using reviewed stop command
   - do not run broad cleanup (`docker system prune`, `find -delete`)
   - keep PAUSED marker
   - rerun `factory-setup status --config PATH --refresh`

3. **After reboot**
   - run `factory-setup status --config PATH --refresh`
   - run `factory-setup backup verify --config PATH`
   - if restore needed, run restore with explicit plan and backup ID
   - resume only after S11 verification, never as implicit unpause
