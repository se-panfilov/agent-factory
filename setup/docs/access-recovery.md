# S03 secure access and recovery

`S03` hardens SSH access and performs public-SSH cutover only with explicit manual evidence and rollback safety.

## Mandatory gates before cutover

- `s03-provider-console-confirmed`: owner has verified provider console access.
- `s03-second-session-validated`: independent second SSH login is active and sudo-validated.
- `s03-tailscale-login-confirmed`: tailscale device login is completed in TTY.
- `s03-ssh-firewall-diff-reviewed`: owner reviewed explicit sshd/firewall diff.
- `s03-firewall-cutover-approved`: owner approved high-risk network cutover.
- `s03-cutover-acknowledged`: owner confirmed post-cutover access from the independent path.

`S03` additionally verifies IPv4 and IPv6 public SSH exposure and refuses completion while either path remains open.

## Manual evidence files

Default node adapter reads manual evidence from:

`~/.local/state/agent-factory-setup/manual/<installation_id>/s03/`

Expected markers (`true|1|yes|ok`):

- `provider-console-confirmed`
- `second-session-validated`
- `second-session-sudo`
- `tailscale-login-confirmed`
- `cutover-ack-confirmed`
- `external-ipv4-closed`
- `external-ipv6-closed`

These markers are deterministic test/evidence inputs. They do not auto-approve gates.

## Rollback model

- staged cutover arms rollback timer for 10 minutes;
- timer remains armed until independent acknowledgement;
- on apply failure after arming/cutover, rollback is attempted immediately;
- rollback failure returns drift/recovery-required state (exit code 8 path).

`S03` is never treated as verified while rollback remains armed.

## Safety switch for host mutations

Node adapter mutations for `S03` are disabled by default and require:

`FACTORY_SETUP_ALLOW_S03_MUTATIONS=1`

This guard prevents accidental network changes on a non-disposable host. Real cutover drill must be executed only on a disposable VM/VPS with provider console and owner participation.
