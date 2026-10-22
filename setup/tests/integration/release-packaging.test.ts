import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "setup", "release", "build-release.mjs");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "setup", "release", "verify-release.mjs");

function runNode(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

test("builds reproducible signed release archive and verifies it", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p15-release-"));
  const outDir = path.join(tempRoot, "out");
  const privateKey = path.join(tempRoot, "release-private.pem");
  const publicKey = path.join(tempRoot, "release-public.pem");
  const nodeKeyring = path.join(tempRoot, "node-release-keys.gpg");

  const genPrivate = spawnSync(
    "openssl",
    ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", privateKey],
    { encoding: "utf8" }
  );
  assert.equal(genPrivate.status, 0, genPrivate.stderr);

  const genPublic = spawnSync(
    "openssl",
    ["rsa", "-pubout", "-in", privateKey, "-out", publicKey],
    { encoding: "utf8" }
  );
  assert.equal(genPublic.status, 0, genPublic.stderr);
  await fs.promises.writeFile(nodeKeyring, "fixture-node-keyring", "utf8");

  const build = runNode([
    BUILD_SCRIPT,
    "--out-dir", outDir,
    "--source-commit", "a".repeat(40),
    "--signing-key", privateKey,
    "--verify-key", publicKey,
    "--node-keyring", nodeKeyring,
    "--key-id", "test-key"
  ]);
  assert.equal(build.status, 0, build.stderr);
  const buildJson = JSON.parse(build.stdout) as { archive_path: string; checksum_path: string; signature_path: string };
  assert.equal(fs.existsSync(buildJson.archive_path), true);
  assert.equal(fs.existsSync(buildJson.checksum_path), true);
  assert.equal(fs.existsSync(buildJson.signature_path), true);

  const verify = runNode([
    VERIFY_SCRIPT,
    "--archive", buildJson.archive_path,
    "--checksum", buildJson.checksum_path,
    "--signature", buildJson.signature_path,
    "--verify-key", publicKey
  ]);
  assert.equal(verify.status, 0, verify.stderr);
  const verifyJson = JSON.parse(verify.stdout) as { signature_verified: boolean; safe_entries: boolean };
  assert.equal(verifyJson.signature_verified, true);
  assert.equal(verifyJson.safe_entries, true);

  const releaseRoot = path.join(outDir, "factory-setup-v0.0.1");
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  assert.equal(fs.existsSync(manifestPath), true);
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as {
    archive: { file: string; sha256: string };
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.archive.file, "factory-setup-v0.0.1.tar.xz");
  assert.ok(manifest.files.some((entry) => entry.path === "bootstrap-manifest.env"));
});

test("fails release build when source_commit is invalid", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "p15-release-invalid-"));
  const outDir = path.join(tempRoot, "out");
  const privateKey = path.join(tempRoot, "release-private.pem");
  const publicKey = path.join(tempRoot, "release-public.pem");
  const nodeKeyring = path.join(tempRoot, "node-release-keys.gpg");

  const genPrivate = spawnSync(
    "openssl",
    ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", privateKey],
    { encoding: "utf8" }
  );
  assert.equal(genPrivate.status, 0, genPrivate.stderr);
  const genPublic = spawnSync(
    "openssl",
    ["rsa", "-pubout", "-in", privateKey, "-out", publicKey],
    { encoding: "utf8" }
  );
  assert.equal(genPublic.status, 0, genPublic.stderr);
  await fs.promises.writeFile(nodeKeyring, "fixture-node-keyring", "utf8");

  const build = runNode([
    BUILD_SCRIPT,
    "--out-dir", outDir,
    "--source-commit", "deadbeef",
    "--signing-key", privateKey,
    "--verify-key", publicKey,
    "--node-keyring", nodeKeyring
  ]);
  assert.equal(build.status, 2);
  assert.match(build.stderr, /source commit must be 40 lowercase hex characters/);
});
