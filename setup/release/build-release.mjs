#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`release-build: ${message}\n`);
  process.exit(2);
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  if (result.status !== 0) {
    fail(`${binary} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout ?? "";
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function mustGet(options, key) {
  const value = options.get(key);
  if (typeof value !== "string" || value.length === 0) {
    fail(`missing required --${key}`);
  }
  return value;
}

function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

function copyRecursive(sourcePath, targetPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, targetPath);
}

function listFiles(rootPath) {
  const results = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        results.push(absolutePath);
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function normalizeMtime(rootPath) {
  const epoch = new Date(0);
  for (const absolutePath of listFiles(rootPath)) {
    fs.utimesSync(absolutePath, epoch, epoch);
  }
}

function createBootstrapManifest(lockData, setupVersion, keyringFileName) {
  const nodeUrl = lockData.node.source_url;
  const slash = nodeUrl.lastIndexOf("/");
  if (slash <= 8) {
    fail("versions.lock node.source_url must contain a file segment");
  }
  const baseUrl = nodeUrl.slice(0, slash + 1);
  const tarName = nodeUrl.slice(slash + 1);
  return [
    "BOOTSTRAP_MANIFEST_VERSION=1",
    `SETUP_VERSION=${setupVersion}`,
    "SETUP_CLI_ENTRY=dist/src/cli.js",
    `NODE_VERSION=${lockData.node.version}`,
    `NODE_DIST_URL=${nodeUrl}`,
    `NODE_TARBALL_SHA256=${lockData.node.sha256}`,
    `NODE_TARBALL_SIZE=${lockData.artifact_sizes.node_tarball_bytes}`,
    `NODE_SHASUMS_URL=${baseUrl}SHASUMS256.txt`,
    `NODE_SHASUMS_SIG_URL=${baseUrl}SHASUMS256.txt.sig`,
    `NODE_KEYRING_FILE=${keyringFileName}`
  ].join("\n") + "\n";
}

function validateLockShape(lockData) {
  if (lockData?.schema_version !== 1 || lockData?.contract_version !== "1.0.0") {
    fail("versions.lock.json must be schema_version=1 and contract_version=1.0.0");
  }
  if (!/^24\.[0-9]+\.[0-9]+$/.test(lockData?.node?.version ?? "")) {
    fail("versions.lock.json node.version must be exact 24.x.y");
  }
  if (!/^https:\/\/.+/.test(lockData?.node?.source_url ?? "")) {
    fail("versions.lock.json node.source_url must be https URL");
  }
  if (!/^[0-9a-f]{64}$/.test(lockData?.node?.sha256 ?? "")) {
    fail("versions.lock.json node.sha256 must be lowercase 64-hex");
  }
  if (!Number.isInteger(lockData?.artifact_sizes?.node_tarball_bytes) || lockData.artifact_sizes.node_tarball_bytes <= 0) {
    fail("versions.lock.json artifact_sizes.node_tarball_bytes must be a positive integer");
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDirInput = mustGet(options, "out-dir");
  const signingKeyPath = path.resolve(mustGet(options, "signing-key"));
  const verifyKeyPath = path.resolve(mustGet(options, "verify-key"));
  const nodeKeyringPath = path.resolve(mustGet(options, "node-keyring"));
  const sourceCommit = mustGet(options, "source-commit");
  const keyId = options.get("key-id") ?? "local-release-key";
  const versionsLockPath = path.resolve(options.get("versions-lock") ?? path.join(process.cwd(), "setup", "versions.lock.json"));
  const repoRoot = path.resolve(process.cwd());
  const setupRoot = path.join(repoRoot, "setup");
  const outDir = path.resolve(outDirInput);

  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    fail("source commit must be 40 lowercase hex characters");
  }

  if (!fs.existsSync(path.join(setupRoot, "dist", "src", "cli.js"))) {
    fail("missing setup/dist/src/cli.js; run 'npm --prefix setup run build' first");
  }
  if (!fs.existsSync(signingKeyPath) || !fs.existsSync(verifyKeyPath)) {
    fail("signing key or verify key file does not exist");
  }
  if (!fs.existsSync(nodeKeyringPath)) {
    fail("node keyring file does not exist");
  }
  if (!fs.existsSync(versionsLockPath)) {
    fail("versions.lock.json file does not exist");
  }

  const setupPackage = JSON.parse(fs.readFileSync(path.join(setupRoot, "package.json"), "utf8"));
  const setupVersion = setupPackage.version;
  if (typeof setupVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(setupVersion)) {
    fail("setup/package.json version must be strict semver");
  }

  const lockData = JSON.parse(fs.readFileSync(versionsLockPath, "utf8"));
  validateLockShape(lockData);

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const releaseName = `factory-setup-v${setupVersion}`;
  const releaseRoot = path.join(outDir, releaseName);
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });

  copyRecursive(path.join(setupRoot, "bootstrap.sh"), path.join(releaseRoot, "bootstrap.sh"));
  copyRecursive(path.join(setupRoot, "dist"), path.join(releaseRoot, "dist"));
  copyRecursive(path.join(setupRoot, "schemas"), path.join(releaseRoot, "schemas"));
  copyRecursive(path.join(setupRoot, "templates"), path.join(releaseRoot, "templates"));
  copyRecursive(path.join(setupRoot, "CONTRACT.md"), path.join(releaseRoot, "CONTRACT.md"));
  copyRecursive(path.join(setupRoot, "package.json"), path.join(releaseRoot, "package.json"));
  copyRecursive(path.join(setupRoot, "package-lock.json"), path.join(releaseRoot, "package-lock.json"));
  copyRecursive(path.join(setupRoot, "release-manifest.schema.json"), path.join(releaseRoot, "release-manifest.schema.json"));
  copyRecursive(versionsLockPath, path.join(releaseRoot, "versions.lock.json"));

  const keyringFileName = path.basename(nodeKeyringPath);
  copyRecursive(nodeKeyringPath, path.join(releaseRoot, keyringFileName));
  fs.writeFileSync(
    path.join(releaseRoot, "bootstrap-manifest.env"),
    createBootstrapManifest(lockData, setupVersion, keyringFileName),
    { mode: 0o600 }
  );

  const createdAt = new Date(0).toISOString();
  const releaseFiles = listFiles(releaseRoot)
    .map((absolutePath) => {
      const rel = path.relative(releaseRoot, absolutePath).split(path.sep).join("/");
      return {
        path: rel,
        size_bytes: fileSize(absolutePath),
        sha256: sha256File(absolutePath)
      };
    });

  const archivePath = path.join(outDir, `${releaseName}.tar.xz`);
  fs.rmSync(archivePath, { force: true });
  normalizeMtime(releaseRoot);
  run("tar", ["-cJf", archivePath, "-C", outDir, releaseName]);

  const archiveSha = sha256File(archivePath);
  const archiveSize = fileSize(archivePath);
  const checksumsPath = `${archivePath}.sha256`;
  fs.writeFileSync(checksumsPath, `${archiveSha}  ${path.basename(archivePath)}\n`, "utf8");

  const signaturePath = `${archivePath}.sig`;
  run("openssl", ["dgst", "-sha256", "-sign", signingKeyPath, "-out", signaturePath, archivePath]);
  run("openssl", ["dgst", "-sha256", "-verify", verifyKeyPath, "-signature", signaturePath, archivePath]);

  const manifest = {
    schema_version: 1,
    contract_version: "1.0.0",
    setup_version: setupVersion,
    source_commit: sourceCommit,
    created_at: createdAt,
    files: releaseFiles,
    versions_lock_sha256: sha256File(path.join(releaseRoot, "versions.lock.json")),
    bootstrap_manifest_sha256: sha256File(path.join(releaseRoot, "bootstrap-manifest.env")),
    archive: {
      file: path.basename(archivePath),
      sha256: archiveSha,
      size_bytes: archiveSize
    },
    signature: {
      file: path.basename(signaturePath),
      algorithm: "openssl-dgst-sha256",
      key_id: keyId
    }
  };
  fs.writeFileSync(
    path.join(releaseRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      release_root: releaseRoot,
      archive_path: archivePath,
      archive_sha256: archiveSha,
      signature_path: signaturePath,
      checksum_path: checksumsPath
    })}\n`
  );
}

main();
