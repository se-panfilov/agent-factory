import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, "setup", "bootstrap.sh");
const FIXTURES_DIR = path.join(REPO_ROOT, "setup", "tests", "fixtures", "bootstrap");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeMockBin(mockBin: string): void {
  writeExecutable(
    path.join(mockBin, "id"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-u" ]]; then
  printf '%s\\n' "\${MOCK_UID:-1000}"
  exit 0
fi
/usr/bin/id "$@"
`
  );

  writeExecutable(
    path.join(mockBin, "uname"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -m)
    printf '%s\\n' "\${MOCK_UNAME_M:-x86_64}"
    ;;
  *)
    printf '%s\\n' "\${MOCK_UNAME_S:-Linux}"
    ;;
esac
`
  );

  writeExecutable(
    path.join(mockBin, "df"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-Pk" ]]; then
  target="\${2:-/}"
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/mock 1000000 1000 %s 1%% %s\\n' "\${MOCK_DF_AVAILABLE_KB:-500000}" "$target"
  exit 0
fi
/bin/df "$@"
`
  );

  writeExecutable(
    path.join(mockBin, "sha256sum"),
    `#!/usr/bin/env bash
set -euo pipefail
file="\${1:?missing file}"
sum="$(shasum -a 256 "$file" | awk '{print $1}')"
printf '%s  %s\\n' "$sum" "$file"
`
  );

  writeExecutable(
    path.join(mockBin, "gpgv"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${MOCK_GPGV_FAIL:-0}" == "1" ]]; then
  exit 1
fi
exit 0
`
  );

  writeExecutable(
    path.join(mockBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${MOCK_CURL_OFFLINE:-0}" == "1" ]]; then
  exit 6
fi
url=""
output=""
headers=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --dump-header)
      headers="$2"
      shift 2
      ;;
    --proto|--connect-timeout|--max-time)
      shift 2
      ;;
    --silent|--show-error|--location|--tlsv1.2)
      shift 1
      ;;
    --*)
      shift 1
      ;;
    *)
      url="$1"
      shift 1
      ;;
  esac
done
[[ -n "$url" ]] || exit 2
[[ -n "$output" ]] || exit 2
src="\${MOCK_DOWNLOAD_DIR:?missing MOCK_DOWNLOAD_DIR}/$(basename "$url")"
[[ -f "$src" ]] || exit 22
cp "$src" "$output"
if [[ -n "$headers" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\n' > "$headers"
fi
exit 0
`
  );

  writeExecutable(
    path.join(mockBin, "apt-get"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${MOCK_APT_LOG:-}" ]]; then
  printf 'apt-get %s\\n' "$*" >> "\${MOCK_APT_LOG}"
fi
if [[ "\${MOCK_APT_FAIL:-0}" == "1" ]]; then
  exit 1
fi
if [[ "$#" -gt 0 && "$1" == "install" && -n "\${MOCK_TOOL_BIN:-}" ]]; then
  mkdir -p "\${MOCK_TOOL_BIN}"
  cat > "\${MOCK_TOOL_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "\${MOCK_CURL_REAL:?}" "$@"
EOF
  chmod 0755 "\${MOCK_TOOL_BIN}/curl"

  cat > "\${MOCK_TOOL_BIN}/gpgv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "\${MOCK_GPGV_REAL:?}" "$@"
EOF
  chmod 0755 "\${MOCK_TOOL_BIN}/gpgv"

  cat > "\${MOCK_TOOL_BIN}/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "\${MOCK_SHA256SUM_REAL:?}" "$@"
EOF
  chmod 0755 "\${MOCK_TOOL_BIN}/sha256sum"

  cat > "\${MOCK_TOOL_BIN}/xz" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/xz "$@"
EOF
  chmod 0755 "\${MOCK_TOOL_BIN}/xz"
fi
exit 0
`
  );

  writeExecutable(
    path.join(mockBin, "sudo"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${MOCK_APT_LOG:-}" ]]; then
  printf 'sudo %s\\n' "$*" >> "\${MOCK_APT_LOG}"
fi
exec "$@"
`
  );
}

function createNodeFixture(releaseDir: string, version: string): { sha256: string; size: number } {
  const payloadRoot = path.join(releaseDir, "node-payload");
  const nodeBinDir = path.join(payloadRoot, "node-v" + version + "-linux-x64", "bin");
  fs.mkdirSync(nodeBinDir, { recursive: true });

  writeExecutable(
    path.join(nodeBinDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf 'v${version}\\n'
  exit 0
fi
printf 'fixture-node\\n'
`
  );

  const tarName = `node-v${version}-linux-x64.tar.xz`;
  const tarPath = path.join(releaseDir, tarName);
  const tarCreate = spawnSync("tar", ["-cJf", tarPath, "-C", payloadRoot, `node-v${version}-linux-x64`], {
    encoding: "utf8"
  });
  assert.equal(tarCreate.status, 0, `failed to create fixture tarball: ${tarCreate.stderr}`);

  const fileBuffer = fs.readFileSync(tarPath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const size = fileBuffer.byteLength;

  fs.writeFileSync(path.join(releaseDir, "SHASUMS256.txt"), `${sha256}  ${tarName}\n`);
  fs.writeFileSync(path.join(releaseDir, "SHASUMS256.txt.sig"), "synthetic-signature\n");
  fs.rmSync(payloadRoot, { recursive: true, force: true });

  return { sha256, size };
}

function writeManifest(
  releaseDir: string,
  options: { nodeVersion: string; sha256: string; size: number; badSha?: boolean }
): void {
  const { nodeVersion, sha256, size, badSha = false } = options;
  const effectiveSha = badSha ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : sha256;
  const tarName = `node-v${nodeVersion}-linux-x64.tar.xz`;
  const manifest = [
    "BOOTSTRAP_MANIFEST_VERSION=1",
    "SETUP_VERSION=0.0.1",
    "SETUP_CLI_ENTRY=dist/cli.js",
    `NODE_VERSION=${nodeVersion}`,
    `NODE_DIST_URL=https://example.local/${tarName}`,
    `NODE_TARBALL_SHA256=${effectiveSha}`,
    `NODE_TARBALL_SIZE=${size}`,
    "NODE_SHASUMS_URL=https://example.local/SHASUMS256.txt",
    "NODE_SHASUMS_SIG_URL=https://example.local/SHASUMS256.txt.sig",
    "NODE_KEYRING_FILE=node-release-test.gpg"
  ].join("\n");

  fs.writeFileSync(path.join(releaseDir, "bootstrap-manifest.env"), `${manifest}\n`);
}

function runBootstrap(env: NodeJS.ProcessEnv, homeDir: string, releaseDir: string): RunResult {
  const result = spawnSync("bash", [BOOTSTRAP_SCRIPT, "--release-dir", releaseDir], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      BOOTSTRAP_ALLOW_MOCK_BINARIES: "1",
      ...env
    },
    encoding: "utf8"
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

test("bootstrap installs pinned Node and is idempotent on second run", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeVersion = "24.19.0";
  const nodeFixture = createNodeFixture(releaseDir, nodeVersion);
  writeManifest(releaseDir, { nodeVersion, sha256: nodeFixture.sha256, size: nodeFixture.size });
  makeMockBin(mockBin);

  const baseEnv: NodeJS.ProcessEnv = {
    PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
    MOCK_DOWNLOAD_DIR: releaseDir
  };

  const first = runBootstrap(baseEnv, homeDir, releaseDir);
  assert.equal(first.status, 0, first.stderr);

  const nodePath = path.join(
    homeDir,
    ".local",
    "share",
    "agent-factory-setup",
    "node",
    nodeVersion,
    "bin",
    "node"
  );
  assert.equal(fs.existsSync(nodePath), true, "node binary should be installed");

  const launcherPath = path.join(homeDir, ".local", "bin", "factory-setup");
  const launcher = fs.readFileSync(launcherPath, "utf8");
  assert.match(launcher, /managed-by: agent-factory-bootstrap/);
  assert.match(launcher, /dist\/cli\.js/);

  const receiptPath = path.join(homeDir, ".local", "state", "agent-factory-setup", "bootstrap-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.stage_id, "S00");
  assert.equal(receipt.installation_complete, false);

  const second = runBootstrap(baseEnv, homeDir, releaseDir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /matching Node already installed/);
});

test("bootstrap exits with code 9 when checksum pin mismatches", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-checksum-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeFixture = createNodeFixture(releaseDir, "24.19.0");
  writeManifest(releaseDir, {
    nodeVersion: "24.19.0",
    sha256: nodeFixture.sha256,
    size: nodeFixture.size,
    badSha: true
  });
  makeMockBin(mockBin);

  const result = runBootstrap(
    {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
      MOCK_DOWNLOAD_DIR: releaseDir
    },
    homeDir,
    releaseDir
  );

  assert.equal(result.status, 9, `expected security exit code, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /hash does not match reviewed pin/);
});

test("bootstrap exits with code 9 when signature verification fails", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-signature-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeFixture = createNodeFixture(releaseDir, "24.19.0");
  writeManifest(releaseDir, { nodeVersion: "24.19.0", sha256: nodeFixture.sha256, size: nodeFixture.size });
  makeMockBin(mockBin);

  const result = runBootstrap(
    {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
      MOCK_DOWNLOAD_DIR: releaseDir,
      MOCK_GPGV_FAIL: "1"
    },
    homeDir,
    releaseDir
  );

  assert.equal(result.status, 9, `expected signature failure exit code, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /signed SHASUMS verification failed/);
});

test("bootstrap exits with code 6 when network is offline", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-offline-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeFixture = createNodeFixture(releaseDir, "24.19.0");
  writeManifest(releaseDir, { nodeVersion: "24.19.0", sha256: nodeFixture.sha256, size: nodeFixture.size });
  makeMockBin(mockBin);

  const result = runBootstrap(
    {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
      MOCK_DOWNLOAD_DIR: releaseDir,
      MOCK_CURL_OFFLINE: "1"
    },
    homeDir,
    releaseDir
  );

  assert.equal(result.status, 6, `expected download failure exit code, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /download transport error/);
});

test("bootstrap refuses root execution with code 3", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-root-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeFixture = createNodeFixture(releaseDir, "24.19.0");
  writeManifest(releaseDir, { nodeVersion: "24.19.0", sha256: nodeFixture.sha256, size: nodeFixture.size });
  makeMockBin(mockBin);

  const result = runBootstrap(
    {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
      MOCK_DOWNLOAD_DIR: releaseDir,
      MOCK_UID: "0"
    },
    homeDir,
    releaseDir
  );

  assert.equal(result.status, 3, `expected unsupported host exit code, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /run as a regular owner user/);
});

test("bootstrap rejects untrusted command locations when mock override is disabled", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-p01-untrusted-bin-"));
  const homeDir = path.join(fs.realpathSync(tempRoot), "home");
  const releaseDir = path.join(tempRoot, "release");
  const mockBin = path.join(tempRoot, "mock-bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "cli.js"), path.join(releaseDir, "dist", "cli.js"));
  fs.writeFileSync(path.join(releaseDir, "node-release-test.gpg"), "fixture-keyring");

  const nodeFixture = createNodeFixture(releaseDir, "24.19.0");
  writeManifest(releaseDir, { nodeVersion: "24.19.0", sha256: nodeFixture.sha256, size: nodeFixture.size });
  makeMockBin(mockBin);

  const result = runBootstrap(
    {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_OS_RELEASE_FILE: path.join(FIXTURES_DIR, "os-release.ubuntu-24.04"),
      MOCK_DOWNLOAD_DIR: releaseDir,
      BOOTSTRAP_ALLOW_MOCK_BINARIES: "0"
    },
    homeDir,
    releaseDir
  );

  assert.equal(result.status, 9, `expected security exit code, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /untrusted command location/);
});
