#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

function fail(message) {
  process.stderr.write(`release-verify: ${message}\n`);
  process.exit(6);
}

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
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

function validateTarEntries(archivePath) {
  const output = run("tar", ["-tf", archivePath]);
  const entries = output.split(/\r?\n/).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry === ".." || entry.includes("/../") || entry.endsWith("/..")) {
      fail(`unsafe archive entry detected: ${entry}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const archivePath = path.resolve(mustGet(options, "archive"));
  const checksumPath = path.resolve(mustGet(options, "checksum"));
  const signaturePath = path.resolve(mustGet(options, "signature"));
  const verifyKeyPath = path.resolve(mustGet(options, "verify-key"));

  for (const filePath of [archivePath, checksumPath, signaturePath, verifyKeyPath]) {
    if (!fs.existsSync(filePath)) {
      fail(`missing file: ${filePath}`);
    }
  }

  const expectedLine = fs.readFileSync(checksumPath, "utf8").trim();
  const [expectedSha] = expectedLine.split(/\s+/);
  if (!/^[0-9a-f]{64}$/.test(expectedSha ?? "")) {
    fail("checksum file must start with 64-hex sha256");
  }
  const actualSha = sha256File(archivePath);
  if (actualSha !== expectedSha) {
    fail(`archive sha256 mismatch: expected ${expectedSha}, got ${actualSha}`);
  }

  run("openssl", ["dgst", "-sha256", "-verify", verifyKeyPath, "-signature", signaturePath, archivePath]);
  validateTarEntries(archivePath);

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      archive_path: archivePath,
      archive_sha256: actualSha,
      signature_verified: true,
      safe_entries: true
    })}\n`
  );
}

main();
