import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const releaseDir = resolve(scriptDir, "..");
const repoRoot = resolve(releaseDir, "..", "..");
const artifactsDir = join(releaseDir, "artifacts");
const trustedCommit = readArg("--source-commit");

if (!trustedCommit) {
  fail("missing --source-commit <40-hex-commit>");
}
if (!/^[0-9a-f]{40}$/.test(trustedCommit)) {
  fail("source commit must be 40 lowercase hex chars");
}

runOrFail("git", ["cat-file", "-e", `${trustedCommit}^{commit}`], repoRoot);

const listed = runOrFail(
  "git",
  ["ls-tree", "-r", "--name-only", trustedCommit, "--", "app/m0-02-runner"],
  repoRoot
)
  .trim()
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (listed.length === 0) {
  fail("trusted commit does not contain app/m0-02-runner");
}

const requiredPaths = [
  "app/m0-02-runner/runner.ts",
  "app/m0-02-runner/verify.mjs",
  "app/m0-02-runner/make-schemas.ts",
  "app/m0-02-runner/schemas/scout.json",
  "app/m0-02-runner/schemas/planner.json",
  "app/m0-02-runner/schemas/implementer.json",
  "app/m0-02-runner/schemas/reviewer.json",
];
for (const requiredPath of requiredPaths) {
  if (!listed.includes(requiredPath)) {
    fail(`required path is missing in trusted commit: ${requiredPath}`);
  }
}

const stageRoot = mkdtempSync(join(tmpdir(), "m0-03-stage-"));
const payloadRoot = join(stageRoot, "payload");
mkdirSync(payloadRoot, { recursive: true });

const contentHashes = {};
for (const repositoryPath of listed) {
  const payloadPath = repositoryPath.replace(/^app\/m0-02-runner\//, "");
  const absolutePayloadPath = join(payloadRoot, payloadPath);
  mkdirSync(dirname(absolutePayloadPath), { recursive: true });

  const content = runOrFail("git", ["show", `${trustedCommit}:${repositoryPath}`], repoRoot, "buffer");
  writeFileSync(absolutePayloadPath, content);
  contentHashes[toPosix(payloadPath)] = sha256(content);
}

const manifest = {
  schema_version: 1,
  application_version: `m0.3+${trustedCommit.slice(0, 12)}`,
  source_commit: trustedCommit,
  content_hashes: sortObjectKeys(contentHashes),
  node_range: ">=24.0.0 <25",
  capabilities: ["runner-readonly"],
  commands: {
    runner_run: ["node", "--experimental-strip-types", "runner.ts", "run"],
    runner_status: ["node", "--experimental-strip-types", "runner.ts", "status"],
    runner_stop: ["node", "--experimental-strip-types", "runner.ts", "stop"],
    verify_fake: ["node", "verify.mjs"],
  },
  config_schema_version: 1,
  state_schema_version: 1,
  migrations: {
    from: 1,
    to: 1,
  },
  security_evidence_refs: ["docs/application/M0-02.md", "docs/application/M0-03.md"],
};

writeFileSync(join(payloadRoot, "deployment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(artifactsDir, { recursive: true });
const archiveName = `agent-factory-m0.3-${trustedCommit.slice(0, 12)}.tar.gz`;
const archivePath = join(artifactsDir, archiveName);
runOrFail(
  "python3",
  [
    "-c",
    [
      "import gzip, os, tarfile, sys",
      "src = sys.argv[1]",
      "dst = sys.argv[2]",
      "with open(dst, 'wb') as raw:",
      "    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as gz:",
      "        with tarfile.open(fileobj=gz, mode='w|') as tf:",
      "            for root, dirs, files in os.walk(src):",
      "                dirs.sort()",
      "                files.sort()",
      "                for name in files:",
      "                    full = os.path.join(root, name)",
      "                    rel = os.path.relpath(full, src).replace('\\\\\\\\', '/')",
      "                    info = tf.gettarinfo(full, arcname=rel)",
      "                    info.uid = 0",
      "                    info.gid = 0",
      "                    info.uname = ''",
      "                    info.gname = ''",
      "                    info.mtime = 0",
      "                    with open(full, 'rb') as f:",
      "                        tf.addfile(info, f)",
    ].join("\n"),
    payloadRoot,
    archivePath,
  ],
  repoRoot
);

const archiveBytes = readFileSync(archivePath);
const buildReport = {
  created_at: new Date().toISOString(),
  trusted_commit: trustedCommit,
  archive_path: toPosix(relative(repoRoot, archivePath)),
  archive_sha256: sha256(archiveBytes),
  manifest_path: toPosix(relative(repoRoot, join(releaseDir, "deployment-manifest.json"))),
  manifest_sha256: sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
};

writeFileSync(join(releaseDir, "deployment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(artifactsDir, "latest-build.json"), `${JSON.stringify(buildReport, null, 2)}\n`);
rmSync(stageRoot, { recursive: true, force: true });

console.log(JSON.stringify(buildReport, null, 2));

function readArg(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function runOrFail(command, args, cwd, mode = "text") {
  const result = spawnSync(command, args, {
    cwd,
    encoding: mode === "text" ? "utf8" : undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = mode === "text" ? result.stderr : result.stderr?.toString("utf8");
    fail(`${command} failed: ${stderr?.trim() || "unknown error"}`);
  }
  return result.stdout;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sortObjectKeys(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function toPosix(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
