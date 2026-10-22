#!/usr/bin/env bash
set -euo pipefail

EXIT_USAGE=2
EXIT_UNSUPPORTED=3
EXIT_MANUAL=4

if [[ "${FACTORY_SETUP_OWNER_CONSENT:-}" != "YES" ]]; then
  printf 'vm-qualification: explicit owner consent is required (set FACTORY_SETUP_OWNER_CONSENT=YES)\n' >&2
  exit "$EXIT_MANUAL"
fi

if [[ "${FACTORY_SETUP_VM_DISPOSABLE:-}" != "YES" ]]; then
  printf 'vm-qualification: disposable host marker is required (set FACTORY_SETUP_VM_DISPOSABLE=YES)\n' >&2
  exit "$EXIT_UNSUPPORTED"
fi

if [[ "${1:-}" != "--host" || "${2:-}" == "" ]]; then
  printf 'Usage: setup/tests/vm/run-qualification.sh --host <user@ip-or-hostname> [--ssh-key PATH]\n' >&2
  exit "$EXIT_USAGE"
fi

HOST="$2"
SSH_KEY=""
if [[ "${3:-}" == "--ssh-key" ]]; then
  SSH_KEY="${4:-}"
fi

if [[ -n "$SSH_KEY" && ! -f "$SSH_KEY" ]]; then
  printf 'vm-qualification: SSH key does not exist: %s\n' "$SSH_KEY" >&2
  exit "$EXIT_USAGE"
fi

SSH_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

printf 'vm-qualification: checking host %s\n' "$HOST" >&2
ssh "${SSH_ARGS[@]}" "$HOST" 'uname -s && uname -m && test -f /etc/os-release && grep -E "^(ID|VERSION_ID)=" /etc/os-release'

cat <<'EOF'
vm-qualification: host reachability check passed.
Runbook ownership:
1) Copy reviewed release archive + checksums/signature + versions.lock to the host via scp.
2) Execute clean install (fresh run), second idempotent run, interrupted+resume, and reboot recovery scenarios.
3) Record exact command outputs, state receipts, observed versions/hashes, and failures in setup/docs/qualification.md.
4) Keep status as OFFLINE QUALIFIED until live owner-approved smoke and M0 evidence are completed.
EOF
