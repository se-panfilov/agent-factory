# S04 Docker host stage

S04 implements deterministic Docker host admission for installer scope:

- exact pinned package set (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`) from the official Docker apt repository;
- client/daemon compatibility checks;
- daemon config merge for **owned log keys only** (`log-driver`, `log-opts`) without overwriting unknown keys;
- Docker firewall backend guard (`iptables` required, `nftables` blocked);
- Docker socket and API exposure checks (no TCP/public Docker API);
- Docker group admission as a **root-equivalent manual gate** and explicit relogin requirement;
- pinned no-secret fixture probe with required limits (`--read-only`, `--cpus`, `--memory`, `--pids-limit`, `--cap-drop ALL`, `no-new-privileges`) and label ownership verification.

## Stage flow and gates

S04 follows contract stage lifecycle: `observe -> plan -> apply -> verify -> receipt`.

Primary gates:

- `s04-sudo-docker-install`
- `s04-docker-daemon-config-diff-reviewed`
- `s04-docker-daemon-restart-approved`
- `s04-docker-group-root-equivalent-ack`
- `s04-docker-group-relogin-required` (only when membership is not active in current session)

## Safety and blocked behavior

S04 is fail-closed and blocks automatic mutation for risk-sensitive states:

- unmanaged pre-existing Docker installation (`s04_existing_docker_requires_inspection`);
- foreign containers on daemon (`s04_foreign_workloads_detected`);
- conflict package set that would require auto-removal (`s04_conflict_packages_installed`);
- invalid/symlinked daemon config;
- remote Docker context or rootless daemon;
- unsupported firewall backend (`nftables`);
- missing official repo candidates.

S04 does **not** uninstall Docker and does **not** restart Docker daemon when foreign workloads are detected.

## Mutation guard for development/offline runs

`NodeDockerAdapter` blocks host mutations unless explicitly enabled:

```bash
FACTORY_SETUP_ALLOW_S04_MUTATIONS=1
```

Without this flag, S04 mutations return `s04_mutations_disabled` with manual next action.

## VM qualification scenario (NOT RUN in offline tests)

Run on a disposable Ubuntu 24.04 host only:

1. Baseline with no Docker installed and no running workloads.
2. Run `plan --stage S04` and review daemon config diff.
3. Approve S04 gates and run `apply`.
4. Confirm relogin requirement after docker-group update.
5. Re-login and run `verify --stage S04`.
6. Confirm:
   - package pins match;
   - daemon/client compatible;
   - no TCP Docker API (`2375/2376`);
   - fixture probe constraints and cleanup pass;
   - no world-writable docker socket.

