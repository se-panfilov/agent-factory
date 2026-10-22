# S14 maintenance updates and paired recovery

S14 applies only reviewed staged updates from `s14-update-manifest.json` in setup state. It does not run `git pull`, does not accept floating `latest`, does not auto-merge user config, and does not include OS/Docker/model upgrades in the same plan.

## Required artifacts

- `state/s14-update-manifest.json` — reviewed update manifest (release pin, compatibility, approvals, commands).
- verified backup ID (`backup_id`) produced by S11.
- immutable staged app release directory (`app_release.release_dir`).

S14 writes:

- `state/s14-update-observation.json` — observed current pointer/backup/PAUSED status.
- `state/s14-update-receipt.json` — applied release pointer and migration outcome.

## Safety model

- **Compatibility gates**: refuses future installer state schema and incompatible state schema range.
- **Owner approvals**: requires explicit release trust, policy diff approval, permissions diff approval, and migration approval.
- **Pause-first update**: keeps `PAUSED` marker before and after update, runs pause/drain/offline smoke before migration.
- **Immutable old release**: previous `current` target is preserved for rollback; destructive cleanup is not performed.
- **Atomic activation**: switches `app/current` symlink via temp symlink + rename.
- **Crash reconciliation**: if switch happened but receipt is missing, S14 adopts and records receipt instead of replaying migration.
- **Rollback/recovery**:
  - post-migration failure attempts rollback to old `current` when compatible;
  - otherwise restores from verified backup if explicitly allowed;
  - rollback failure returns exit 8 and blocks further destructive actions.

## Operational notes

- S14 is a stage implementation (`plan/apply/verify --stage S14`) and keeps app paused after completion.
- `resume`/re-apply checks drift between `current` symlink and stored receipt before any new mutation.
- This stage is intended for fake/offline verification in repository tests; no host-level update should be executed during unit/integration runs.

