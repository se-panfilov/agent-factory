# Bootstrap S00 (P01)

`setup/bootstrap.sh` — минимальный проверяемый bootstrap для S00 до запуска Node-based CLI.

## Usage

```bash
bash setup/bootstrap.sh --release-dir /path/to/release
```

Обязательные файлы в `--release-dir`:

- `bootstrap-manifest.env` (строгий allowlist key/value, версия `BOOTSTRAP_MANIFEST_VERSION=1`)
- `node-release-*.gpg` keyring (через `NODE_KEYRING_FILE`)
- prebuilt installer entrypoint (через `SETUP_CLI_ENTRY`)

Manifest keys:

- `SETUP_VERSION`
- `SETUP_CLI_ENTRY` (relative path)
- `NODE_VERSION` (exact `24.x.y`)
- `NODE_DIST_URL`
- `NODE_TARBALL_SHA256`
- `NODE_TARBALL_SIZE`
- `NODE_SHASUMS_URL`
- `NODE_SHASUMS_SIG_URL`
- `NODE_KEYRING_FILE`

## Security and safety constraints

- `set -euo pipefail`, `umask 077`, cleanup trap только для собственных staging paths.
- Root запуск запрещён (`exit 3`) с явной инструкцией перейти на owner user.
- Поддерживается только Ubuntu 24.04 amd64 (`exit 3` при несовпадении).
- `os-release` читается как data (без `source`/eval).
- Transport/verification/privileged binaries допускаются только из trusted system paths.
- Проверяются symlink boundaries на защищённых install-prefix путях.
- Без `curl | bash` и без `sudo node ...`.
- Download только по HTTPS; bounded retries для transport/read-only ошибок (до 3 попыток).
- Подпись SHASUMS (`gpgv`) и exact SHA256 pin обязательны (`exit 9` при mismatch/failure).
- Archive traversal/absolute-path entries блокируются (`exit 9`).
- Existing unowned node prefix/launcher не перезаписываются (`exit 8`).
- Receipt пишется в `~/.local/state/agent-factory-setup/bootstrap-receipt.json` и **не** помечает полную установку как завершённую (`"installation_complete": false`).

## Idempotency behavior

- Если уже установлен bootstrap-owned Node того же hash+version, повторный запуск переиспользует его.
- При несовпадении hash/version скрипт останавливается с `exit 8` (manual drift handling).
- Launcher обновляется атомарно только если он bootstrap-managed.

## Minimal sudo gate

Если отсутствуют transport/verification инструменты (`curl`, `tar`, `xz`, `sha256sum`, `gpgv`), bootstrap предлагает отдельный gate:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl xz-utils gnupg
```

`apt` не выполняется автоматически без явного подтверждения (или test-mode `BOOTSTRAP_AUTO_APPROVE_SUDO=1`).

`BOOTSTRAP_ALLOW_MOCK_BINARIES=1` предназначен только для тестовых fixtures.
