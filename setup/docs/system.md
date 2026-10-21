# S02 system dependencies

`S02` installs only the Ubuntu package allowlist required by installer/runtime prerequisites, with exact version pins resolved from apt metadata at planning time.

## Scope and package allowlist

- **supervised profile:** `git`, `curl`, `ca-certificates`, `build-essential`, `tmux`
- **service profile:** supervised list + `ufw`, `sqlite3`
- Docker/Tailscale packages are intentionally **out of S02** and belong to later stages.

## Safety and gate behavior

- Stage flow follows contract: `observe -> plan -> apply -> verify` (no direct state writes by stage).
- `apply` uses explicit apt gates:
  - `s02-sudo-apt-update`
  - `s02-sudo-apt-install`
- Pins are embedded in S02 plan preconditions (`apt_pin:name=version`) and bound by `apt_package_set_hash`.
- If the observed package set changes after approval, apply refuses with manual action (`s02_package_set_changed`) and requires a renewed plan/gate.

## apt/dpkg handling

- apt commands run with strict options:
  - `DPkg::Lock::Timeout=120`
  - `Acquire::AllowInsecureRepositories=false`
  - `Acquire::AllowDowngradeToInsecureRepositories=false`
  - `APT::Get::AllowUnauthenticated=false`
- Lock handling is bounded by apt/dpkg timeout behavior; no lock-file deletion, no process killing.
- `dpkg --audit` is checked before/after package mutation.
- If audit reports interrupted/half-configured state, auto-repair is refused; operator must run manual repair (`dpkg --audit`, then `dpkg --configure -a` if needed).

## Verification and reboot

- `verify` enforces exact installed versions matching pinned candidates.
- `reboot-required` is detected via `/var/run/reboot-required`.
- Stage never reboots automatically; reboot remains a manual gate/action.
