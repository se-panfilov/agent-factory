import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";

const base = mkdtempSync(resolve(".factory-selftest-"));
const runnerSource = resolve("runner.ts");
const nodeRunArgs = ["--experimental-strip-types", "runner.ts"];
const dockerState = join(base, "docker-state.json");
writeFileSync(dockerState, JSON.stringify({ byName: {} }), "utf8");

mkdirSync(join(base, "bin"), { recursive: true });
writeFileSync(
  join(base, "bin", "docker"),
  `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
if (!statePath) process.exit(2);
if (!existsSync(dirname(statePath))) mkdirSync(dirname(statePath), { recursive: true });

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s), 'utf8');
const mode = process.env.FIXTURE_MODE || 'ok';
const stableHex = (s) => Buffer.from(s).toString('hex').slice(0, 12).padEnd(12, '0');

if (args[0] === 'ps') {
  const state = readState();
  let nameFilter = null;
  let runLabel = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--filter') continue;
    const value = args[i + 1] ?? '';
    if (value.startsWith('name=^/')) {
      nameFilter = value.replace(/^name=\\^\\//, '').replace(/\\$$/, '');
    }
    if (value.startsWith('label=run-id=')) {
      runLabel = value.replace('label=run-id=', '');
    }
  }
  const out = [];
  for (const [name, data] of Object.entries(state.byName)) {
    if (nameFilter && name !== nameFilter) continue;
    if (runLabel && data.runId !== runLabel) continue;
    out.push(data.id);
  }
  process.stdout.write(out.join('\\n'));
  process.exit(0);
}

if (args[0] === 'rm') {
  const state = readState();
  const targets = args.slice(2);
  for (const target of targets) {
    const found = Object.entries(state.byName).find(([, data]) => data.id === target || target === (data.name ?? ''));
    if (!found) continue;
    if (mode === 'cleanup_failed') continue;
    delete state.byName[found[0]];
  }
  saveState(state);
  process.exit(0);
}

if (args[0] !== 'run') process.exit(1);
const name = args[args.indexOf('--name') + 1];
const runLabelArg = args.find((x) => x.startsWith('run-id='));
const runId = runLabelArg ? runLabelArg.replace('run-id=', '') : 'unknown';
const outMount = args.find((x) => x.includes('dst=/out'));
if (!name || !outMount) process.exit(1);
const outDir = outMount.split(',').find((x) => x.startsWith('src=')).slice(4);
const state = readState();
state.byName[name] = { id: stableHex(name), runId, name };
saveState(state);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString('utf8'); });
process.stdin.on('end', () => {
  const idMatch = input.match(/task_id=([^,]+),/);
  const shaMatch = input.match(/input_sha=([0-9a-f]{40})/);
  const id = idMatch ? idMatch[1] : 'missing-id';
  const sha = shaMatch ? shaMatch[1] : '0'.repeat(40);
  const payload = {
    schema_version: 1,
    role: 'scout',
    task_id: id,
    input_sha: mode === 'wrong_sha' ? '0'.repeat(40) : sha,
    summary: 'fixture',
    blockers: [],
    findings: [],
    proposals: []
  };
  if (mode !== 'missing') {
    if (mode === 'invalid_json') {
      writeFileSync(outDir + '/result.json', '[', 'utf8');
    } else if (mode === 'extra_field') {
      writeFileSync(outDir + '/result.json', JSON.stringify({ ...payload, extra: true }), 'utf8');
    } else {
      writeFileSync(outDir + '/result.json', JSON.stringify(payload), 'utf8');
    }
  }
  const usage = mode === 'usage_unknown' ? '' : ',"usage":{"input_tokens":10,"output_tokens":3}';
  const eventType = mode === 'failed_event' ? 'turn.failed' : 'turn.completed';
  process.stdout.write('{"type":"' + eventType + '"' + usage + '}\\n');
  process.stderr.write('Bearer fixture-secret-token\\n');
  if (mode === 'timeout') process.exit(124);
  if (mode === 'nonzero') process.exit(1);
  process.exit(0);
});
`,
  { mode: 0o755 }
);

for (const role of ["scout", "planner", "implementer", "reviewer"]) {
  const validate = new Ajv({ strict: true }).compile(
    JSON.parse(readFileSync(join("schemas", `${role}.json`), "utf8"))
  );
  assert.equal(validate({}), false);
}

const runModes = [
  ["ok", 0, "needs_review", null],
  ["wrong_sha", 1, "blocked", "invalid_result"],
  ["invalid_json", 1, "blocked", "invalid_result"],
  ["missing", 1, "blocked", "invalid_result"],
  ["extra_field", 1, "blocked", "invalid_result"],
  ["failed_event", 1, "blocked", "provider_protocol_error"],
  ["nonzero", 1, "blocked", "provider_or_runtime_error"],
  ["timeout", 1, "blocked", "timeout"],
  ["usage_unknown", 1, "blocked", "usage_unknown"],
  ["cleanup_failed", 1, "blocked", "cleanup_failed"],
];

for (const [mode, expectedExit, expectedPhase, expectedReason] of runModes) {
  const dir = join(base, mode);
  mkdirSync(join(dir, "auth"), { recursive: true });
  mkdirSync(join(dir, "schemas"), { recursive: true });
  mkdirSync(join(dir, "repo"), { recursive: true });
  copyFileSync(runnerSource, join(dir, "runner.ts"));
  copyFileSync("schemas/scout.json", join(dir, "schemas/scout.json"));
  writeFileSync(
    join(dir, "policy-level1.json"),
    JSON.stringify({
      image: `sha256:${"a".repeat(64)}`,
      timeout_seconds: 10,
      daily_runs: 2,
      log_limit_bytes: 1024 * 1024,
      result_limit_bytes: 256 * 1024,
      out_limit_bytes: 1024 * 1024,
      auth_limit_bytes: 1024 * 1024,
    }),
    "utf8"
  );
  writeFileSync(join(dir, "prompt.txt"), "fixture prompt", "utf8");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: join(dir, "repo"), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);

  const env = {
    ...process.env,
    PATH: `${join(base, "bin")}:${process.env.PATH}`,
    FIXTURE_MODE: mode,
    FAKE_DOCKER_STATE: dockerState,
  };

  const first = spawnSync(
    process.execPath,
    [...nodeRunArgs, "run", "repo", "prompt.txt"],
    { cwd: dir, env, encoding: "utf8" }
  );
  assert.equal(first.status, expectedExit, `${mode}: ${first.stderr}`);
  const firstJson = JSON.parse(first.stdout.trim());
  assert.equal(firstJson.phase, expectedPhase, `${mode} phase mismatch`);
  assert.equal(firstJson.reason, expectedReason, `${mode} reason mismatch`);

  const sanitized = readFileSync(join(dir, "state", `${firstJson.id}.stderr.log`), "utf8");
  assert.match(sanitized, /Bearer \[REDACTED\]/, `${mode} redaction missing`);

  if (mode === "ok") {
    const second = spawnSync(
      process.execPath,
      [...nodeRunArgs, "run", "repo", "prompt.txt"],
      { cwd: dir, env, encoding: "utf8" }
    );
    assert.equal(second.status, 0, second.stderr);

    const third = spawnSync(
      process.execPath,
      [...nodeRunArgs, "run", "repo", "prompt.txt"],
      { cwd: dir, env, encoding: "utf8" }
    );
    assert.equal(third.status, 1, third.stderr);
    assert.match(third.stderr, /daily cap/);

    const inspect = spawnSync(process.execPath, [...nodeRunArgs, "inspect", firstJson.id], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspectJson = JSON.parse(inspect.stdout);
    assert.equal(inspectJson.status.id, firstJson.id);
  }
}

{
  const stopDir = join(base, "stop-case");
  mkdirSync(join(stopDir, "auth"), { recursive: true });
  mkdirSync(join(stopDir, "state"), { recursive: true });
  copyFileSync(runnerSource, join(stopDir, "runner.ts"));
  writeFileSync(
    join(stopDir, "state", "active.lock"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      name: "factory-fixture-stop",
      pid: 123,
      input_sha: "0".repeat(40),
      started_at: new Date().toISOString(),
    }),
    "utf8"
  );

  const state = JSON.parse(readFileSync(dockerState, "utf8"));
  state.byName["factory-fixture-stop"] = {
    id: "aabbccddeeff",
    runId: "fixture-stop",
    name: "factory-fixture-stop",
  };
  writeFileSync(dockerState, JSON.stringify(state), "utf8");

  const env = {
    ...process.env,
    PATH: `${join(base, "bin")}:${process.env.PATH}`,
    FIXTURE_MODE: "ok",
    FAKE_DOCKER_STATE: dockerState,
  };

  const stopped = spawnSync(process.execPath, [...nodeRunArgs, "stop"], {
    cwd: stopDir,
    env,
    encoding: "utf8",
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const status = spawnSync(process.execPath, [...nodeRunArgs, "status"], {
    cwd: stopDir,
    env,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.paused, true);
}

console.log("verify.mjs: PASS");
console.log(`Fixture artifacts: ${base}`);
