#!/usr/bin/env bash
set -euo pipefail
umask 077

EXIT_USAGE=2
EXIT_UNSUPPORTED=3
EXIT_MANUAL=4
EXIT_FAILED=6
EXIT_DRIFT=8
EXIT_SECURITY=9

SCRIPT_NAME="$(basename "$0")"
RELEASE_DIR=""
OS_RELEASE_FILE="${BOOTSTRAP_OS_RELEASE_FILE:-/etc/os-release}"
AUTO_APPROVE_SUDO="${BOOTSTRAP_AUTO_APPROVE_SUDO:-0}"
ALLOW_MOCK_BINARIES="${BOOTSTRAP_ALLOW_MOCK_BINARIES:-0}"

declare -a CLEANUP_PATHS=()

log() {
  printf '%s\n' "$*" >&2
}

die() {
  local code="$1"
  shift
  log "bootstrap: $*"
  exit "$code"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

register_cleanup_path() {
  local path="$1"
  CLEANUP_PATHS+=("$path")
}

cleanup() {
  local status="$?"
  local cleanup_failed=0
  local path
  if [[ "${#CLEANUP_PATHS[@]}" -gt 0 ]]; then
    for path in "${CLEANUP_PATHS[@]}"; do
      if [[ -e "$path" ]]; then
        rm -rf -- "$path" || cleanup_failed=1
      fi
    done
  fi

  if [[ "$cleanup_failed" -ne 0 ]]; then
    log "bootstrap: cleanup failed for staging files; recovery required"
    exit "$EXIT_DRIFT"
  fi

  if [[ "$status" -ne 0 ]]; then
    exit "$status"
  fi
}

on_signal() {
  local signal="$1"
  if [[ "$signal" == "INT" ]]; then
    exit 130
  fi
  exit 143
}

trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

usage() {
  cat <<'EOF'
Usage:
  bash bootstrap.sh --release-dir PATH
  bash bootstrap.sh --help

Installs pinned Node and factory-setup launcher into the current user environment.
Root execution is not allowed.
EOF
}

require_binary() {
  local cmd="$1"
  local path
  path="$(command -v "$cmd" 2>/dev/null || true)"
  [[ -n "$path" ]] || die "$EXIT_FAILED" "required command not available: $cmd"
  [[ "$path" == /* ]] || die "$EXIT_SECURITY" "command path is not absolute: $cmd"

  if [[ "$ALLOW_MOCK_BINARIES" != "1" ]]; then
    case "$path" in
      /usr/bin/*|/bin/*|/usr/sbin/*|/sbin/*|/usr/local/bin/*|/usr/local/sbin/*) ;;
      *)
        die "$EXIT_SECURITY" "untrusted command location for $cmd: $path"
        ;;
    esac
  fi

  printf '%s\n' "$path"
}

strip_optional_quotes() {
  local value="$1"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s\n' "$value"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --release-dir)
      [[ "$#" -ge 2 ]] || die "$EXIT_USAGE" "--release-dir requires a value"
      RELEASE_DIR="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "$EXIT_USAGE" "unknown argument: $1"
      ;;
  esac
done

[[ -n "$RELEASE_DIR" ]] || die "$EXIT_USAGE" "--release-dir is required"
[[ -d "$RELEASE_DIR" ]] || die "$EXIT_USAGE" "release directory does not exist: $RELEASE_DIR"

if [[ "$(id -u)" -eq 0 ]]; then
  die "$EXIT_UNSUPPORTED" "run as a regular owner user, not root. Create/verify owner user first, then re-run bootstrap."
fi

if [[ ! -f "$OS_RELEASE_FILE" ]]; then
  die "$EXIT_UNSUPPORTED" "missing os-release file: $OS_RELEASE_FILE"
fi

os_id=""
os_version_id=""
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
  if [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    raw_value="${BASH_REMATCH[2]}"
    value="$(strip_optional_quotes "$raw_value")"
    case "$key" in
      ID) os_id="$value" ;;
      VERSION_ID) os_version_id="$value" ;;
    esac
  fi
done < "$OS_RELEASE_FILE"

[[ "$os_id" == "ubuntu" ]] || die "$EXIT_UNSUPPORTED" "unsupported OS: expected ubuntu 24.04"
[[ "$os_version_id" == "24.04" ]] || die "$EXIT_UNSUPPORTED" "unsupported Ubuntu version: expected 24.04, got ${os_version_id:-unknown}"

case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "$EXIT_UNSUPPORTED" "unsupported architecture: expected amd64" ;;
esac

ensure_no_symlink_components() {
  local path="$1"
  local current="/"
  local segment
  IFS='/' read -r -a parts <<< "${path#/}"
  for segment in "${parts[@]}"; do
    [[ -n "$segment" ]] || continue
    current="${current}${segment}"
    if [[ -L "$current" ]]; then
      die "$EXIT_SECURITY" "symlink detected in protected install path: $current"
    fi
    current="${current}/"
  done
}

require_commands=(install mkdir mv awk sed grep wc id uname df)
for cmd in "${require_commands[@]}"; do
  require_binary "$cmd" >/dev/null
done

prereq_commands=(curl tar xz sha256sum gpgv)
missing_commands=()
for cmd in "${prereq_commands[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing_commands+=("$cmd")
  fi
done

if [[ "${#missing_commands[@]}" -gt 0 ]]; then
  log "bootstrap: missing transport/verification tools: ${missing_commands[*]}"
  log "bootstrap: required package set: ca-certificates curl xz-utils gnupg"

  if [[ "$AUTO_APPROVE_SUDO" != "1" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Run minimal sudo apt install now? [y/N] " approve
      if [[ "${approve:-}" != "y" && "${approve:-}" != "Y" ]]; then
        die "$EXIT_MANUAL" "manual action required: install ca-certificates curl xz-utils gnupg and rerun bootstrap"
      fi
    else
      die "$EXIT_MANUAL" "manual action required: rerun with BOOTSTRAP_AUTO_APPROVE_SUDO=1 or install prerequisites manually"
    fi
  fi

  SUDO_BIN="$(require_binary sudo)"
  APT_GET_BIN="$(require_binary apt-get)"
  "$SUDO_BIN" -- "$APT_GET_BIN" update
  "$SUDO_BIN" -- "$APT_GET_BIN" install -y --no-install-recommends -- ca-certificates curl xz-utils gnupg

  for cmd in "${prereq_commands[@]}"; do
    require_binary "$cmd" >/dev/null || die "$EXIT_MANUAL" "sudo apt completed but command is still missing: $cmd"
  done
fi

CURL_BIN="$(require_binary curl)"
TAR_BIN="$(require_binary tar)"
SHA256SUM_BIN="$(require_binary sha256sum)"
GPGV_BIN="$(require_binary gpgv)"
AWK_BIN="$(require_binary awk)"
GREP_BIN="$(require_binary grep)"
WC_BIN="$(require_binary wc)"

MANIFEST_PATH="$RELEASE_DIR/bootstrap-manifest.env"
[[ -f "$MANIFEST_PATH" ]] || die "$EXIT_USAGE" "missing manifest: $MANIFEST_PATH"

BOOTSTRAP_MANIFEST_VERSION=""
SETUP_VERSION=""
SETUP_CLI_ENTRY=""
NODE_VERSION=""
NODE_DIST_URL=""
NODE_TARBALL_SHA256=""
NODE_TARBALL_SIZE=""
NODE_SHASUMS_URL=""
NODE_SHASUMS_SIG_URL=""
NODE_KEYRING_FILE=""

set_manifest_value() {
  local key="$1"
  local value="$2"
  case "$key" in
    BOOTSTRAP_MANIFEST_VERSION)
      [[ -z "$BOOTSTRAP_MANIFEST_VERSION" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      BOOTSTRAP_MANIFEST_VERSION="$value"
      ;;
    SETUP_VERSION)
      [[ -z "$SETUP_VERSION" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      SETUP_VERSION="$value"
      ;;
    SETUP_CLI_ENTRY)
      [[ -z "$SETUP_CLI_ENTRY" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      SETUP_CLI_ENTRY="$value"
      ;;
    NODE_VERSION)
      [[ -z "$NODE_VERSION" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_VERSION="$value"
      ;;
    NODE_DIST_URL)
      [[ -z "$NODE_DIST_URL" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_DIST_URL="$value"
      ;;
    NODE_TARBALL_SHA256)
      [[ -z "$NODE_TARBALL_SHA256" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_TARBALL_SHA256="$value"
      ;;
    NODE_TARBALL_SIZE)
      [[ -z "$NODE_TARBALL_SIZE" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_TARBALL_SIZE="$value"
      ;;
    NODE_SHASUMS_URL)
      [[ -z "$NODE_SHASUMS_URL" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_SHASUMS_URL="$value"
      ;;
    NODE_SHASUMS_SIG_URL)
      [[ -z "$NODE_SHASUMS_SIG_URL" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_SHASUMS_SIG_URL="$value"
      ;;
    NODE_KEYRING_FILE)
      [[ -z "$NODE_KEYRING_FILE" ]] || die "$EXIT_USAGE" "duplicate manifest key: $key"
      NODE_KEYRING_FILE="$value"
      ;;
    *)
      die "$EXIT_USAGE" "unsupported manifest key: $key"
      ;;
  esac
}

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line%$'\r'}"
  [[ -z "$line" ]] && continue
  [[ "${line:0:1}" == "#" ]] && continue

  if [[ ! "$line" =~ ^([A-Z0-9_]+)=(.+)$ ]]; then
    die "$EXIT_USAGE" "invalid manifest line: $line"
  fi

  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"

  set_manifest_value "$key" "$value"
done < "$MANIFEST_PATH"

[[ -n "$BOOTSTRAP_MANIFEST_VERSION" ]] || die "$EXIT_USAGE" "missing required manifest key: BOOTSTRAP_MANIFEST_VERSION"
[[ -n "$SETUP_VERSION" ]] || die "$EXIT_USAGE" "missing required manifest key: SETUP_VERSION"
[[ -n "$SETUP_CLI_ENTRY" ]] || die "$EXIT_USAGE" "missing required manifest key: SETUP_CLI_ENTRY"
[[ -n "$NODE_VERSION" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_VERSION"
[[ -n "$NODE_DIST_URL" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_DIST_URL"
[[ -n "$NODE_TARBALL_SHA256" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_TARBALL_SHA256"
[[ -n "$NODE_TARBALL_SIZE" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_TARBALL_SIZE"
[[ -n "$NODE_SHASUMS_URL" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_SHASUMS_URL"
[[ -n "$NODE_SHASUMS_SIG_URL" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_SHASUMS_SIG_URL"
[[ -n "$NODE_KEYRING_FILE" ]] || die "$EXIT_USAGE" "missing required manifest key: NODE_KEYRING_FILE"

[[ "$BOOTSTRAP_MANIFEST_VERSION" == "1" ]] || die "$EXIT_USAGE" "unsupported BOOTSTRAP_MANIFEST_VERSION"
[[ "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || die "$EXIT_USAGE" "NODE_VERSION must be an exact 24.x.y patch"
[[ "$SETUP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$EXIT_USAGE" "SETUP_VERSION must be semver"
[[ "$NODE_TARBALL_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "$EXIT_USAGE" "NODE_TARBALL_SHA256 must be 64 lowercase hex chars"
[[ "$NODE_TARBALL_SIZE" =~ ^[0-9]+$ ]] || die "$EXIT_USAGE" "NODE_TARBALL_SIZE must be an integer"
[[ "$NODE_DIST_URL" =~ ^https://.+$ ]] || die "$EXIT_USAGE" "NODE_DIST_URL must be https://"
[[ "$NODE_SHASUMS_URL" =~ ^https://.+$ ]] || die "$EXIT_USAGE" "NODE_SHASUMS_URL must be https://"
[[ "$NODE_SHASUMS_SIG_URL" =~ ^https://.+$ ]] || die "$EXIT_USAGE" "NODE_SHASUMS_SIG_URL must be https://"
[[ "$NODE_KEYRING_FILE" =~ ^[A-Za-z0-9._-]+$ ]] || die "$EXIT_USAGE" "NODE_KEYRING_FILE must be a relative file name"
[[ "$SETUP_CLI_ENTRY" =~ ^[A-Za-z0-9._/-]+$ ]] || die "$EXIT_USAGE" "SETUP_CLI_ENTRY contains unsupported characters"
[[ "$SETUP_CLI_ENTRY" != /* ]] || die "$EXIT_USAGE" "SETUP_CLI_ENTRY must be relative"
[[ "$SETUP_CLI_ENTRY" != *".."* ]] || die "$EXIT_USAGE" "SETUP_CLI_ENTRY must not contain '..'"

KEYRING_PATH="$RELEASE_DIR/$NODE_KEYRING_FILE"
[[ -f "$KEYRING_PATH" ]] || die "$EXIT_USAGE" "trusted keyring file not found: $KEYRING_PATH"

CLI_ENTRY_PATH="$RELEASE_DIR/$SETUP_CLI_ENTRY"
[[ -f "$CLI_ENTRY_PATH" ]] || die "$EXIT_USAGE" "CLI entry file not found: $CLI_ENTRY_PATH"

NODE_SHA256="$NODE_TARBALL_SHA256"
NODE_SIZE="$NODE_TARBALL_SIZE"

NODE_PREFIX_BASE="$HOME/.local/share/agent-factory-setup/node"
NODE_TARGET_DIR="$NODE_PREFIX_BASE/$NODE_VERSION"
NODE_HASH_MARKER="$NODE_TARGET_DIR/.bootstrap-node.sha256"
LAUNCHER_DIR="$HOME/.local/bin"
LAUNCHER_PATH="$LAUNCHER_DIR/factory-setup"
SETUP_STATE_DIR="$HOME/.local/state/agent-factory-setup"
RECEIPT_PATH="$SETUP_STATE_DIR/bootstrap-receipt.json"

ensure_no_symlink_components "$HOME/.local"
ensure_no_symlink_components "$HOME/.local/share"
ensure_no_symlink_components "$HOME/.local/share/agent-factory-setup"
ensure_no_symlink_components "$NODE_PREFIX_BASE"
ensure_no_symlink_components "$LAUNCHER_DIR"
ensure_no_symlink_components "$SETUP_STATE_DIR"

required_bytes=$((NODE_SIZE + 50 * 1024 * 1024))
available_kb="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
[[ "$available_kb" =~ ^[0-9]+$ ]] || die "$EXIT_FAILED" "failed to detect free disk space"
available_bytes=$((available_kb * 1024))
if [[ "$available_bytes" -lt "$required_bytes" ]]; then
  die "$EXIT_UNSUPPORTED" "insufficient free disk space for bootstrap download and staging"
fi

verify_existing_node() {
  [[ -d "$NODE_TARGET_DIR" ]] || return 1
  [[ -f "$NODE_HASH_MARKER" ]] || die "$EXIT_DRIFT" "existing Node prefix is not bootstrap-owned: $NODE_TARGET_DIR"
  current_hash="$(cat "$NODE_HASH_MARKER")"
  [[ "$current_hash" == "$NODE_SHA256" ]] || die "$EXIT_DRIFT" "existing Node hash does not match manifest pin"
  [[ -x "$NODE_TARGET_DIR/bin/node" ]] || die "$EXIT_DRIFT" "existing Node binary is missing"
  existing_version="$("$NODE_TARGET_DIR/bin/node" --version 2>/dev/null || true)"
  [[ "$existing_version" == "v$NODE_VERSION" ]] || die "$EXIT_DRIFT" "existing Node version mismatch: expected v$NODE_VERSION, got ${existing_version:-unknown}"
  return 0
}

download_with_retry() {
  local url="$1"
  local destination="$2"
  local attempt=1
  local max_attempts=3
  local curl_rc=0

  while [[ "$attempt" -le "$max_attempts" ]]; do
    local temp_file="${destination}.part"
    local headers_file="${destination}.headers"
    rm -f -- "$temp_file" "$headers_file"

    if "$CURL_BIN" --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 60 --output "$temp_file" --dump-header "$headers_file" "$url"; then
      local http_code
      http_code="$("$AWK_BIN" 'toupper(substr($1,1,5))=="HTTP/" { code=$2 } END { print code }' "$headers_file")"
      if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
        mv -- "$temp_file" "$destination"
        rm -f -- "$headers_file"
        return 0
      fi

      if [[ "$http_code" == "429" || "$http_code" == "500" || "$http_code" == "503" ]]; then
        if [[ "$attempt" -lt "$max_attempts" ]]; then
          local retry_after
          retry_after="$("$AWK_BIN" 'tolower($1) == "retry-after:" { print $2 }' "$headers_file" | tr -d '\r' | tail -n 1)"
          if [[ "$retry_after" =~ ^[0-9]+$ ]] && [[ "$retry_after" -le 60 ]]; then
            sleep "$retry_after"
          elif [[ "$attempt" -eq 1 ]]; then
            sleep 2
          else
            sleep 5
          fi
          attempt=$((attempt + 1))
          continue
        fi
      fi

      die "$EXIT_FAILED" "download failed with HTTP $http_code for $url"
    else
      curl_rc="$?"
      if [[ "$curl_rc" == "6" || "$curl_rc" == "7" || "$curl_rc" == "28" ]]; then
        if [[ "$attempt" -lt "$max_attempts" ]]; then
          if [[ "$attempt" -eq 1 ]]; then
            sleep 2
          else
            sleep 5
          fi
          attempt=$((attempt + 1))
          continue
        fi
      fi
      die "$EXIT_FAILED" "download transport error for $url (curl exit $curl_rc)"
    fi
  done

  die "$EXIT_FAILED" "download failed after retries: $url"
}

mkdir -p "$SETUP_STATE_DIR" "$NODE_PREFIX_BASE" "$LAUNCHER_DIR"

if verify_existing_node; then
  log "bootstrap: matching Node already installed at $NODE_TARGET_DIR"
else
  operation_id="$(date +%s)-$$"
  staging_dir="$SETUP_STATE_DIR/staging-node-$operation_id"
  download_dir="$staging_dir/downloads"
  extract_dir="$staging_dir/node"
  register_cleanup_path "$staging_dir"
  mkdir -p "$download_dir" "$extract_dir"

  node_tarball="$download_dir/$(basename "$NODE_DIST_URL")"
  shasums_file="$download_dir/SHASUMS256.txt"
  shasums_sig_file="$download_dir/SHASUMS256.txt.sig"

  download_with_retry "$NODE_DIST_URL" "$node_tarball"
  download_with_retry "$NODE_SHASUMS_URL" "$shasums_file"
  download_with_retry "$NODE_SHASUMS_SIG_URL" "$shasums_sig_file"

  if ! "$GPGV_BIN" --keyring "$KEYRING_PATH" "$shasums_sig_file" "$shasums_file" >/dev/null 2>&1; then
    die "$EXIT_SECURITY" "signed SHASUMS verification failed"
  fi

  shasums_hash="$("$AWK_BIN" -v n="$(basename "$NODE_DIST_URL")" '$2 == n || $2 == ("*" n) { print $1; exit }' "$shasums_file")"
  [[ -n "$shasums_hash" ]] || die "$EXIT_SECURITY" "Node tarball not found in signed SHASUMS"
  [[ "$shasums_hash" == "$NODE_SHA256" ]] || die "$EXIT_SECURITY" "signed SHASUMS hash does not match reviewed pin"

  actual_hash="$("$SHA256SUM_BIN" "$node_tarball" | "$AWK_BIN" '{print $1}')"
  [[ "$actual_hash" == "$NODE_SHA256" ]] || die "$EXIT_SECURITY" "downloaded Node tarball sha256 mismatch"

  actual_size="$("$WC_BIN" -c < "$node_tarball" | tr -d ' ')"
  [[ "$actual_size" == "$NODE_SIZE" ]] || die "$EXIT_SECURITY" "downloaded Node tarball size mismatch"

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    case "$entry" in
      /*|../*|*/../*|*/..|..)
        die "$EXIT_SECURITY" "archive traversal/absolute path detected: $entry"
        ;;
    esac
  done < <("$TAR_BIN" -tf "$node_tarball")

  "$TAR_BIN" -xJf "$node_tarball" -C "$extract_dir" --strip-components=1
  [[ -x "$extract_dir/bin/node" ]] || die "$EXIT_SECURITY" "downloaded Node archive does not contain executable bin/node"

  extracted_version="$("$extract_dir/bin/node" --version 2>/dev/null || true)"
  [[ "$extracted_version" == "v$NODE_VERSION" ]] || die "$EXIT_SECURITY" "downloaded Node version mismatch: expected v$NODE_VERSION, got ${extracted_version:-unknown}"

  staged_target="${NODE_TARGET_DIR}.tmp-${operation_id}"
  [[ ! -e "$staged_target" ]] || die "$EXIT_DRIFT" "staging target already exists: $staged_target"
  mv -- "$extract_dir" "$staged_target"
  printf '%s\n' "$NODE_SHA256" > "$staged_target/.bootstrap-node.sha256"

  if [[ -e "$NODE_TARGET_DIR" ]]; then
    if verify_existing_node; then
      rm -rf -- "$staged_target"
    else
      die "$EXIT_DRIFT" "existing Node target changed during install"
    fi
  else
    mv -- "$staged_target" "$NODE_TARGET_DIR"
  fi
fi

launcher_tmp="$SETUP_STATE_DIR/factory-setup.launcher.$$"
register_cleanup_path "$launcher_tmp"

if [[ -e "$LAUNCHER_PATH" ]] && ! "$GREP_BIN" -q "managed-by: agent-factory-bootstrap" "$LAUNCHER_PATH"; then
  die "$EXIT_DRIFT" "launcher exists and is not bootstrap-managed: $LAUNCHER_PATH"
fi

cat > "$launcher_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# managed-by: agent-factory-bootstrap
exec "$NODE_TARGET_DIR/bin/node" "$CLI_ENTRY_PATH" "\$@"
EOF
chmod 0755 "$launcher_tmp"
mv -- "$launcher_tmp" "$LAUNCHER_PATH"

receipt_tmp="$RECEIPT_PATH.tmp.$$"
register_cleanup_path "$receipt_tmp"

cat > "$receipt_tmp" <<EOF
{
  "schema_version": 1,
  "contract_version": "1.0.0",
  "stage_id": "S00",
  "overall_status": "installed",
  "installation_complete": false,
  "setup_version": "$(json_escape "$SETUP_VERSION")",
  "node_version": "$(json_escape "$NODE_VERSION")",
  "node_sha256": "$(json_escape "$NODE_SHA256")",
  "node_prefix": "$(json_escape "$NODE_TARGET_DIR")",
  "launcher_path": "$(json_escape "$LAUNCHER_PATH")",
  "release_dir": "$(json_escape "$RELEASE_DIR")",
  "phases": [
    "observe",
    "plan",
    "gated_apply",
    "verify",
    "receipt"
  ]
}
EOF

mv -- "$receipt_tmp" "$RECEIPT_PATH"
log "bootstrap: completed. Node v$NODE_VERSION installed at $NODE_TARGET_DIR"
log "bootstrap: launcher ready at $LAUNCHER_PATH"
