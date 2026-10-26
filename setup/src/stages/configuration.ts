import { createHash } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";
import { validateContractSchema } from "../core/validators";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const POLICY_FILENAME = "policy-level1.json";
const POLICY_PROPOSED_SUFFIX = ".proposed";
const POLICY_DIFF_SUFFIX = ".proposed.diff";
const TOY_FIXTURE_DIRNAME = "factory-toy-fixture";
const TOY_MARKER_FILENAME = ".factory-toy-fixture.json";
const IMAGE_STATE_FILENAME = "s06-agent-image.json";

interface InstallerReleaseLock {
  schema_version: 1;
  contract_version: "1.0.0";
  codex: {
    package: string;
    version: string;
    integrity: string;
  };
  images: {
    base_image_platform_digest: string;
    agent_image_digest: string;
  };
}

interface ParsedPolicy {
  valid: boolean;
  hasUnknownFields: boolean;
  parseError: string | null;
  unknownFields: string[];
}

interface DirectoryInspection {
  exists: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  mode0700: boolean;
}

interface PolicyInspection {
  exists: boolean;
  isSymlink: boolean;
  mode0600: boolean;
  hash: string | null;
  matchesCanonical: boolean;
  parsed: ParsedPolicy | null;
  proposedExists: boolean;
}

interface ToyFixtureInspection {
  exists: boolean;
  isolatedFromApplicationDir: boolean;
  markerValid: boolean;
  deterministicIdentity: boolean;
  hasUserRepoConflict: boolean;
}

interface CodexProbe {
  binaryExists: boolean;
  versionRaw: string | null;
  versionMatch: boolean;
  execHelpOk: boolean;
  loginHelpOk: boolean;
}

interface ImageStateRecord {
  schema_version: 1;
  machine_id_hash: string;
  image_digest: string;
  image_id: string;
  build_context_hash: string;
  codex_version: string;
  base_image_digest: string;
  built_at: string;
}

interface ImageInspection {
  hasRecord: boolean;
  machineMatch: boolean;
  digestMatch: boolean;
  buildContextMatch: boolean;
  codexVersionMatch: boolean;
  baseDigestMatch: boolean;
  imageDigest: string | null;
  imageId: string | null;
}

interface Snapshot {
  config: SetupConfig;
  versionLock: {
    valid: boolean;
    hash: string | null;
    errors: string[];
    codexVersion: string | null;
    codexIntegrity: string | null;
    agentImageDigest: string | null;
    baseImageDigest: string | null;
  };
  pathSafety: {
    ok: boolean;
    invalidPaths: string[];
  };
  dirs: {
    auth: DirectoryInspection;
    state: DirectoryInspection;
  };
  policy: PolicyInspection;
  toyFixture: ToyFixtureInspection;
  codexProbe: CodexProbe;
  buildContextHash: string;
  image: ImageInspection;
}

interface ParsedPlanPreconditions {
  versionLockHash: string;
  buildContextHash: string;
  codexVersion: string;
  codexIntegrity: string;
  baseImageDigest: string;
  agentImageDigest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function canonicalPolicyObject(config: SetupConfig): Record<string, unknown> {
  return {
    schema_version: 1,
    profile: config.profile,
    network_mode: "cloud-only",
    resource_profile: "daily3",
    limits: {
      daily_budget: "daily3",
      run_timeout_sec: 300
    },
    providers: [
      {
        id: "codex-cloud",
        package: "@openai/codex",
        enabled: true
      }
    ],
    roles: {
      scout: {
        provider: "codex-cloud",
        max_parallelism: 1
      }
    }
  };
}

function canonicalPolicyText(config: SetupConfig): string {
  return `${JSON.stringify(canonicalPolicyObject(config), null, 2)}\n`;
}

function buildContextFiles(baseDigest: string, codexVersion: string, codexIntegrity: string): Record<string, string> {
  const dockerfile = [
    `ARG BASE_IMAGE=${baseDigest}`,
    "FROM ${BASE_IMAGE}",
    "ARG CODEX_VERSION",
    "ARG CODEX_INTEGRITY",
    "RUN npm install -g @openai/codex@${CODEX_VERSION} --integrity=${CODEX_INTEGRITY} --ignore-scripts",
    "ENTRYPOINT [\"codex\"]",
    ""
  ].join("\n");
  const dockerignore = [
    "auth",
    "state",
    ".env",
    "*.pem",
    "*.key",
    POLICY_FILENAME,
    ""
  ].join("\n");
  const metadata = [
    "{",
    `  "schema_version": 1,`,
    `  "codex_version": "${codexVersion}",`,
    `  "codex_integrity": "${codexIntegrity}",`,
    `  "base_image_digest": "${baseDigest}"`,
    "}",
    ""
  ].join("\n");
  return {
    "Dockerfile": dockerfile,
    ".dockerignore": dockerignore,
    "build-metadata.json": metadata
  };
}

function buildContextHash(files: Record<string, string>): string {
  const normalized = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${name}\n${sha256(content)}`)
    .join("\n");
  return sha256(normalized);
}

function canonicalToyFiles(): Record<string, string> {
  return {
    "README.md": "# Agent Factory toy fixture\n\nDeterministic fixture for supervised smoke scenarios.\n",
    "tasks.json": "{\n  \"schema_version\": 1,\n  \"tasks\": [\"toy-readonly\"]\n}\n"
  };
}

function parsePolicyUnknownFields(value: unknown): ParsedPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      hasUnknownFields: false,
      parseError: "policy must be a JSON object",
      unknownFields: []
    };
  }
  const root = value as Record<string, unknown>;
  const unknown: string[] = [];
  const rootAllowed = new Set(["schema_version", "profile", "network_mode", "resource_profile", "limits", "providers", "roles"]);
  for (const key of Object.keys(root)) {
    if (!rootAllowed.has(key)) {
      unknown.push(`/${key}`);
    }
  }

  const limits = root.limits;
  if (typeof limits === "object" && limits !== null && !Array.isArray(limits)) {
    const allowed = new Set(["daily_budget", "run_timeout_sec"]);
    for (const key of Object.keys(limits as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        unknown.push(`/limits/${key}`);
      }
    }
  }

  const providers = root.providers;
  if (Array.isArray(providers)) {
    providers.forEach((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return;
      }
      const allowed = new Set(["id", "package", "enabled"]);
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (!allowed.has(key)) {
          unknown.push(`/providers/${index}/${key}`);
        }
      }
    });
  }

  const roles = root.roles;
  if (typeof roles === "object" && roles !== null && !Array.isArray(roles)) {
    const roleKeys = Object.keys(roles as Record<string, unknown>);
    for (const roleKey of roleKeys) {
      if (roleKey !== "scout") {
        unknown.push(`/roles/${roleKey}`);
        continue;
      }
      const roleValue = (roles as Record<string, unknown>)[roleKey];
      if (typeof roleValue !== "object" || roleValue === null || Array.isArray(roleValue)) {
        continue;
      }
      const allowed = new Set(["provider", "max_parallelism"]);
      for (const key of Object.keys(roleValue as Record<string, unknown>)) {
        if (!allowed.has(key)) {
          unknown.push(`/roles/scout/${key}`);
        }
      }
    }
  }

  return {
    valid: unknown.length === 0,
    hasUnknownFields: unknown.length > 0,
    parseError: null,
    unknownFields: unknown
  };
}

function lineDiff(current: string, proposed: string): string {
  if (current === proposed) {
    return "no diff\n";
  }
  const left = current.trimEnd().split("\n");
  const right = proposed.trimEnd().split("\n");
  const lines: string[] = [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === r) {
      if (l !== undefined) {
        lines.push(` ${l}`);
      }
      continue;
    }
    if (l !== undefined) {
      lines.push(`-${l}`);
    }
    if (r !== undefined) {
      lines.push(`+${r}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function hasUnsafePathToken(value: string): boolean {
  return value.includes("\n") || value.includes(",") || value.includes("\r");
}

async function inspectPath(fsAdapter: FilesystemAdapter, targetPath: string): Promise<{
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  mode: number;
}> {
  if (!(await fsAdapter.exists(targetPath))) {
    return {
      exists: false,
      isDirectory: false,
      isFile: false,
      isSymlink: false,
      mode: 0
    };
  }
  const stat = await fsAdapter.lstat(targetPath);
  const rawMode = typeof stat.mode === "bigint" ? Number(stat.mode) : stat.mode;
  return {
    exists: true,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymlink: stat.isSymbolicLink(),
    mode: rawMode & 0o777
  };
}

async function readVersionLock(fsAdapter: FilesystemAdapter, lockPath: string): Promise<{
  lock: InstallerReleaseLock | null;
  hash: string | null;
  errors: string[];
}> {
  try {
    const raw = await fsAdapter.readText(lockPath);
    const parsed = JSON.parse(raw);
    const validation = validateContractSchema("installer-release", parsed);
    if (!validation.ok) {
      return {
        lock: null,
        hash: sha256(raw),
        errors: validation.errors
      };
    }
    return {
      lock: parsed as InstallerReleaseLock,
      hash: sha256(raw),
      errors: []
    };
  } catch (error) {
    return {
      lock: null,
      hash: null,
      errors: [error instanceof Error ? error.message : "version_lock_read_failed"]
    };
  }
}

function configPathsForSafety(config: SetupConfig): Array<{ label: string; value: string }> {
  return [
    { label: "application_dir", value: config.paths.application_dir },
    { label: "application_auth_dir", value: config.paths.application_auth_dir },
    { label: "application_state_dir", value: config.paths.application_state_dir },
    { label: "application_work_dir", value: config.paths.application_work_dir },
    { label: "version_lock_path", value: config.version_lock_path },
    { label: "setup_cache_dir", value: config.paths.setup_cache_dir },
    { label: "setup_state_dir", value: config.paths.setup_state_dir }
  ];
}

function parsePlanPreconditions(plan: StagePlan): ParsedPlanPreconditions {
  let versionLockHash: string | null = null;
  let buildCtxHash: string | null = null;
  let codexVersion: string | null = null;
  let codexIntegrity: string | null = null;
  let baseImageDigest: string | null = null;
  let agentImageDigest: string | null = null;

  for (const operation of plan.operations) {
    for (const precondition of operation.preconditions) {
      if (precondition.startsWith("s06_version_lock_hash:")) {
        versionLockHash = precondition.slice("s06_version_lock_hash:".length);
      } else if (precondition.startsWith("s06_build_context_hash:")) {
        buildCtxHash = precondition.slice("s06_build_context_hash:".length);
      } else if (precondition.startsWith("s06_codex_version:")) {
        codexVersion = precondition.slice("s06_codex_version:".length);
      } else if (precondition.startsWith("s06_codex_integrity:")) {
        codexIntegrity = precondition.slice("s06_codex_integrity:".length);
      } else if (precondition.startsWith("s06_base_image_digest:")) {
        baseImageDigest = precondition.slice("s06_base_image_digest:".length);
      } else if (precondition.startsWith("s06_agent_image_digest:")) {
        agentImageDigest = precondition.slice("s06_agent_image_digest:".length);
      }
    }
  }

  if (
    versionLockHash === null
    || buildCtxHash === null
    || codexVersion === null
    || codexIntegrity === null
    || baseImageDigest === null
    || agentImageDigest === null
    || versionLockHash.length === 0
    || buildCtxHash.length === 0
    || codexVersion.length === 0
    || codexIntegrity.length === 0
    || baseImageDigest.length === 0
    || agentImageDigest.length === 0
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s06_plan_preconditions_missing",
      publicMessage: "S06 plan preconditions are incomplete.",
      nextAction: "Regenerate S06 plan and approve updated gates.",
      stage: "S06"
    });
  }

  return {
    versionLockHash,
    buildContextHash: buildCtxHash,
    codexVersion,
    codexIntegrity,
    baseImageDigest,
    agentImageDigest
  };
}

function inferStatus(snapshot: Snapshot): StageObservation["status"] {
  if (!snapshot.pathSafety.ok) {
    return "blocked";
  }
  if (!snapshot.versionLock.valid) {
    return "blocked";
  }
  if (!snapshot.codexProbe.binaryExists || !snapshot.codexProbe.versionMatch || !snapshot.codexProbe.execHelpOk || !snapshot.codexProbe.loginHelpOk) {
    return "blocked";
  }
  if (
    snapshot.dirs.auth.isSymlink
    || snapshot.dirs.state.isSymlink
    || snapshot.policy.isSymlink
  ) {
    return "blocked";
  }
  if (snapshot.policy.parsed?.hasUnknownFields === true || snapshot.policy.parsed?.parseError !== null) {
    return "blocked";
  }
  if (snapshot.policy.exists && !snapshot.policy.matchesCanonical) {
    return "awaiting_manual";
  }
  if (
    snapshot.dirs.auth.mode0700
    && snapshot.dirs.state.mode0700
    && snapshot.policy.exists
    && snapshot.policy.mode0600
    && snapshot.policy.matchesCanonical
    && snapshot.toyFixture.exists
    && snapshot.toyFixture.markerValid
    && snapshot.toyFixture.deterministicIdentity
    && snapshot.image.digestMatch
    && snapshot.image.buildContextMatch
    && snapshot.image.machineMatch
    && snapshot.image.codexVersionMatch
    && snapshot.image.baseDigestMatch
  ) {
    return "verified";
  }
  return "planned";
}

function checksFromSnapshot(snapshot: Snapshot): Record<string, string | number | boolean> {
  return {
    s06_version_lock_valid: snapshot.versionLock.valid,
    s06_paths_safe: snapshot.pathSafety.ok,
    s06_auth_dir_private_0700: snapshot.dirs.auth.mode0700,
    s06_state_dir_private_0700: snapshot.dirs.state.mode0700,
    s06_policy_exists: snapshot.policy.exists,
    s06_policy_private_0600: snapshot.policy.mode0600,
    s06_policy_matches_canonical: snapshot.policy.matchesCanonical,
    s06_policy_unknown_fields: snapshot.policy.parsed?.hasUnknownFields === true,
    s06_policy_parse_error: snapshot.policy.parsed?.parseError !== null,
    s06_policy_proposed_exists: snapshot.policy.proposedExists,
    s06_toy_fixture_exists: snapshot.toyFixture.exists,
    s06_toy_fixture_isolated: snapshot.toyFixture.isolatedFromApplicationDir,
    s06_toy_fixture_marker_valid: snapshot.toyFixture.markerValid,
    s06_toy_fixture_deterministic_identity: snapshot.toyFixture.deterministicIdentity,
    s06_toy_fixture_user_repo_conflict: snapshot.toyFixture.hasUserRepoConflict,
    s06_codex_binary_exists: snapshot.codexProbe.binaryExists,
    s06_codex_version_match: snapshot.codexProbe.versionMatch,
    s06_codex_exec_help_ok: snapshot.codexProbe.execHelpOk,
    s06_codex_login_help_ok: snapshot.codexProbe.loginHelpOk,
    s06_agent_image_digest_match: snapshot.image.digestMatch,
    s06_agent_image_machine_match: snapshot.image.machineMatch,
    s06_agent_image_context_match: snapshot.image.buildContextMatch,
    s06_agent_image_codex_match: snapshot.image.codexVersionMatch,
    s06_agent_image_base_match: snapshot.image.baseDigestMatch
  };
}

function versionsFromSnapshot(snapshot: Snapshot): Record<string, string> {
  return {
    s06_version_lock_hash: snapshot.versionLock.hash ?? "absent",
    s06_expected_codex_version: snapshot.versionLock.codexVersion ?? "absent",
    s06_observed_codex_version: snapshot.codexProbe.versionRaw ?? "absent",
    s06_expected_base_image_digest: snapshot.versionLock.baseImageDigest ?? "absent",
    s06_expected_agent_image_digest: snapshot.versionLock.agentImageDigest ?? "absent",
    s06_build_context_hash: snapshot.buildContextHash,
    s06_local_image_digest: snapshot.image.imageDigest ?? "absent",
    s06_local_image_id: snapshot.image.imageId ?? "absent",
    s06_policy_hash: snapshot.policy.hash ?? "absent"
  };
}

async function probeCodex(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  codexBinary: string,
  expectedVersion: string | null
): Promise<CodexProbe> {
  const binaryExists = await fsAdapter.exists(codexBinary);
  if (!binaryExists) {
    return {
      binaryExists: false,
      versionRaw: null,
      versionMatch: false,
      execHelpOk: false,
      loginHelpOk: false
    };
  }

  const run = async (args: string[]): Promise<{ exitCode: number; stdout: string; timedOut: boolean }> => {
    try {
      return await processAdapter.runCommand({
        binary: codexBinary,
        args,
        timeoutMs: OBSERVE_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES
      });
    } catch (error) {
      return {
        exitCode: 127,
        stdout: error instanceof Error ? error.message : "command_failed",
        timedOut: false
      };
    }
  };

  const versionResult = await run(["--version"]);
  const execHelpResult = await run(["exec", "--help"]);
  const loginHelpResult = await run(["login", "--help"]);

  const versionRaw = versionResult.exitCode === 0 ? versionResult.stdout.trim() : null;
  const normalizedObserved = versionRaw === null ? null : normalizeVersion(versionRaw.split(/\s+/)[0] ?? "");
  const normalizedExpected = expectedVersion === null ? null : normalizeVersion(expectedVersion);

  return {
    binaryExists: true,
    versionRaw: normalizedObserved,
    versionMatch: normalizedObserved !== null && normalizedExpected !== null && normalizedObserved === normalizedExpected,
    execHelpOk: execHelpResult.exitCode === 0 && !execHelpResult.timedOut,
    loginHelpOk: loginHelpResult.exitCode === 0 && !loginHelpResult.timedOut
  };
}

function policyPath(config: SetupConfig): string {
  return path.join(config.paths.application_dir, POLICY_FILENAME);
}

function toyFixturePath(config: SetupConfig): string {
  return path.join(config.paths.application_work_dir, TOY_FIXTURE_DIRNAME);
}

function imageStatePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, IMAGE_STATE_FILENAME);
}

async function inspectPolicy(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<PolicyInspection> {
  const targetPath = policyPath(config);
  const proposedPath = `${targetPath}${POLICY_PROPOSED_SUFFIX}`;
  const stat = await inspectPath(fsAdapter, targetPath);
  if (!stat.exists) {
    return {
      exists: false,
      isSymlink: false,
      mode0600: false,
      hash: null,
      matchesCanonical: false,
      parsed: null,
      proposedExists: await fsAdapter.exists(proposedPath)
    };
  }
  const raw = await fsAdapter.readText(targetPath);
  const hash = sha256(raw);
  const canonical = canonicalPolicyText(config);
  let parsed: ParsedPolicy;
  try {
    const value = JSON.parse(raw);
    parsed = parsePolicyUnknownFields(value);
  } catch (error) {
    parsed = {
      valid: false,
      hasUnknownFields: false,
      parseError: error instanceof Error ? error.message : "parse_failed",
      unknownFields: []
    };
  }
  return {
    exists: true,
    isSymlink: stat.isSymlink,
    mode0600: stat.mode === 0o600,
    hash,
    matchesCanonical: hash === sha256(canonical),
    parsed,
    proposedExists: await fsAdapter.exists(proposedPath)
  };
}

async function inspectToyFixture(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<ToyFixtureInspection> {
  const fixtureDir = toyFixturePath(config);
  const markerPath = path.join(fixtureDir, TOY_MARKER_FILENAME);
  const fixtureExists = await fsAdapter.exists(fixtureDir);
  const applicationResolved = path.resolve(config.paths.application_dir);
  const fixtureResolved = path.resolve(fixtureDir);
  const isolated = !fixtureResolved.startsWith(`${applicationResolved}${path.sep}`);
  if (!fixtureExists) {
    return {
      exists: false,
      isolatedFromApplicationDir: isolated,
      markerValid: false,
      deterministicIdentity: false,
      hasUserRepoConflict: false
    };
  }
  const markerExists = await fsAdapter.exists(markerPath);
  if (!markerExists) {
    const gitDirExists = await fsAdapter.exists(path.join(fixtureDir, ".git"));
    return {
      exists: true,
      isolatedFromApplicationDir: isolated,
      markerValid: false,
      deterministicIdentity: false,
      hasUserRepoConflict: gitDirExists
    };
  }
  try {
    const markerRaw = await fsAdapter.readText(markerPath);
    const marker = JSON.parse(markerRaw) as { fixture_hash?: unknown; deterministic_identity?: unknown };
    const files = canonicalToyFiles();
    const expectedHash = sha256(Object.entries(files).map(([name, content]) => `${name}:${sha256(content)}`).join("|"));
    return {
      exists: true,
      isolatedFromApplicationDir: isolated,
      markerValid: marker.fixture_hash === expectedHash,
      deterministicIdentity: marker.deterministic_identity === true,
      hasUserRepoConflict: false
    };
  } catch {
    return {
      exists: true,
      isolatedFromApplicationDir: isolated,
      markerValid: false,
      deterministicIdentity: false,
      hasUserRepoConflict: true
    };
  }
}

async function inspectImageState(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  expected: {
    digest: string | null;
    baseDigest: string | null;
    codexVersion: string | null;
    contextHash: string;
  }
): Promise<ImageInspection> {
  const statePath = imageStatePath(config);
  if (!(await fsAdapter.exists(statePath))) {
    return {
      hasRecord: false,
      machineMatch: false,
      digestMatch: false,
      buildContextMatch: false,
      codexVersionMatch: false,
      baseDigestMatch: false,
      imageDigest: null,
      imageId: null
    };
  }
  try {
    const raw = await fsAdapter.readText(statePath);
    const parsed = JSON.parse(raw) as ImageStateRecord;
    const machineIdHash = await processAdapter.machineIdHash();
    return {
      hasRecord: true,
      machineMatch: parsed.machine_id_hash === machineIdHash,
      digestMatch: expected.digest !== null && parsed.image_digest === expected.digest,
      buildContextMatch: parsed.build_context_hash === expected.contextHash,
      codexVersionMatch: expected.codexVersion !== null && normalizeVersion(parsed.codex_version) === normalizeVersion(expected.codexVersion),
      baseDigestMatch: expected.baseDigest !== null && parsed.base_image_digest === expected.baseDigest,
      imageDigest: parsed.image_digest,
      imageId: parsed.image_id
    };
  } catch {
    return {
      hasRecord: false,
      machineMatch: false,
      digestMatch: false,
      buildContextMatch: false,
      codexVersionMatch: false,
      baseDigestMatch: false,
      imageDigest: null,
      imageId: null
    };
  }
}

async function observeSnapshot(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<Snapshot> {
  const pathIssues = configPathsForSafety(config)
    .filter((entry) => hasUnsafePathToken(entry.value))
    .map((entry) => entry.label);
  const pathSafety = {
    ok: pathIssues.length === 0,
    invalidPaths: pathIssues
  };

  const lockData = await readVersionLock(fsAdapter, config.version_lock_path);
  const expectedCodexVersion = lockData.lock?.codex.version ?? null;
  const expectedCodexIntegrity = lockData.lock?.codex.integrity ?? null;
  const expectedImageDigest = lockData.lock?.images.agent_image_digest ?? null;
  const expectedBaseDigest = lockData.lock?.images.base_image_platform_digest ?? null;

  const codexBinary = path.join(config.paths.setup_bin_dir, "codex");
  const codexProbe = await probeCodex(fsAdapter, processAdapter, codexBinary, expectedCodexVersion);

  const authDir = await inspectPath(fsAdapter, config.paths.application_auth_dir);
  const stateDir = await inspectPath(fsAdapter, config.paths.application_state_dir);
  const policy = await inspectPolicy(fsAdapter, config);
  const toyFixture = await inspectToyFixture(fsAdapter, config);
  const contextFiles = buildContextFiles(
    expectedBaseDigest ?? "sha256:missing",
    expectedCodexVersion ?? "missing",
    expectedCodexIntegrity ?? "missing"
  );
  const contextHash = buildContextHash(contextFiles);
  const image = await inspectImageState(fsAdapter, processAdapter, config, {
    digest: expectedImageDigest,
    baseDigest: expectedBaseDigest,
    codexVersion: expectedCodexVersion,
    contextHash
  });

  return {
    config,
    versionLock: {
      valid: lockData.lock !== null,
      hash: lockData.hash,
      errors: lockData.errors,
      codexVersion: expectedCodexVersion,
      codexIntegrity: expectedCodexIntegrity,
      agentImageDigest: expectedImageDigest,
      baseImageDigest: expectedBaseDigest
    },
    pathSafety,
    dirs: {
      auth: {
        exists: authDir.exists,
        isDirectory: authDir.isDirectory,
        isSymlink: authDir.isSymlink,
        mode0700: authDir.exists && authDir.isDirectory && authDir.mode === 0o700
      },
      state: {
        exists: stateDir.exists,
        isDirectory: stateDir.isDirectory,
        isSymlink: stateDir.isSymlink,
        mode0700: stateDir.exists && stateDir.isDirectory && stateDir.mode === 0o700
      }
    },
    policy,
    toyFixture,
    codexProbe,
    buildContextHash: contextHash,
    image
  };
}

async function ensurePrivateDir(fsAdapter: FilesystemAdapter, targetPath: string): Promise<void> {
  if (!(await fsAdapter.exists(targetPath))) {
    await fsAdapter.mkdir(targetPath, { recursive: true, mode: 0o700 });
  }
  const stat = await inspectPath(fsAdapter, targetPath);
  if (stat.isSymlink) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s06_private_dir_symlink",
      publicMessage: `Refusing symlink for private directory: ${targetPath}`,
      nextAction: "Replace symlink with a real directory owned by the setup user.",
      stage: "S06",
      evidenceRef: targetPath
    });
  }
  if (!stat.isDirectory || stat.mode !== 0o700) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s06_private_dir_permissions_invalid",
      publicMessage: `Private directory must be mode 0700: ${targetPath}`,
      nextAction: "Fix permissions and ownership, then rerun S06.",
      stage: "S06",
      evidenceRef: targetPath
    });
  }
}

async function writeAtomic(fsAdapter: FilesystemAdapter, targetPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp-${Date.now()}`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

async function ensurePolicyFile(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<void> {
  const targetPath = policyPath(config);
  const proposedPath = `${targetPath}${POLICY_PROPOSED_SUFFIX}`;
  const diffPath = `${targetPath}${POLICY_DIFF_SUFFIX}`;
  const desired = canonicalPolicyText(config);
  const desiredHash = sha256(desired);

  if (!(await fsAdapter.exists(targetPath))) {
    await writeAtomic(fsAdapter, targetPath, desired, 0o600);
    return;
  }

  const stat = await inspectPath(fsAdapter, targetPath);
  if (stat.isSymlink) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s06_policy_symlink_forbidden",
      publicMessage: "Policy file must not be a symlink.",
      nextAction: "Replace policy symlink with a regular file.",
      stage: "S06",
      evidenceRef: targetPath
    });
  }
  if (!stat.isFile) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s06_policy_not_regular_file",
      publicMessage: "Policy path exists but is not a regular file.",
      nextAction: "Move unexpected path aside and rerun S06.",
      stage: "S06",
      evidenceRef: targetPath
    });
  }
  if (stat.mode !== 0o600) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s06_policy_mode_invalid",
      publicMessage: "Policy file must be mode 0600.",
      nextAction: "Fix mode to 0600 and rerun S06.",
      stage: "S06",
      evidenceRef: targetPath
    });
  }

  const current = await fsAdapter.readText(targetPath);
  const currentHash = sha256(current);
  let parsed: ParsedPolicy;
  try {
    parsed = parsePolicyUnknownFields(JSON.parse(current));
  } catch (error) {
    parsed = {
      valid: false,
      hasUnknownFields: false,
      parseError: error instanceof Error ? error.message : "parse_failed",
      unknownFields: []
    };
  }
  if (parsed.parseError !== null) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s06_policy_malformed",
      publicMessage: "Existing policy-level1.json is malformed.",
      nextAction: `Fix ${targetPath} manually, then rerun S06.`,
      stage: "S06",
      evidenceRef: targetPath
    });
  }
  if (parsed.hasUnknownFields) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s06_policy_unknown_fields",
      publicMessage: "Existing policy-level1.json has unknown fields; fail-closed is enforced.",
      nextAction: `Remove unknown fields (${parsed.unknownFields.join(", ")}) and rerun S06.`,
      stage: "S06",
      evidenceRef: targetPath
    });
  }
  if (currentHash !== desiredHash) {
    await writeAtomic(fsAdapter, proposedPath, desired, 0o600);
    await writeAtomic(fsAdapter, diffPath, lineDiff(current, desired), 0o600);
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s06_policy_modified_requires_gate",
      publicMessage: "Existing policy-level1.json was edited by user; installer produced .proposed + diff.",
      nextAction: `Review ${proposedPath} and ${diffPath}, then approve manual gate s06-policy-diff-reviewed before replacing policy.`,
      stage: "S06",
      evidenceRef: diffPath
    });
  }
}

async function ensureToyFixture(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig
): Promise<void> {
  const fixtureDir = toyFixturePath(config);
  const applicationDirResolved = path.resolve(config.paths.application_dir);
  const fixtureResolved = path.resolve(fixtureDir);
  if (fixtureResolved.startsWith(`${applicationDirResolved}${path.sep}`)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s06_toy_fixture_not_isolated",
      publicMessage: "Toy fixture must be outside application directory.",
      nextAction: "Set paths.application_work_dir outside application_dir and rerun S06.",
      stage: "S06",
      evidenceRef: fixtureDir
    });
  }

  const fixtureExists = await fsAdapter.exists(fixtureDir);
  if (fixtureExists && !(await fsAdapter.exists(path.join(fixtureDir, TOY_MARKER_FILENAME)))) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s06_toy_fixture_conflict",
      publicMessage: "Toy fixture directory exists without installer marker; possible user repo.",
      nextAction: `Move ${fixtureDir} aside manually or provide dedicated application_work_dir.`,
      stage: "S06",
      evidenceRef: fixtureDir
    });
  }

  await fsAdapter.mkdir(fixtureDir, { recursive: true, mode: 0o700 });
  const files = canonicalToyFiles();
  for (const [name, content] of Object.entries(files)) {
    await writeAtomic(fsAdapter, path.join(fixtureDir, name), content, 0o600);
  }
  const fixtureHash = sha256(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, content]) => `${name}:${sha256(content)}`)
      .join("|")
  );
  await writeAtomic(
    fsAdapter,
    path.join(fixtureDir, TOY_MARKER_FILENAME),
    `${JSON.stringify({
      schema_version: 1,
      fixture_hash: fixtureHash,
      deterministic_identity: true
    }, null, 2)}\n`,
    0o600
  );

  const run = async (args: string[], env?: Record<string, string>): Promise<void> => {
    const command = {
      binary: "/usr/bin/git",
      args: ["-C", fixtureDir, ...args],
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES
    };
    const result = await processAdapter.runCommand(
      env === undefined
        ? command
        : {
            ...command,
            env
          }
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s06_toy_fixture_git_failed",
        publicMessage: `Toy fixture git command failed: git ${args.join(" ")}`,
        nextAction: "Check git availability and fixture directory permissions.",
        stage: "S06",
        evidenceRef: result.stderr.slice(0, 512)
      });
    }
  };

  if (!(await fsAdapter.exists(path.join(fixtureDir, ".git")))) {
    await run(["init", "-q"]);
    await run(["config", "user.name", "agent-factory-fixture"]);
    await run(["config", "user.email", "fixture@agent-factory.invalid"]);
  }
  await run(["add", "."]);
  await run(
    ["commit", "-q", "--allow-empty", "-m", "Initialize deterministic toy fixture"],
    {
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z"
    }
  );
}

async function ensureBuildContext(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  files: Record<string, string>
): Promise<string> {
  const hash = buildContextHash(files);
  const contextDir = path.join(config.paths.setup_cache_dir, "s06-agent-image-context", hash);
  await fsAdapter.mkdir(contextDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    await writeAtomic(fsAdapter, path.join(contextDir, name), content, 0o600);
  }
  return contextDir;
}

async function buildPinnedAgentImage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter,
  config: SetupConfig,
  lockData: {
    codexVersion: string;
    codexIntegrity: string;
    baseImageDigest: string;
    agentImageDigest: string;
  },
  contextHash: string,
  contextDir: string
): Promise<ImageStateRecord> {
  const tag = `agent-factory-s06:${config.installation_id.slice(0, 12)}`;
  const buildResult = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: [
      "build",
      "--pull=false",
      "--file",
      path.join(contextDir, "Dockerfile"),
      "--build-arg",
      `CODEX_VERSION=${lockData.codexVersion}`,
      "--build-arg",
      `CODEX_INTEGRITY=${lockData.codexIntegrity}`,
      "--label",
      `agent-factory.installation-id=${config.installation_id}`,
      "--label",
      `agent-factory.expected-digest=${lockData.agentImageDigest}`,
      "--tag",
      tag,
      contextDir
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  if (buildResult.exitCode !== 0 || buildResult.timedOut) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "s06_agent_image_build_failed",
      publicMessage: "Pinned S06 agent image build failed.",
      nextAction: "Inspect docker daemon health and rerun S06 on supported host.",
      stage: "S06",
      evidenceRef: buildResult.stderr.slice(0, 512)
    });
  }

  const digestResult = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: ["image", "inspect", "--format", "{{join .RepoDigests \",\"}}", tag],
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  const idResult = await processAdapter.runCommand({
    binary: "/usr/bin/docker",
    args: ["image", "inspect", "--format", "{{.Id}}", tag],
    timeoutMs: OBSERVE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  });
  if (digestResult.exitCode !== 0 || idResult.exitCode !== 0) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "s06_agent_image_inspect_failed",
      publicMessage: "Built image cannot be inspected for digest/id.",
      nextAction: "Inspect docker image store and rerun S06.",
      stage: "S06",
      evidenceRef: `${digestResult.stderr.slice(0, 256)};${idResult.stderr.slice(0, 256)}`
    });
  }

  const digestMatch = digestResult.stdout.match(/sha256:[0-9a-f]{64}/);
  const imageDigest = digestMatch?.[0] ?? "";
  const imageId = idResult.stdout.trim();
  if (imageDigest !== lockData.agentImageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s06_agent_image_pin_mismatch",
      publicMessage: "Built image digest/id does not match reviewed pinning constraints.",
      nextAction: "Rebuild from reviewed Dockerfile/release lock or update lock with owner-reviewed artifact.",
      stage: "S06",
      evidenceRef: `observed_digest=${imageDigest};expected_digest=${lockData.agentImageDigest}`
    });
  }

  const record: ImageStateRecord = {
    schema_version: 1,
    machine_id_hash: await processAdapter.machineIdHash(),
    image_digest: imageDigest,
    image_id: imageId,
    build_context_hash: contextHash,
    codex_version: lockData.codexVersion,
    base_image_digest: lockData.baseImageDigest,
    built_at: new Date().toISOString()
  };
  await writeAtomic(fsAdapter, imageStatePath(config), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}

function assertSnapshotReadyForApply(snapshot: Snapshot): void {
  if (!snapshot.pathSafety.ok) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s06_path_unsupported",
      publicMessage: `Unsupported path values detected: ${snapshot.pathSafety.invalidPaths.join(", ")}`,
      nextAction: "Use absolute paths without newline/comma characters and rerun plan/apply.",
      stage: "S06"
    });
  }
  if (!snapshot.versionLock.valid) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s06_version_lock_invalid",
      publicMessage: "versions.lock.json is missing or invalid for S06 pinned image/config flow.",
      nextAction: "Provide reviewed versions.lock.json with codex and image pins.",
      stage: "S06",
      evidenceRef: snapshot.versionLock.errors.join(";")
    });
  }
  if (!snapshot.codexProbe.binaryExists || !snapshot.codexProbe.versionMatch || !snapshot.codexProbe.execHelpOk || !snapshot.codexProbe.loginHelpOk) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s06_codex_probe_failed",
      publicMessage: "Codex CLI capability probes failed (--version/exec --help/login --help).",
      nextAction: "Install pinned codex CLI in setup_bin_dir and rerun S06.",
      stage: "S06"
    });
  }
  if (snapshot.toyFixture.hasUserRepoConflict) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s06_toy_fixture_user_repo_conflict",
      publicMessage: "Toy fixture path conflicts with user repository content.",
      nextAction: "Move conflicting repository aside or set isolated application_work_dir.",
      stage: "S06"
    });
  }
  if (!snapshot.toyFixture.isolatedFromApplicationDir) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s06_toy_fixture_not_isolated",
      publicMessage: "Toy fixture path is inside application repository.",
      nextAction: "Move fixture outside application_dir and rerun S06.",
      stage: "S06"
    });
  }
}

export function createConfigurationStage(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): StageModule {
  return {
    id: "S06",
    dependencies: ["S05"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-readonly"],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const snapshot = await observeSnapshot(fsAdapter, processAdapter, ctx.config);
      return {
        stageId: "S06",
        status: inferStatus(snapshot),
        checks: checksFromSnapshot(snapshot),
        versions: versionsFromSnapshot(snapshot),
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;

      const codexVersion = observed.versions.s06_expected_codex_version ?? "pending";
      const codexIntegrity = "pending";
      const baseImageDigest = observed.versions.s06_expected_base_image_digest ?? "pending";
      const agentImageDigest = observed.versions.s06_expected_agent_image_digest ?? "pending";
      const lockHash = observed.versions.s06_version_lock_hash ?? "pending";
      const contextHash = observed.versions.s06_build_context_hash ?? "pending";

      const operations: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s06-config-image-${config.installation_id.slice(0, 12)}`,
              stageId: "S06",
              action: "configuration.prepare" as const,
              kind: "mutate",
              resourceId: "configuration-and-pinned-image",
              risk: "high",
              gateIds: ["s06-config-image-reviewed"],
              preconditions: [
                `s06_version_lock_hash:${lockHash}`,
                `s06_build_context_hash:${contextHash}`,
                `s06_codex_version:${codexVersion}`,
                `s06_codex_integrity:${codexIntegrity}`,
                `s06_base_image_digest:${baseImageDigest}`,
                `s06_agent_image_digest:${agentImageDigest}`
              ],
              sideEffects: [
                "create private auth/state dirs with strict permissions",
                "materialize deterministic toy fixture",
                "build pinned agent image from immutable context"
              ],
              timeoutSec: 300,
              retryable: false
            }
          ];
      return {
        stageId: "S06",
        optional: false,
        requiredCapabilities: ["runner-readonly"],
        operations,
        requiredGates: operations.length === 0 ? [] : ["s06-config-image-reviewed"]
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (approvedPlan.operations.length === 0) {
        return this.verify(ctx);
      }
      const config = ctx.config;
      const snapshot = await observeSnapshot(fsAdapter, processAdapter, config);
      assertSnapshotReadyForApply(snapshot);
      const preconditions = parsePlanPreconditions(approvedPlan);

      const lockHashMismatch = preconditions.versionLockHash !== "pending" && snapshot.versionLock.hash !== preconditions.versionLockHash;
      const contextHashMismatch = preconditions.buildContextHash !== "pending" && snapshot.buildContextHash !== preconditions.buildContextHash;
      const codexVersionMismatch = preconditions.codexVersion !== "pending" && snapshot.versionLock.codexVersion !== preconditions.codexVersion;
      const baseDigestMismatch = preconditions.baseImageDigest !== "pending" && snapshot.versionLock.baseImageDigest !== preconditions.baseImageDigest;
      const imageDigestMismatch = preconditions.agentImageDigest !== "pending" && snapshot.versionLock.agentImageDigest !== preconditions.agentImageDigest;
      if (lockHashMismatch || contextHashMismatch || codexVersionMismatch || baseDigestMismatch || imageDigestMismatch) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s06_plan_drifted",
          publicMessage: "S06 plan preconditions drifted from current observed pins/context.",
          nextAction: "Regenerate S06 plan and re-approve gates.",
          stage: "S06"
        });
      }

      const codexIntegrity = snapshot.versionLock.codexIntegrity;
      if (codexIntegrity === null || codexIntegrity.length === 0) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s06_codex_integrity_missing",
          publicMessage: "Pinned codex integrity is missing from versions lock.",
          nextAction: "Provide reviewed versions.lock.json with codex.integrity.",
          stage: "S06"
        });
      }

      await ensurePrivateDir(fsAdapter, config.paths.application_auth_dir);
      await ensurePrivateDir(fsAdapter, config.paths.application_state_dir);
      await ensurePolicyFile(fsAdapter, config);
      await ensureToyFixture(fsAdapter, processAdapter, config);

      const effectiveBaseImageDigest = snapshot.versionLock.baseImageDigest ?? preconditions.baseImageDigest;
      const effectiveCodexVersion = snapshot.codexProbe.versionRaw
        ?? snapshot.versionLock.codexVersion
        ?? preconditions.codexVersion;
      const effectiveAgentImageDigest = snapshot.versionLock.agentImageDigest ?? preconditions.agentImageDigest;
      if (
        effectiveBaseImageDigest === "pending"
        || effectiveCodexVersion === "pending"
        || effectiveAgentImageDigest === "pending"
      ) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s06_version_lock_pins_missing",
          publicMessage: "S06 pinned image values are unavailable.",
          nextAction: "Provide reviewed versions.lock.json with codex/image pins and rerun plan/apply.",
          stage: "S06"
        });
      }

      const contextFiles = buildContextFiles(
        effectiveBaseImageDigest,
        effectiveCodexVersion,
        codexIntegrity
      );
      const contextDir = await ensureBuildContext(fsAdapter, config, contextFiles);
      const currentImage = await inspectImageState(fsAdapter, processAdapter, config, {
        digest: effectiveAgentImageDigest,
        baseDigest: effectiveBaseImageDigest,
        codexVersion: effectiveCodexVersion,
        contextHash: snapshot.buildContextHash
      });

      let record: ImageStateRecord | null = null;
      const imageUsableOnCurrentHost = currentImage.hasRecord && currentImage.digestMatch && currentImage.machineMatch;
      if (!imageUsableOnCurrentHost) {
        record = await buildPinnedAgentImage(
          fsAdapter,
          processAdapter,
          config,
          {
            codexVersion: effectiveCodexVersion,
            codexIntegrity,
            baseImageDigest: effectiveBaseImageDigest,
            agentImageDigest: effectiveAgentImageDigest
          },
          snapshot.buildContextHash,
          contextDir
        );
      }

      const operationId = approvedPlan.operations[0]?.id ?? `s06-apply-${ctx.installationId}`;
      return [
        {
          operationId,
          stageId: "S06",
          resourceId: "configuration-and-pinned-image",
          observedAt: new Date().toISOString(),
          checks: {
            auth_dir_0700: true,
            state_dir_0700: true,
            policy_level1_canonical: true,
            toy_fixture_ready: true,
            codex_probe_passed: true,
            image_built: record !== null
          },
          versions: {
            codex_version: effectiveCodexVersion,
            agent_image_digest: effectiveAgentImageDigest,
            local_image_id: record?.image_id ?? currentImage.imageId ?? "absent",
            build_context_hash: snapshot.buildContextHash
          },
          artifacts: [
            policyPath(config),
            toyFixturePath(config),
            imageStatePath(config)
          ]
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const snapshot = await observeSnapshot(fsAdapter, processAdapter, ctx.config);
      assertSnapshotReadyForApply(snapshot);
      if (inferStatus(snapshot) !== "verified") {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s06_not_verified",
          publicMessage: "S06 resources are not fully verified.",
          nextAction: "Run plan/apply for S06 and resolve manual drift if present.",
          stage: "S06"
        });
      }
      return [
        {
          operationId: "s06-verify",
          stageId: "S06",
          resourceId: "configuration-and-pinned-image",
          observedAt: new Date().toISOString(),
          checks: checksFromSnapshot(snapshot),
          versions: versionsFromSnapshot(snapshot),
          artifacts: [policyPath(ctx.config), toyFixturePath(ctx.config), imageStatePath(ctx.config)]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
