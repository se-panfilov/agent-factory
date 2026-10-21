import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";

interface RunnerPolicy {
  image: string;
  timeout_seconds: number;
  daily_runs: number;
  log_limit_bytes?: number;
  result_limit_bytes?: number;
  out_limit_bytes?: number;
  auth_limit_bytes?: number;
}

interface RunnerPolicyValidated {
  image: string;
  timeoutSeconds: number;
  dailyRuns: number;
  logLimitBytes: number;
  resultLimitBytes: number;
  outLimitBytes: number;
  authLimitBytes: number;
}

interface RunStatusRecord {
  id: string;
  task_id: string;
  input_sha: string;
  phase: "running" | "needs_review" | "blocked";
  reason: string | null;
  updated_at: string;
}

interface LockRecord {
  id: string;
  name: string;
  pid: number;
  input_sha: string;
  started_at: string;
}

const root = process.cwd();
const stateDir = resolve(root, "state");
const pausedPath = join(stateDir, "PAUSED");
const lockPath = join(stateDir, "active.lock");
const journalPath = join(stateDir, "events.jsonl");
const runnerLabel = "agent-factory=level1";
const logLimiterBytesDefault = 10 * 1024 * 1024;
const resultLimiterBytesDefault = 1024 * 1024;
const outLimiterBytesDefault = 4 * 1024 * 1024;
const authLimiterBytesDefault = 16 * 1024 * 1024;
const maxLineBytes = 16 * 1024;

mkdirSync(stateDir, { recursive: true, mode: 0o700 });

function jsonError(message: string): never {
  throw new Error(message);
}

function event(value: Record<string, unknown>): void {
  appendFileSync(
    journalPath,
    JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED_PEM]")
    .replace(
      /\b[A-Za-z0-9+/_-]{24,}\.[A-Za-z0-9+/_-]{24,}\.[A-Za-z0-9+/_-]{24,}\b/g,
      "[REDACTED_JWT]"
    );
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function docker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("docker operation failed");
  }
  return result.stdout.trim();
}

function listContainersByFilter(filters: string[]): string[] {
  const args = ["ps", "-aq"];
  for (const filter of filters) {
    args.push("--filter", filter);
  }
  const stdout = docker(args);
  const ids = stdout.split(/\s+/).filter(Boolean);
  for (const id of ids) {
    if (!/^[0-9a-f]{6,64}$/i.test(id)) {
      throw new Error("bad container ID");
    }
  }
  return ids;
}

function removeContainers(ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  docker(["rm", "-f", ...ids]);
}

function listStatusFiles(): RunStatusRecord[] {
  const out: RunStatusRecord[] = [];
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(join(stateDir, name), "utf8")) as RunStatusRecord;
    out.push(parsed);
  }
  out.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return out;
}

function readLockRecord(): LockRecord | null {
  if (!existsSync(lockPath)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
  return parsed;
}

function writePaused(reason: string): void {
  writeFileSync(pausedPath, `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
}

function parsePolicy(policyPath: string): RunnerPolicyValidated {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as RunnerPolicy;
  if (!/^sha256:[0-9a-f]{64}$/.test(policy.image)) {
    jsonError("invalid policy");
  }
  if (
    !Number.isInteger(policy.timeout_seconds) ||
    policy.timeout_seconds < 10 ||
    policy.timeout_seconds > 1500
  ) {
    jsonError("invalid policy");
  }
  if (!Number.isInteger(policy.daily_runs) || policy.daily_runs < 1 || policy.daily_runs > 12) {
    jsonError("invalid policy");
  }

  const readBounded = (
    value: number | undefined,
    fallback: number,
    min: number,
    max: number
  ): number => {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || value < min || value > max) {
      jsonError("invalid policy");
    }
    return value;
  };

  return {
    image: policy.image,
    timeoutSeconds: policy.timeout_seconds,
    dailyRuns: policy.daily_runs,
    logLimitBytes: readBounded(policy.log_limit_bytes, logLimiterBytesDefault, 64 * 1024, 64 * 1024 * 1024),
    resultLimitBytes: readBounded(policy.result_limit_bytes, resultLimiterBytesDefault, 1024, 8 * 1024 * 1024),
    outLimitBytes: readBounded(policy.out_limit_bytes, outLimiterBytesDefault, 1024, 64 * 1024 * 1024),
    authLimitBytes: readBounded(policy.auth_limit_bytes, authLimiterBytesDefault, 1024, 512 * 1024 * 1024),
  };
}

function directorySizeBytes(path: string, hardLimit: number): number {
  const queue = [path];
  let size = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      break;
    }
    const entries = readdirSync(current);
    for (const entry of entries) {
      const full = join(current, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error("symlink_not_allowed");
      }
      if (stat.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (stat.isFile()) {
        size += stat.size;
        if (size > hardLimit) {
          return size;
        }
      }
    }
  }
  return size;
}

function safeReadUtf8File(path: string, maxBytes: number, allowedRoot: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error("bad output");
  }
  if (stat.size > maxBytes) {
    throw new Error("bad output");
  }

  const resolvedRoot = realpathSync(allowedRoot);
  const resolvedFile = realpathSync(path);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedFile.startsWith(prefix)) {
    throw new Error("bad output");
  }

  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function compileScoutSchema(schemaPath: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  const ajv = new Ajv({ strict: true });
  return ajv.compile(schema);
}

function countTodayStarts(): number {
  if (!existsSync(journalPath)) {
    return 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const parsed = JSON.parse(line) as { at?: string; type?: string };
    if (parsed.type === "started" && typeof parsed.at === "string" && parsed.at.startsWith(today)) {
      count += 1;
    }
  }
  return count;
}

function appendSanitizedLine(path: string, chunk: Buffer, state: { remainder: string }): string[] {
  const text = state.remainder + chunk.toString("utf8");
  const lines = text.split(/\r?\n/);
  state.remainder = lines.pop() ?? "";
  const sanitized = lines.map((line) => redactSecrets(line.slice(0, maxLineBytes)));
  if (sanitized.length > 0) {
    appendFileSync(path, sanitized.join("\n") + "\n");
  }
  return sanitized;
}

function flushSanitizedRemainder(path: string, state: { remainder: string }): void {
  if (state.remainder.length === 0) {
    return;
  }
  appendFileSync(path, `${redactSecrets(state.remainder.slice(0, maxLineBytes))}\n`);
  state.remainder = "";
}

function parseEvents(path: string): unknown[] {
  const raw = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return raw.map((line) => JSON.parse(line));
}

function extractUsage(events: unknown[]): { unknown: boolean; value: Record<string, number> | null } {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const usage = (candidate as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const usageRecord: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        usageRecord[key] = value;
      }
    }
    if (Object.keys(usageRecord).length > 0) {
      return { unknown: false, value: usageRecord };
    }
  }
  return { unknown: true, value: null };
}

function ensureNoResidualByNameOrLabel(name: string, runId: string): boolean {
  try {
    const byLabel = listContainersByFilter([`label=run-id=${runId}`]);
    const byName = listContainersByFilter([`name=^/${name}$`]);
    return byLabel.length === 0 && byName.length === 0;
  } catch {
    return false;
  }
}

function statusCommand(): void {
  const paused = existsSync(pausedPath);
  const active = readLockRecord();
  const statuses = listStatusFiles();
  console.log(
    JSON.stringify(
      {
        paused,
        active,
        runs: statuses,
      },
      null,
      2
    )
  );
}

function inspectCommand(runId: string | undefined): void {
  const paused = existsSync(pausedPath);
  const active = readLockRecord();
  const residual = (() => {
    try {
      return listContainersByFilter([`label=${runnerLabel}`]);
    } catch {
      return null;
    }
  })();

  if (!runId) {
    console.log(
      JSON.stringify(
        {
          paused,
          active,
          residual_containers: residual,
        },
        null,
        2
      )
    );
    return;
  }

  const statusPath = join(stateDir, `${runId}.json`);
  const providerPath = join(stateDir, `${runId}.provider.json`);
  const payload: Record<string, unknown> = { paused, active, residual_containers: residual };
  if (existsSync(statusPath)) {
    payload.status = JSON.parse(readFileSync(statusPath, "utf8"));
  }
  if (existsSync(providerPath)) {
    payload.provider = JSON.parse(readFileSync(providerPath, "utf8"));
  }
  console.log(JSON.stringify(payload, null, 2));
}

function stopCommand(): void {
  writePaused("owner requested stop");
  const ids = listContainersByFilter([`label=${runnerLabel}`]);
  removeContainers(ids);
  const residual = listContainersByFilter([`label=${runnerLabel}`]);
  if (residual.length > 0) {
    throw new Error("cleanup_failed");
  }
  event({ type: "paused_by_owner", removed_containers: ids.length });
  console.log(JSON.stringify({ paused: true, removed_containers: ids.length }));
}

async function runCommand(repoArg: string | undefined, promptArg: string | undefined): Promise<void> {
  if (existsSync(pausedPath)) {
    throw new Error("PAUSED: owner review required");
  }
  if (!repoArg || !promptArg) {
    throw new Error("run REPO PROMPT_FILE");
  }
  if (existsSync(lockPath)) {
    throw new Error("active.lock exists");
  }
  const residualBeforeRun = listContainersByFilter([`label=${runnerLabel}`]);
  if (residualBeforeRun.length > 0) {
    throw new Error("residual_containers_detected");
  }

  const repo = realpathSync(repoArg);
  const promptFile = realpathSync(promptArg);
  const auth = realpathSync(resolve(root, "auth"));
  const schemaPath = realpathSync(resolve(root, "schemas/scout.json"));
  const policyPath = realpathSync(resolve(root, "policy-level1.json"));
  const policy = parsePolicy(policyPath);

  for (const path of [repo, auth, schemaPath, root, promptFile]) {
    if (/[\n\r,]/.test(path)) {
      throw new Error("unsupported path characters");
    }
  }

  const authBytes = directorySizeBytes(auth, policy.authLimitBytes + 1);
  if (authBytes > policy.authLimitBytes) {
    throw new Error("auth_size_limit");
  }

  const git = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const sha = git.stdout.trim();
  if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("bad Git SHA");
  }

  const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (dirty.status !== 0 || dirty.stdout) {
    throw new Error("checkout must be clean");
  }

  const prompt = readFileSync(promptFile, "utf8");
  if (Buffer.byteLength(prompt) > 65_536) {
    throw new Error("prompt too large");
  }

  const validate = compileScoutSchema(schemaPath);
  const id = randomUUID();
  const name = `factory-${id}`;
  const lockFd = openSync(lockPath, "wx", 0o600);
  writeFileSync(
    lockFd,
    JSON.stringify({
      id,
      name,
      pid: process.pid,
      input_sha: sha,
      started_at: new Date().toISOString(),
    } satisfies LockRecord)
  );
  closeSync(lockFd);

  let containerRemoved = false;
  try {
    if (countTodayStarts() >= policy.dailyRuns) {
      containerRemoved = true;
      throw new Error("daily cap");
    }

    const outDir = join(stateDir, id);
    mkdirSync(outDir, { mode: 0o700 });
    const statusPath = join(stateDir, `${id}.json`);
    const providerPath = join(stateDir, `${id}.provider.json`);
    const status = (phase: RunStatusRecord["phase"], reason: string | null): void => {
      writeJsonAtomic(statusPath, {
        id,
        task_id: id,
        input_sha: sha,
        phase,
        reason,
        updated_at: new Date().toISOString(),
      } satisfies RunStatusRecord);
    };

    status("running", null);
    event({ type: "started", id, input_sha: sha });

    const args = [
      "run",
      "--name",
      name,
      "--label",
      runnerLabel,
      "--label",
      `run-id=${id}`,
      "--restart=no",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--pids-limit=256",
      "--memory=2g",
      "--memory-swap=2g",
      "--cpus=2",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      "--network=bridge",
      "-e",
      "HOME=/tmp",
      "-e",
      "CODEX_HOME=/auth",
      "-e",
      "GITHUB_TOKEN=",
      "-e",
      "GH_TOKEN=",
      "--mount",
      `type=bind,src=${auth},dst=/auth,readonly`,
      "--mount",
      `type=bind,src=${repo},dst=/workspace,readonly`,
      "--mount",
      `type=bind,src=${outDir},dst=/out`,
      "--mount",
      `type=bind,src=${schemaPath},dst=/schema.json,readonly`,
      "-w",
      "/workspace",
      "-i",
      policy.image,
      "timeout",
      "--signal=TERM",
      "--kill-after=10s",
      `${policy.timeoutSeconds}s`,
      "codex",
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "danger-full-access",
      "--json",
      "--output-schema",
      "/schema.json",
      "--output-last-message",
      "/out/result.json",
      "-",
    ];

    let reason: string | null = null;
    let rawLogBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutPath = join(stateDir, `${id}.events.jsonl`);
    const stderrPath = join(stateDir, `${id}.stderr.log`);
    const stdoutState = { remainder: "" };
    const stderrState = { remainder: "" };

    const stop = (why: string): void => {
      if (reason) {
        return;
      }
      reason = why;
      try {
        spawnSync("docker", ["rm", "-f", name], { timeout: 15_000, stdio: "ignore" });
      } catch {
        // keep deterministic cleanup path below
      }
      child.kill("SIGKILL");
    };

    const handleLogChunk = (path: string, chunk: Buffer, state: { remainder: string }): void => {
      rawLogBytes += chunk.length;
      if (rawLogBytes > policy.logLimitBytes) {
        stop("log_limit");
        return;
      }
      appendSanitizedLine(path, chunk, state);
    };

    child.stdout.on("data", (chunk: Buffer) => handleLogChunk(stdoutPath, chunk, stdoutState));
    child.stderr.on("data", (chunk: Buffer) => handleLogChunk(stderrPath, chunk, stderrState));
    child.stdin.on("error", () => {
      // Process failure is handled by close/error handlers.
    });
    child.stdin.end(`${prompt}\nReturn role=scout, task_id=${id}, input_sha=${sha}.`);

    const interrupt = (): void => stop("interrupted");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    timer = setTimeout(() => stop("timeout"), (policy.timeoutSeconds + 20) * 1000);
    const pauseWatch = setInterval(() => {
      if (existsSync(pausedPath)) {
        stop("paused_by_owner");
      }
    }, 500);

    const code = await new Promise<number | null>((resolveCode) => {
      child.once("error", () => {
        reason = "spawn_error";
        resolveCode(null);
      });
      child.once("close", resolveCode);
    });

    clearTimeout(timer);
    clearInterval(pauseWatch);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    flushSanitizedRemainder(stdoutPath, stdoutState);
    flushSanitizedRemainder(stderrPath, stderrState);

    if (!reason && code !== 0) {
      reason = code === 124 ? "timeout" : "provider_or_runtime_error";
    }

    try {
      const events = parseEvents(stdoutPath);
      const hasCompleted = events.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).type === "turn.completed"
      );
      const hasFailure = events.some((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const type = (entry as Record<string, unknown>).type;
        return type === "turn.failed" || type === "error";
      });
      if (!hasCompleted || hasFailure) {
        reason ??= "provider_protocol_error";
      }

      const usage = extractUsage(events);
      if (usage.unknown) {
        reason ??= "usage_unknown";
      }
      writeJsonAtomic(providerPath, {
        id,
        exit_code: code,
        usage_unknown: usage.unknown,
        usage: usage.value,
        event_count: events.length,
      });
    } catch {
      reason ??= "provider_protocol_error";
      writeJsonAtomic(providerPath, {
        id,
        exit_code: code,
        usage_unknown: true,
        usage: null,
        event_count: null,
      });
    }

    try {
      spawnSync("docker", ["rm", "-f", name], { timeout: 15_000, stdio: "ignore" });
      containerRemoved = ensureNoResidualByNameOrLabel(name, id);
    } catch {
      containerRemoved = false;
    }

    if (!containerRemoved) {
      reason ??= "cleanup_failed";
      writePaused("cleanup failed; inspect Docker");
    }

    try {
      const resultPath = join(outDir, "result.json");
      const rawResult = safeReadUtf8File(resultPath, policy.resultLimitBytes, outDir);
      const resultJson = JSON.parse(rawResult) as Record<string, unknown>;
      if (!validate(resultJson) || resultJson.task_id !== id || resultJson.input_sha !== sha) {
        throw new Error("schema or identity mismatch");
      }
      const outSize = directorySizeBytes(outDir, policy.outLimitBytes + 1);
      if (outSize > policy.outLimitBytes) {
        throw new Error("out_size_limit");
      }
    } catch {
      reason ??= "invalid_result";
    }

    if (existsSync(pausedPath)) {
      reason ??= "paused_by_owner";
    }

    const phase: RunStatusRecord["phase"] = reason ? "blocked" : "needs_review";
    status(phase, reason);
    event({ type: "finished", id, phase, reason, code });
    console.log(JSON.stringify({ id, phase, reason }));
    if (reason || !containerRemoved) {
      process.exitCode = 1;
    }
  } finally {
    if (containerRemoved) {
      try {
        const lock = readLockRecord();
        if (lock && lock.id === id) {
          unlinkSync(lockPath);
        }
      } catch {
        // keep lock for explicit recovery
      }
    }
  }
}

const command = process.argv[2];

if (command === "status") {
  statusCommand();
} else if (command === "inspect") {
  inspectCommand(process.argv[3]);
} else if (command === "stop") {
  stopCommand();
} else if (command === "run") {
  await runCommand(process.argv[3], process.argv[4]);
} else {
  throw new Error("commands: run REPO PROMPT_FILE | status | stop | inspect [RUN_ID]");
}
