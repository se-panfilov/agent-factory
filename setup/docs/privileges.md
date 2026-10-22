# Privilege boundary (current implementation snapshot)

This document describes the **current** installer privilege model and recovery expectations for privileged effects.

## Principles

- Installer CLI must run as ordinary owner (no blanket root execution of Node code).
- Privileged effects must be explicit, narrow, and reviewable per operation.
- Gate approval and operation execution are separate: gate approval is not a postcondition proof.

## Operation map

| Operation | Command shape (argv) | Effective UID | Trusted inputs | Target paths/resources | Gate | Recovery |
|---|---|---|---|---|---|---|
| S02 package install simulation/install | apt adapter command list (pinned packages only) | root (via system package manager path) | reviewed lock/pins + observed candidate versions | apt/dpkg database | `s02-sudo-apt-install` | rerun preflight/S02 after dpkg reconciliation |
| S03 access hardening | staged adapter commands (sshd/firewall/tailscale) | root for system changes | validated config + reviewed stage plan | sshd/firewall/tailscale config and runtime | S03 gates | rollback path via stage recover/manual runbook |
| S04 docker host setup | docker + daemon config operations | root for package/daemon writes | validated config + lock pins | docker packages, daemon config, docker group | S04 gates | reconcile probe + staged cleanup/manual fix |
| S10 service unit/install | systemd adapter commands + rendered unit | root for `/etc/systemd` and service roots | reviewed manifest + validated config | unit file, release path, service data paths | S10 gates | explicit rollbackService path + DB restore when needed |
| S11 backup/restore | filesystem + sqlite checks; optional service data access | owner or root-capability dependent by target | backup manifest + validated backup id | backup root + selected payload targets | restore requires explicit plan path | failed restore remains blocked/recovery-required |
| S14 update switch | app commands from reviewed manifest + symlink switch | owner/root per deployment profile | validated config + update manifest + backup evidence | current release pointer + app state | `s14-update-apply-approved` | rollback to previous release/backup before unpause |

## Locking and cancellation

- A single installation lock (`state/lock/owner.json`) guards control-state mutations.
- Lock owner identity includes `boot_id`, `pid`, `process_start_ticks`, `nonce`, and `installation_id`.
- Cancel requests are bound to lock owner identity and are ignored by non-matching runs.
- Lock release validates ownership and refuses deleting a foreign lock.

## Explicit non-goals in current snapshot

- No claim of same-UID adversarial process isolation.
- No claim that gate approval alone proves external side effects.
- No claim that VM/live qualification has been completed.

