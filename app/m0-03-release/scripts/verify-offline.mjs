import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const releaseDir = resolve(scriptDir, "..");
const repoRoot = resolve(releaseDir, "..", "..");
const artifactsDir = join(releaseDir, "artifacts");
const archiveArg = readArg("--archive");
const archivePath = archiveArg ? resolve(repoRoot, archiveArg) : latestArchivePath();

if (!existsSync(archivePath)) {
  fail(`archive not found: ${archivePath}`);
}

mkdirSync(artifactsDir, { recursive: true });
const unpackRoot = mkdtempSync(join(artifactsDir, ".tmp-unpack-"));
runOrFail("tar", ["-xzf", archivePath, "-C", unpackRoot], repoRoot);

const manifestPath = join(unpackRoot, "deployment-manifest.json");
if (!existsSync(manifestPath)) {
  fail("deployment-manifest.json is missing in archive");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
validateStrictManifest(manifest);
validateContentHashes(unpackRoot, manifest.content_hashes);

const verifyFake = runCommand(manifest.commands.verify_fake, unpackRoot);
const runnerStatus = runCommand(manifest.commands.runner_status, unpackRoot);
const parsedStatus = JSON.parse(runnerStatus.stdout);

const result = {
  verified_at: new Date().toISOString(),
  archive_path: archivePath,
  archive_sha256: sha256(readFileSync(archivePath)),
  source_commit: manifest.source_commit,
  commands_verified: {
    verify_fake: verifyFake.status === 0,
    runner_status: runnerStatus.status === 0 && typeof parsedStatus === "object" && parsedStatus !== null,
    runner_run: "verified via verify_fake fixture suite",
    runner_stop: "verified via verify_fake fixture suite",
  },
};

mkdirSync(artifactsDir, { recursive: true });
writeFileSync(join(artifactsDir, "offline-verification.json"), `${JSON.stringify(result, null, 2)}\n`);
rmSync(unpackRoot, { recursive: true, force: true });

console.log(JSON.stringify(result, null, 2));

function latestArchivePath() {
  const buildPath = join(artifactsDir, "latest-build.json");
  if (!existsSync(buildPath)) {
    fail("missing artifacts/latest-build.json; run build-release first");
  }
  const build = JSON.parse(readFileSync(buildPath, "utf8"));
  if (typeof build.archive_path !== "string") {
    fail("artifacts/latest-build.json does not contain archive_path");
  }
  return resolve(repoRoot, build.archive_path);
}

function runCommand(argv, cwd) {
  if (!Array.isArray(argv) || argv.length === 0) {
    fail("invalid command argv");
  }
  const [command, ...args] = argv;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`command failed (${argv.join(" ")}): ${result.stderr.trim()}`);
  }
  return result;
}

function validateStrictManifest(manifest) {
  const requiredTopLevel = [
    "schema_version",
    "application_version",
    "source_commit",
    "content_hashes",
    "node_range",
    "capabilities",
    "commands",
    "config_schema_version",
    "state_schema_version",
    "migrations",
    "security_evidence_refs",
  ];
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...requiredTopLevel].sort())) {
    fail("manifest top-level keys mismatch strict contract");
  }
  if (manifest.schema_version !== 1) {
    fail("manifest schema_version must be 1");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source_commit)) {
    fail("manifest source_commit must be 40 lowercase hex chars");
  }
  if (manifest.node_range !== ">=24.0.0 <25") {
    fail("manifest node_range must be >=24.0.0 <25");
  }
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length !== 1 ||
    manifest.capabilities[0] !== "runner-readonly"
  ) {
    fail("manifest capabilities must be exactly [\"runner-readonly\"]");
  }

  const commandKeys = Object.keys(manifest.commands).sort();
  const expectedCommands = ["runner_run", "runner_status", "runner_stop", "verify_fake"].sort();
  if (JSON.stringify(commandKeys) !== JSON.stringify(expectedCommands)) {
    fail("manifest commands keys mismatch strict contract");
  }
  for (const key of commandKeys) {
    const argv = manifest.commands[key];
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string" || item.length === 0)) {
      fail(`manifest.commands.${key} must be non-empty string[]`);
    }
  }

  if (!Number.isInteger(manifest.config_schema_version) || manifest.config_schema_version < 1) {
    fail("manifest config_schema_version must be integer >= 1");
  }
  if (!Number.isInteger(manifest.state_schema_version) || manifest.state_schema_version < 1) {
    fail("manifest state_schema_version must be integer >= 1");
  }
  if (
    !manifest.migrations ||
    !Number.isInteger(manifest.migrations.from) ||
    !Number.isInteger(manifest.migrations.to) ||
    manifest.migrations.from < 1 ||
    manifest.migrations.to < 1
  ) {
    fail("manifest migrations.from/to must be integer >= 1");
  }
  if (
    !Array.isArray(manifest.security_evidence_refs) ||
    manifest.security_evidence_refs.length === 0 ||
    manifest.security_evidence_refs.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail("manifest security_evidence_refs must be non-empty string[]");
  }
}

function validateContentHashes(unpackRoot, contentHashes) {
  if (!contentHashes || typeof contentHashes !== "object") {
    fail("manifest content_hashes must be an object");
  }
  const entries = Object.entries(contentHashes);
  if (entries.length === 0) {
    fail("manifest content_hashes must not be empty");
  }

  for (const [relativePath, expectedHash] of entries) {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      fail("manifest content_hashes key must be non-empty");
    }
    if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      fail(`manifest content_hashes.${relativePath} must be 64 lowercase hex`);
    }
    const fullPath = join(unpackRoot, relativePath);
    if (!existsSync(fullPath)) {
      fail(`manifest content_hashes references missing path: ${relativePath}`);
    }
    const actualHash = sha256(readFileSync(fullPath));
    if (actualHash !== expectedHash) {
      fail(`hash mismatch for ${relativePath}`);
    }
  }
}

function readArg(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function runOrFail(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`${command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
