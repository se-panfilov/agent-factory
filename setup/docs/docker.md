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
5. Re-login, generate/review the remaining S04 plan, approve its required gates, then run `resume`.
6. Confirm:
   - package pins match;
   - daemon/client compatible;
   - no TCP Docker API (`2375/2376`);
   - fixture probe constraints and cleanup pass;
   - no world-writable docker socket.


R1.4 clean-host resume: the plan reviews package/config/restart/group actions separately from the fixture that requires active Docker group access. Account membership is observed using `id -nG USER`; current process membership uses `id -nG` without a username. A confirmed group database change returns a receipt, then core checkpoints it and records `awaiting_manual` (exit 4). Open a new owner login session and run `resume`; it replans remaining operations from config/journal-bound receipts and fresh package/config/session observations. Approvals are required again if the new plan includes gated effects. An unchanged session is refused before a new effect intent. Neither a relogin gate nor running installer as root can satisfy the session check. No unmanaged Docker adoption is inferred from an operation ID or old planned flags.


## R1.5 service access boundary

Operation order is package install → account group update → durable manual pause if the current process lacks the group → owned config merge → config validation/restart → constrained resource probe → managed marker. The last four operations require a freshly observed active owner session and working compatible API; none runs before the pause. Service health, account membership, process membership and installer receipts are distinct evidence. Config/restart approvals must bind the newly generated remaining plan after login. Known successful group progress is checkpointed before pause, with no in-flight operation. An old-session repeat performs no new effects or intents. Unknown group effects remain blocked, never replayed.

Permission denied, daemon unavailable, malformed info/version/workload data and failed inspection are not an empty workload inventory. Counts are negative when unknown. Only proven own package/group preparation may proceed without owner API workload inspection; config/restart cannot. Active-session daemon/API/probe failures remain operational blockers, not relogin acknowledgements. Unsafe socket/TCP/foreign/unmanaged conditions retain their refusal. No `sudo docker`, `newgrp`, world-write socket or root installer workaround is introduced. Real privileged execution is still Q2 and NOT RUN.
