import { createHash } from "node:crypto";
import path from "node:path";
import { cp } from "node:fs/promises";
import { type FilesystemAdapter } from "./filesystem";
import { type ProcessAdapter } from "./process";
import { setupError } from "../core/errors";
import { ExitCode, type SetupConfig } from "../core/types";
import { validateContractSchema } from "../core/validators";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface ExistingCheckoutObservation {
  exists: boolean;
  hasGitDir: boolean;
  dirty: boolean;
  detachedHead: boolean;
  branch: string | null;
  headCommit: string | null;
  originUrl: string | null;
  hasDeploymentManifest: boolean;
  deployedSourceCommit: string | null;
}

export interface ApplicationManifestData {
  schema_version: 1;
  application_version: string;
  source_commit: string;
  content_hashes: Record<string, string>;
  node_range: string;
  capabilities: string[];
  commands: Record<string, string[]>;
  config_schema_version: number;
  state_schema_version: number;
  migrations: { from: number; to: number };
  security_evidence_refs: string[];
}

export interface ReleaseInspection {
  archiveExists: boolean;
  archiveSha256: string | null;
  sha256Matches: boolean;
  entryCount: number;
  traversalEntries: string[];
  symlinkEntries: string[];
  specialEntries: string[];
  hasDockerfile: boolean;
  hasBuildContext: boolean;
  manifestPath: string | null;
  manifest: ApplicationManifestData | null;
  manifestValid: boolean;
  manifestErrors: string[];
}

export interface ProbeResult {
  runnerVerifyHelpOk: boolean;
  runnerStopHelpOk: boolean;
  details: string[];
}

export interface ReadOnlyFetchRequest {
  repoUrl: string;
  sourceCommit: string;
  targetDir: string;
}

export interface ApplicationReleaseAdapter {
  observeExistingCheckout(config: SetupConfig): Promise<ExistingCheckoutObservation>;
  inspectArchive(config: SetupConfig): Promise<ReleaseInspection>;
  extractArchive(config: SetupConfig, targetDir: string): Promise<void>;
  verifyContentHashes(rootDir: string, expected: Record<string, string>): Promise<string[]>;
  materializeRelease(rootDir: string, targetDir: string): Promise<void>;
  probeCommands(rootDir: string, manifest: ApplicationManifestData, config: SetupConfig): Promise<ProbeResult>;
  commitExists(repoDir: string, commit: string): Promise<boolean>;
  fetchReadOnly(_request: ReadOnlyFetchRequest): Promise<void>;
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizePath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (normalized === ".") {
    return "";
  }
  return normalized.replace(/^\/+/, "");
}

function parseSha256sum(stdout: string): string | null {
  const token = stdout.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) {
    return null;
  }
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function isTraversalPath(rawPath: string): boolean {
  if (rawPath.startsWith("/")) {
    return true;
  }
  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === "..") {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

function isHex(value: string, length: number): boolean {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function assertSafeCommit(value: string): void {
  if (!isHex(value, 40)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s05_source_commit_invalid",
      publicMessage: `Source commit must be a lowercase 40-char sha1, got '${value}'.`,
      nextAction: "Fix release.source_commit in config and regenerate plan.",
      stage: "S05"
    });
  }
}

function parseVerboseTarLine(rawLine: string): { type: string; entryPath: string } | null {
  const line = rawLine.trimEnd();
  if (line.length === 0) {
    return null;
  }
  const type = line[0] ?? "";
  const dateMatch = line.match(/\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s/);
  if (dateMatch?.index === undefined) {
    return null;
  }
  const start = dateMatch.index + dateMatch[0].length;
  const remainder = line.slice(start);
  const linkIndex = remainder.indexOf(" -> ");
  const entryPath = linkIndex === -1 ? remainder : remainder.slice(0, linkIndex);
  return {
    type,
    entryPath: entryPath.trim()
  };
}

function supportsCommand(manifest: ApplicationManifestData, commandKey: string): string[] | null {
  const command = manifest.commands[commandKey];
  if (!Array.isArray(command) || command.length === 0) {
    return null;
  }
  return command;
}

function resolveBinary(binary: string, config: SetupConfig, rootDir: string): string {
  if (binary === "node") {
    return path.join(config.paths.setup_node_dir, "bin", "node");
  }
  if (binary.startsWith("/")) {
    return binary;
  }
  if (binary.includes("/")) {
    return path.join(rootDir, binary);
  }
  throw setupError({
    exitCode: ExitCode.SecurityBoundaryViolation,
    code: "s05_untrusted_command_binary",
    publicMessage: `Release command '${binary}' is not allowed.`,
    nextAction: "Use absolute binaries or node-based argv in deployment-manifest.json.",
    stage: "S05"
  });
}

function resolveCommandArgs(args: string[], rootDir: string): string[] {
  if (args.length === 0) {
    return [];
  }
  return args.map((value, index) => {
    if (index === 0 && (value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".ts"))) {
      return path.join(rootDir, value);
    }
    return value;
  });
}

function canonicalContentPath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

/** Executable entries must be covered by the reviewed deployment content map. */
export function assertOfflineCommands(manifest: ApplicationManifestData, config: SetupConfig): void {
  for (const key of ["runner_verify", "runner_stop"]) {
    const argv = manifest.commands[key];
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== "string" || value.includes("\0"))) {
      throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence, code: "s05_required_command_missing",
        publicMessage: "A mandatory offline command is missing.", nextAction: "Provide a reviewed release with both required commands.", stage: "S05" });
    }
    const binary = argv[0]!;
    const entry = binary === "node" || binary === path.join(config.paths.setup_node_dir, "bin", "node") ? argv[1] : binary;
    if (entry === undefined || !canonicalContentPath(entry) || !Object.hasOwn(manifest.content_hashes, entry)) {
      throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code: "s05_command_content_unbound",
        publicMessage: "Offline command entry is outside the reviewed deployment content map.", nextAction: "Bind a confined executable or Node entry file to reviewed content hashes; sudo/external executables are forbidden.", stage: "S05" });
    }
  }
}

export class NodeApplicationReleaseAdapter implements ApplicationReleaseAdapter {
  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly fsAdapter: FilesystemAdapter
  ) {}

  private async run(binary: string, args: string[], timeoutMs: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    return this.processAdapter.runCommand({
      binary,
      args,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
  }

  private async git(args: string[], cwd: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    return this.run("/usr/bin/git", ["-C", cwd, ...args], OBSERVE_TIMEOUT_MS);
  }

  async observeExistingCheckout(config: SetupConfig): Promise<ExistingCheckoutObservation> {
    const checkoutPath = config.paths.application_dir;
    const checkoutExists = await this.fsAdapter.exists(checkoutPath);
    if (!checkoutExists) {
      return {
        exists: false,
        hasGitDir: false,
        dirty: false,
        detachedHead: false,
        branch: null,
        headCommit: null,
        originUrl: null,
        hasDeploymentManifest: false,
        deployedSourceCommit: null
      };
    }

    const gitDirPath = path.join(checkoutPath, ".git");
    const hasGitDir = await this.fsAdapter.exists(gitDirPath);
    const manifestPath = path.join(checkoutPath, "deployment-manifest.json");

    let deployedSourceCommit: string | null = null;
    let hasDeploymentManifest = false;
    if (await this.fsAdapter.exists(manifestPath)) {
      hasDeploymentManifest = true;
      try {
        const parsed = JSON.parse(await this.fsAdapter.readText(manifestPath)) as { source_commit?: unknown };
        if (typeof parsed.source_commit === "string" && isHex(parsed.source_commit, 40)) {
          deployedSourceCommit = parsed.source_commit;
        }
      } catch {
        deployedSourceCommit = null;
      }
    }

    if (!hasGitDir) {
      return {
        exists: true,
        hasGitDir: false,
        dirty: false,
        detachedHead: false,
        branch: null,
        headCommit: null,
        originUrl: null,
        hasDeploymentManifest,
        deployedSourceCommit
      };
    }

    const status = await this.git(["status", "--porcelain"], checkoutPath);
    const dirty = status.stdout.trim().length > 0;

    const branchResult = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], checkoutPath);
    const branchRaw = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    const detachedHead = branchRaw === "HEAD";
    const branch = branchRaw.length > 0 ? branchRaw : null;

    const headCommitResult = await this.git(["rev-parse", "HEAD"], checkoutPath);
    const headCommitCandidate = headCommitResult.exitCode === 0 ? headCommitResult.stdout.trim() : "";
    const headCommit = isHex(headCommitCandidate, 40) ? headCommitCandidate : null;

    const remoteResult = await this.git(["remote", "get-url", "origin"], checkoutPath);
    const originUrlCandidate = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : "";
    const originUrl = originUrlCandidate.length > 0 ? originUrlCandidate : null;

    return {
      exists: true,
      hasGitDir: true,
      dirty,
      detachedHead,
      branch,
      headCommit,
      originUrl,
      hasDeploymentManifest,
      deployedSourceCommit
    };
  }

  async inspectArchive(config: SetupConfig): Promise<ReleaseInspection> {
    const archivePath = config.release.archive_path;
    if (!(await this.fsAdapter.exists(archivePath))) {
      return {
        archiveExists: false,
        archiveSha256: null,
        sha256Matches: false,
        entryCount: 0,
        traversalEntries: [],
        symlinkEntries: [],
        specialEntries: [],
        hasDockerfile: false,
        hasBuildContext: false,
        manifestPath: null,
        manifest: null,
        manifestValid: false,
        manifestErrors: ["archive_missing"]
      };
    }

    const archiveHashResult = await this.run("/usr/bin/sha256sum", [archivePath], OBSERVE_TIMEOUT_MS);
    if (archiveHashResult.exitCode !== 0 || archiveHashResult.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s05_archive_hash_failed",
        publicMessage: "Failed to compute release archive sha256.",
        nextAction: "Verify archive accessibility and retry.",
        stage: "S05",
        evidenceRef: archiveHashResult.stderr.slice(0, 512)
      });
    }
    const archiveSha256 = parseSha256sum(archiveHashResult.stdout);
    if (archiveSha256 === null) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s05_archive_hash_invalid",
        publicMessage: "Release archive hash output is invalid.",
        nextAction: "Check host sha256sum binary and rerun.",
        stage: "S05"
      });
    }

    const listNames = await this.run("/usr/bin/tar", ["-tf", archivePath], OBSERVE_TIMEOUT_MS);
    if (listNames.exitCode !== 0 || listNames.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s05_archive_list_failed",
        publicMessage: "Failed to inspect release archive entries.",
        nextAction: "Provide an owner-exported tar archive readable by this host.",
        stage: "S05",
        evidenceRef: listNames.stderr.slice(0, 512)
      });
    }

    const listVerbose = await this.run(
      "/usr/bin/tar",
      ["--full-time", "-tvf", archivePath],
      OBSERVE_TIMEOUT_MS
    );
    if (listVerbose.exitCode !== 0 || listVerbose.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s05_archive_verbose_list_failed",
        publicMessage: "Failed to inspect release archive entry types.",
        nextAction: "Provide an owner-exported tar archive with standard headers.",
        stage: "S05",
        evidenceRef: listVerbose.stderr.slice(0, 512)
      });
    }

    const entries = listNames.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const traversalEntries = entries.filter((entry) => isTraversalPath(entry));
    const safeEntries = entries.map((entry) => sanitizePath(entry));
    const hasDockerfile = safeEntries.some((entry) => path.posix.basename(entry).toLowerCase() === "dockerfile");
    const hasBuildContext = safeEntries.some((entry) => path.posix.basename(entry) === "package.json");

    const symlinkEntries: string[] = [];
    const specialEntries: string[] = [];
    for (const line of listVerbose.stdout.split("\n")) {
      const parsed = parseVerboseTarLine(line);
      if (parsed === null) {
        continue;
      }
      if (parsed.type === "l" || parsed.type === "h") {
        symlinkEntries.push(parsed.entryPath);
      } else if (!["-", "d"].includes(parsed.type)) {
        specialEntries.push(parsed.entryPath);
      }
    }

    const manifestEntry = safeEntries.find((entry) => path.posix.basename(entry) === "deployment-manifest.json") ?? null;
    let manifest: ApplicationManifestData | null = null;
    let manifestValid = false;
    let manifestErrors: string[] = [];
    if (manifestEntry !== null) {
      const manifestRead = await this.run("/usr/bin/tar", ["-xOf", archivePath, manifestEntry], OBSERVE_TIMEOUT_MS);
      if (manifestRead.exitCode === 0 && !manifestRead.timedOut) {
        try {
          const parsed = JSON.parse(manifestRead.stdout) as ApplicationManifestData;
          const validation = validateContractSchema("application-manifest", parsed);
          manifest = parsed;
          manifestValid = validation.ok;
          manifestErrors = validation.errors;
        } catch (error) {
          manifestValid = false;
          manifestErrors = [error instanceof Error ? error.message : "manifest_parse_failed"];
        }
      } else {
        manifestErrors = ["manifest_read_failed"];
      }
    } else {
      manifestErrors = ["manifest_missing"];
    }

    return {
      archiveExists: true,
      archiveSha256,
      sha256Matches: archiveSha256 === config.release.sha256,
      entryCount: entries.length,
      traversalEntries,
      symlinkEntries,
      specialEntries,
      hasDockerfile,
      hasBuildContext,
      manifestPath: manifestEntry,
      manifest,
      manifestValid,
      manifestErrors
    };
  }

  async extractArchive(config: SetupConfig, targetDir: string): Promise<void> {
    await this.fsAdapter.mkdir(targetDir, { recursive: true, mode: 0o700 });
    const result = await this.run(
      "/usr/bin/tar",
      [
        "-xpf",
        config.release.archive_path,
        "-C",
        targetDir,
        "--no-same-owner",
        "--no-same-permissions",
        "--numeric-owner"
      ],
      MUTATION_TIMEOUT_MS
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s05_archive_extract_failed",
        publicMessage: "Failed to extract release archive.",
        nextAction: "Verify archive format and host disk capacity, then retry.",
        stage: "S05",
        evidenceRef: result.stderr.slice(0, 512)
      });
    }
  }

  async verifyContentHashes(rootDir: string, expected: Record<string, string>): Promise<string[]> {
    const mismatches: string[] = [];
    let root: Awaited<ReturnType<FilesystemAdapter["lstat"]>>;
    try { root = await this.fsAdapter.lstat(rootDir); }
    catch { return ["deployment-root:metadata-read-failed"]; }
    if (root.isSymbolicLink() || !root.isDirectory() || Number(root.uid) !== this.processAdapter.uid() || (Number(root.mode) & 0o022) !== 0) return ["deployment-root:unsafe-ownership-or-type"];
    for (const [relativePath, expectedHash] of Object.entries(expected)) {
      if (!canonicalContentPath(relativePath) || !/^[0-9a-f]{64}$/.test(expectedHash)) { mismatches.push(`${relativePath}:unsafe-path-or-pin`); continue; }
      const parts = relativePath.split("/"); let current = rootDir, safe = true;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]!);
        try {
          const stat = await this.fsAdapter.lstat(current);
          if (stat.isSymbolicLink() || Number(stat.uid) !== Number(root.uid) || (Number(stat.mode) & 0o022) !== 0
            || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) { safe = false; break; }
        } catch { safe = false; break; }
      }
      if (!safe) { mismatches.push(`${relativePath}:missing-unreadable-or-unsafe`); continue; }
      const hashResult = await this.run("/usr/bin/sha256sum", [current], OBSERVE_TIMEOUT_MS);
      if (hashResult.exitCode !== 0 || hashResult.timedOut) { mismatches.push(`${relativePath}:hash-read-failed`); continue; }
      const actual = parseSha256sum(hashResult.stdout);
      if (actual === null || actual !== expectedHash) mismatches.push(`${relativePath}:hash-mismatch`);
    }
    return mismatches;
  }

  async materializeRelease(rootDir: string, targetDir: string): Promise<void> {
    await cp(rootDir, targetDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false
    });
  }

  async probeCommands(rootDir: string, manifest: ApplicationManifestData, config: SetupConfig): Promise<ProbeResult> {
    assertOfflineCommands(manifest, config);
    const details: string[] = [];
    const verifyArgv = supportsCommand(manifest, "runner_verify");
    const stopArgv = supportsCommand(manifest, "runner_stop");
    if (verifyArgv === null || stopArgv === null) {
      return {
        runnerVerifyHelpOk: false,
        runnerStopHelpOk: false,
        details: ["missing_required_commands"]
      };
    }

    const runHelp = async (argv: string[], commandName: string): Promise<boolean> => {
      const [binaryRaw, ...argsRaw] = argv;
      if (binaryRaw === undefined) {
        details.push(`${commandName}:empty`);
        return false;
      }
      const mismatches = await this.verifyContentHashes(rootDir, manifest.content_hashes);
      if (mismatches.length > 0) throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code: "s05_deployed_integrity_failed",
        publicMessage: "Current deployment integrity failed before offline command invocation.", nextAction: "Restore reviewed deployment bytes before any executable probe.", stage: "S05", evidenceRef: rootDir });
      const binary = resolveBinary(binaryRaw, config, rootDir);
      const args = [...resolveCommandArgs(argsRaw, rootDir), "--help"];
      const result = await this.run(binary, args, OBSERVE_TIMEOUT_MS);
      details.push(`${commandName}:exit=${result.exitCode}:timeout=${result.timedOut}`);
      return result.exitCode === 0 && !result.timedOut;
    };

    const runnerVerifyHelpOk = await runHelp(verifyArgv, "runner_verify");
    const runnerStopHelpOk = await runHelp(stopArgv, "runner_stop");
    return {
      runnerVerifyHelpOk,
      runnerStopHelpOk,
      details
    };
  }

  async commitExists(repoDir: string, commit: string): Promise<boolean> {
    assertSafeCommit(commit);
    const result = await this.git(["cat-file", "-e", `${commit}^{commit}`], repoDir);
    return result.exitCode === 0 && !result.timedOut;
  }

  async fetchReadOnly(_request: ReadOnlyFetchRequest): Promise<void> {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s05_readonly_fetch_not_enabled",
      publicMessage: "Read-only private Git fetch adapter is not enabled in this installer build.",
      nextAction: "Provide an owner-exported archive or extend the release with reviewed read-only credentials.",
      stage: "S05"
    });
  }
}

export function createNodeApplicationReleaseAdapter(
  processAdapter: ProcessAdapter,
  fsAdapter: FilesystemAdapter
): ApplicationReleaseAdapter {
  return new NodeApplicationReleaseAdapter(processAdapter, fsAdapter);
}
