#!/usr/bin/env bash
set -euo pipefail

# Managed by factory-setup S03.
# This script is intentionally tiny: restore owner-reviewed backups only.

ROLLBACK_DIR="/var/lib/agent-factory/setup/s03-rollback"

if [[ -f "${ROLLBACK_DIR}/sshd_config.backup" ]]; then
  install -m 0600 -o root -g root "${ROLLBACK_DIR}/sshd_config.backup" /etc/ssh/sshd_config
fi

if [[ -f "${ROLLBACK_DIR}/ufw-before.rules.backup" ]]; then
  install -m 0644 -o root -g root "${ROLLBACK_DIR}/ufw-before.rules.backup" /etc/ufw/before.rules
fi

if [[ -f "${ROLLBACK_DIR}/ufw-before6.rules.backup" ]]; then
  install -m 0644 -o root -g root "${ROLLBACK_DIR}/ufw-before6.rules.backup" /etc/ufw/before6.rules
fi

systemctl reload ssh || true
ufw --force reload || true
