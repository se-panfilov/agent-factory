# Stage producer inventory (S00…S14, Q1A-R1.3)

This inventory reflects the **current executable code** (`setup/src/core/engine.ts`, `setup/src/stages/*.ts`) and is used for structural admission/recovery audits.

| Stage | Profiles / deps | Planned operations → resources | Gates / capabilities | No-op path | Current admission status |
|---|---|---|---|---|---|
| S00 | supervised, service / `[]` | `s00-bootstrap-check` → `bootstrap-receipt` | Stage gate `bootstrap-required` when receipt is absent; no stage capabilities | bootstrap receipt present | supported |
| S01 | supervised, service / `[S00]` | `s01-observe-host`, `s01-verify-host` → `host-preflight` | `runner-readonly`; no manual gates | none (always re-observable) | supported |
| S02 | supervised, service / `[S01]` | `apt-update` → `apt-metadata`; `apt-simulate` → `apt-simulation`; `apt-install` → `system-packages` | Gates: `s02-sudo-apt-update`, `s02-sudo-apt-install`, optional `s02-reboot-required` | operations list can be empty when packages already match and metadata is fresh | supported |
| S03 | supervised, service / `[S02]` | `install-tailscale` → `tailscale-package`; `stage-sshd-firewall` → `access-managed-diff`; `arm-rollback` / `disarm-rollback` → `access-rollback-timer`; `cutover` → `ssh-firewall-cutover`; `verify-tailnet` → `tailnet-connectivity` | Manual gates are operation-derived and include console/session/login/cutover approvals; no stage capabilities | `observed.status=verified` → empty plan/apply | supported (manual/security gates enforced) |
| S04 | supervised, service / `[S03]` | `install-packages` → `docker-package-set`; `daemon-log-config-merge` → `docker-daemon-log-config`; `daemon-validate-restart` → `docker-daemon-service`; `docker-group-membership` → `docker-group-membership`; `resource-probe` → `docker-fixture-probe`; `mark-managed-installation` → `docker-managed-installation` | Gates: sudo/config-diff/restart/group-ack (+ relogin gate when needed); no stage capabilities | `observed.status=verified` → empty plan/apply | supported; unmanaged/foreign Docker stays blocked before mutation |
| S05 | supervised, service / `[S04]` | `extract-release` → `application-release-staging`; `materialize-checkout` → `application-checkout`; `probe-release` → `application-release` | Stage capabilities `[]`; operation gates: release reviewed, source commit reviewed, dockerfile-build reviewed | `observed.status=verified` → empty plan/apply | supported |
| S06 | supervised, service / `[S05]` | `s06-apply-*` → `configuration-and-pinned-image` | `runner-readonly`; gates: `s06-policy-reviewed`, optional `s06-local-build-approved` | `observed.status=verified` → empty plan/apply | supported |
| S07 | supervised, service / `[S06]` | `s07-offline-verify-*` → `runner-offline-verification` | `runner-readonly`; gate `s07-offline-approval` | `observed.status=verified` → empty plan/apply | supported |
| S08 | supervised, service / `[S07]` | `s08-apply-*` → `auth-and-live-smoke` | `runner-live-smoke`; gates `s08-auth-owner-ack`, `s08-live-smoke-owner-ack` | `observed.status=verified` → empty plan/apply | **generic `apply` blocked by engine**; use dedicated `auth/smoke` commands |
| S09 | supervised, service / `[S08]` (optional) | `s09-project-proposal-*` → `github-project-proposals` | `runner-readonly`; gates include `s09-github-scopes-reviewed` and optional baseline-review gate | `observed.status=verified` → empty plan/apply | supported optional stage |
| S10 | service / `[S09]` | `s10-service-apply-*` → `service-layout-and-unit` | service capability checks are adapter-driven; gate `s10-service-owner-approved` | `observed.status=verified` → empty plan/apply | supported only for service profile |
| S11 | supervised, service / `[S07]` | `s11-ops-verify-*` → `operations-backup-health` | no stage capabilities; gate `s11-backup-owner-approved` when degraded | `observed.status=verified` → empty plan/apply | supported |
| S12 | supervised, service / `[S09]` (optional) | `s12-ollama-enable-*` → `s12-ollama-private-serving` | no stage capabilities; gate `s12-local-inference-owner-approved` | `verified/skipped` → empty plan/apply | supported optional stage (blocked when host/capability checks fail) |
| S13 | supervised, service / `[S09]` (optional) | `s13-platform-proposal-*` → `s13-platform-proposal` | capabilities `platform-browser-smoke`, `platform-collector`; gate `s13-platform-owner-approved` | `observed.status=verified` → empty plan/apply | supported optional stage |
| S14 | supervised, service / `[S07]` | `s14-update-apply-*` → `s14-maintenance-update` | capabilities `app-pause/app-stop/app-status/app-migrate/app-recover`; gate `s14-update-owner-approved` | `observed.status=verified` → empty plan/apply | **generic `apply` blocked by engine**; use dedicated update flow |

## Notes relevant to R1.3

- Engine-side receipt admission remains strict (missing/duplicate/foreign/unplanned receipts are rejected).
- Generic apply keeps containment for S08/S14.
- Operation-level journal durability is enforced in engine; stage modules remain adapter orchestration boundaries.
