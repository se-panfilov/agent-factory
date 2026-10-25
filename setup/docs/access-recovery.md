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


## R1.5 supported SSH Include inventory (policy B)

The raw collector accepts no Include, or exactly one global case-insensitive `Include /etc/ssh/sshd_config.d/*.conf` in the main file before any Match. The canonical path may be single/double quoted; whitespace and trailing whitespace-separated comments are supported. It inventories sorted `.conf` matches and their content, owner/group/mode and parent directory metadata. Each accepted file is parsed, including Match bodies. Non-Include Match directives are retained in the raw proof; effective-config output alone is insufficient.

All other Include syntax is explicitly refused with exit 5 `s03_include_unsupported`: external/relative paths, other globs, multiple paths/directives, nested/conditional Include, escapes, equals syntax or malformed quotes. A nested cycle/depth is refused at its first edge; no recursion is attempted. This intentionally limited support does not claim a complete resolver for arbitrary OpenSSH configurations. Invalid UTF-8 replacement/NUL input is refused. Bounds remain 256 KiB/file, 2 MiB total and 64 directory entries; traversal is restricted to the main file and one canonical directory. `/etc`, `/etc/ssh`, the include directory and matching files are lstat-checked without following symlinks; special files are refused before opening. Missing referenced directory, read errors and EACCES block, without mutation or permission repair. An empty canonical glob is supported and its membership proof changes when files appear/disappear.

The existing approval-to-intent raw-input guard and predecessor operation postconditions remain intact. Standard-layout content/ownership changes are refused before an access intent even when `sshd -T` is unchanged. Unsupported layouts block at plan observation. The actual host cutover (`NodeAccessAdapter.applyCutover`) and marker-only timer/rollback implementations remain **Q2 code blockers**, independent of local collector/orchestration tests; real SSH/firewall/systemd qualification is NOT RUN.
