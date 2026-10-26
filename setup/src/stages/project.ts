import { createHash } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type CommandResult, type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import {
  ExitCode,
  type SetupConfig,
  type StageContext,
  type StageModule,
  type StageObservation,
  type StagePlan,
  type StageReceipt
} from "../core/types";

const DEFAULT_TARGET_REPOSITORY = "se-panfilov/anarchy-engine";
const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const BASELINE_UNKNOWN = "unknown";

const INVENTORY_FILENAME = "s09-target-inventory.json";
const PROPOSAL_METADATA_FILENAME = "s09-proposal-metadata.json";
const BASELINE_EVIDENCE_FILENAME = "s09-baseline-evidence.json";
const OWNER_NOTE_FILENAME = "s09-owner-note.json";
const COLLECTOR_EVIDENCE_FILENAME = "s09-collector-evidence.json";
const RECEIPT_FILENAME = "s09-project-receipt.json";

const FACTORY_BASELINE_TEMPLATE = [
  "name: factory-baseline",
  "",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      target_sha:",
  "        description: \"Target checkout SHA (must match planned S09 SHA)\"",
  "        required: true",
  "        default: \"{{TARGET_SHA}}\"",
  "",
  "permissions:",
  "  contents: read",
  "  actions: read",
  "",
  "jobs:",
  "  baseline:",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 20",
  "    steps:",
  "      - name: Checkout at pinned SHA",
  "        uses: actions/checkout@0ad4b8fadaa221de15dcec353f45205ec38ea70b",
  "        with:",
  "          repository: {{TARGET_REPOSITORY}}",
  "          ref: ${{ inputs.target_sha }}",
  "          fetch-depth: 1",
  "          persist-credentials: false",
  "      - name: Confirm exact SHA binding",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          actual_sha=\"$(git rev-parse HEAD)\"",
  "          test \"$actual_sha\" = \"${{ inputs.target_sha }}\"",
  "          echo \"verified_sha=$actual_sha\" >> \"$GITHUB_OUTPUT\"",
  "      - name: Upload checkout evidence",
  "        uses: actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808",
  "        with:",
  "          name: checkout-evidence",
  "          path: |",
  "            .nvmrc",
  "            package.json",
  "            package-lock.json",
  "            .github/workflows",
  "            AGENTS.md",
  ""
].join("\n");

const DEPENDABOT_TEMPLATE = [
  "version: 2",
  "updates:",
  "  - package-ecosystem: \"github-actions\"",
  "    directory: \"/\"",
  "    schedule:",
  "      interval: \"weekly\"",
  "    open-pull-requests-limit: 5",
  "    labels:",
  "      - \"dependencies\"",
  "      - \"github-actions\"",
  "  - package-ecosystem: \"npm\"",
  "    directory: \"/\"",
  "    schedule:",
  "      interval: \"weekly\"",
  "    open-pull-requests-limit: 10",
  "    labels:",
  "      - \"dependencies\"",
  "      - \"npm\"",
  ""
].join("\n");

interface CheckoutObservation {
  exists: boolean;
  gitDirExists: boolean;
  detachedHead: boolean;
  headSha: string | null;
  dirty: boolean;
  originUrl: string | null;
}

interface InventoryData {
  schema_version: 1;
  repository: string;
  target_sha: string;
  observed_at: string;
  node_version: string | null;
  package_manager_lock: "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "none";
  package_lock_sha256: string | null;
  workspace_packages: string[];
  agents_md_present: boolean;
  workflows: Array<{ path: string; sha256: string }>;
  playwright_config_paths: string[];
}

interface BaselineEvidence {
  schema_version: 1;
  repository: string;
  target_sha: string;
  owner_note_present: boolean;
  collector_evidence_present: boolean;
  collector_evidence_verified: boolean;
  ci_status: "passed" | "failed" | "draft" | "skipped" | "missing";
  ci_result: "pass" | "fail" | "unknown";
  observed_at: string;
}

interface CheckerResult {
  supported: boolean;
  status: "verified" | "blocked" | "unknown";
  details: string;
}

export interface ProjectStageAdapter {
  observeCheckout(checkoutDir: string): Promise<CheckoutObservation>;
  fetchDetachedCheckout(input: { repository: string; targetSha: string; checkoutDir: string }): Promise<void>;
  runChecker(input: { checkerDir: string; inventoryPath: string }): Promise<CheckerResult>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isValidSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function ensureJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function writeAtomic(fsAdapter: FilesystemAdapter, targetPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

function targetRepository(config: SetupConfig): string {
  if (config.github.repository_allowlist.length === 0) {
    return DEFAULT_TARGET_REPOSITORY;
  }
  return config.github.repository_allowlist[0] ?? DEFAULT_TARGET_REPOSITORY;
}

function ensureRepositoryAllowed(config: SetupConfig, repository: string): void {
  if (config.github.repository_allowlist.length === 0) {
    if (repository !== DEFAULT_TARGET_REPOSITORY) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s09_target_repository_not_allowed",
        publicMessage: `Repository '${repository}' is outside allowlist and cannot be processed.`,
        nextAction: "Add the target repository to github.repository_allowlist and regenerate plan.",
        stage: "S09"
      });
    }
    return;
  }
  if (!config.github.repository_allowlist.includes(repository)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s09_target_repository_not_allowed",
      publicMessage: `Repository '${repository}' is outside allowlist and cannot be processed.`,
      nextAction: "Add the target repository to github.repository_allowlist and regenerate plan.",
      stage: "S09"
    });
  }
}

function checkoutDir(config: SetupConfig, repository: string): string {
  return path.join(
    config.paths.setup_cache_dir,
    "s09-project",
    repository.replaceAll("/", "__"),
    config.release.source_commit,
    "checkout"
  );
}

function checkerDir(config: SetupConfig, repository: string): string {
  return path.join(
    config.paths.setup_cache_dir,
    "s09-project",
    repository.replaceAll("/", "__"),
    config.release.source_commit,
    "checker"
  );
}

function proposalsDir(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "s09-proposals");
}

function inventoryPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, INVENTORY_FILENAME);
}

function proposalMetadataPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, PROPOSAL_METADATA_FILENAME);
}

function ownerNotePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, OWNER_NOTE_FILENAME);
}

function collectorEvidencePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, COLLECTOR_EVIDENCE_FILENAME);
}

function baselineEvidencePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, BASELINE_EVIDENCE_FILENAME);
}

function receiptPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, RECEIPT_FILENAME);
}

async function firstExisting(
  fsAdapter: FilesystemAdapter,
  root: string,
  candidates: string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (await fsAdapter.exists(absolute)) {
      return candidate;
    }
  }
  return null;
}

async function workspacePackages(fsAdapter: FilesystemAdapter, checkoutPath: string): Promise<string[]> {
  const packageJsonPath = path.join(checkoutPath, "package.json");
  if (!(await fsAdapter.exists(packageJsonPath))) {
    return [];
  }
  try {
    const parsed = JSON.parse(await fsAdapter.readText(packageJsonPath)) as { workspaces?: unknown };
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((item): item is string => typeof item === "string");
    }
    if (typeof workspaces === "object" && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)) {
      return ((workspaces as { packages: unknown[] }).packages).filter((item): item is string => typeof item === "string");
    }
    return [];
  } catch {
    return [];
  }
}

async function readInventory(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  repository: string,
  checkoutPath: string
): Promise<InventoryData> {
  const nvmPath = path.join(checkoutPath, ".nvmrc");
  const nodeVersion = (await fsAdapter.exists(nvmPath)) ? (await fsAdapter.readText(nvmPath)).trim() : null;
  const lockFile = await firstExisting(fsAdapter, checkoutPath, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  const lockSha = lockFile === null ? null : sha256Hex(await fsAdapter.readText(path.join(checkoutPath, lockFile)));
  const workspaces = await workspacePackages(fsAdapter, checkoutPath);
  const agentsPath = path.join(checkoutPath, "AGENTS.md");
  const workflowsRoot = path.join(checkoutPath, ".github", "workflows");
  const workflowEntries: Array<{ path: string; sha256: string }> = [];
  if (await fsAdapter.exists(workflowsRoot)) {
    const entries = await fsAdapter.readdir(workflowsRoot);
    for (const name of entries) {
      const workflowPath = path.join(workflowsRoot, name);
      const stat = await fsAdapter.lstat(workflowPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      const relative = path.join(".github", "workflows", name).replaceAll("\\", "/");
      workflowEntries.push({
        path: relative,
        sha256: sha256Hex(await fsAdapter.readText(workflowPath))
      });
    }
  }
  workflowEntries.sort((left, right) => left.path.localeCompare(right.path));

  const playwrightCandidates = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs"
  ];
  const playwrightConfigPaths: string[] = [];
  for (const candidate of playwrightCandidates) {
    if (await fsAdapter.exists(path.join(checkoutPath, candidate))) {
      playwrightConfigPaths.push(candidate);
    }
  }

  return {
    schema_version: 1,
    repository,
    target_sha: config.release.source_commit,
    observed_at: new Date().toISOString(),
    node_version: nodeVersion,
    package_manager_lock: (lockFile ?? "none") as InventoryData["package_manager_lock"],
    package_lock_sha256: lockSha,
    workspace_packages: workspaces,
    agents_md_present: await fsAdapter.exists(agentsPath),
    workflows: workflowEntries,
    playwright_config_paths: playwrightConfigPaths
  };
}

function renderFactoryBaselineTemplate(repository: string, targetSha: string): string {
  return FACTORY_BASELINE_TEMPLATE
    .replaceAll("{{TARGET_REPOSITORY}}", repository)
    .replaceAll("{{TARGET_SHA}}", targetSha);
}

async function writeProposalFiles(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  repository: string
): Promise<{ baselinePath: string; dependabotPath: string }> {
  const targetDir = proposalsDir(config);
  await fsAdapter.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const baselinePath = path.join(targetDir, "factory-baseline.proposed.yml");
  const dependabotPath = path.join(targetDir, "dependabot.proposed.yml");

  await writeAtomic(
    fsAdapter,
    baselinePath,
    renderFactoryBaselineTemplate(repository, config.release.source_commit),
    0o600
  );
  await writeAtomic(fsAdapter, dependabotPath, DEPENDABOT_TEMPLATE, 0o600);
  return { baselinePath, dependabotPath };
}

function ciResult(status: "passed" | "failed" | "draft" | "skipped" | "missing"): "pass" | "fail" | "unknown" {
  if (status === "passed") {
    return "pass";
  }
  if (status === "failed") {
    return "fail";
  }
  return BASELINE_UNKNOWN;
}

async function readBaselineEvidence(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  repository: string
): Promise<BaselineEvidence> {
  const ownerNoteExists = await fsAdapter.exists(ownerNotePath(config));
  let collectorStatus: "passed" | "failed" | "draft" | "skipped" | "missing" = "missing";
  let collectorVerified = false;
  const collectorPath = collectorEvidencePath(config);
  const collectorExists = await fsAdapter.exists(collectorPath);
  if (collectorExists) {
    const parsed = ensureJsonRecord(JSON.parse(await fsAdapter.readText(collectorPath)));
    if (
      parsed.ci_status === "passed"
      || parsed.ci_status === "failed"
      || parsed.ci_status === "draft"
      || parsed.ci_status === "skipped"
      || parsed.ci_status === "missing"
    ) {
      collectorStatus = parsed.ci_status;
    }
    collectorVerified = parsed.verification === "verified";
  }
  return {
    schema_version: 1,
    repository,
    target_sha: config.release.source_commit,
    owner_note_present: ownerNoteExists,
    collector_evidence_present: collectorExists,
    collector_evidence_verified: collectorVerified,
    ci_status: collectorStatus,
    ci_result: ciResult(collectorStatus),
    observed_at: new Date().toISOString()
  };
}

async function writeBaselineEvidence(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig,
  evidence: BaselineEvidence
): Promise<void> {
  await writeAtomic(fsAdapter, baselineEvidencePath(config), `${JSON.stringify(evidence, null, 2)}\n`, 0o600);
}

function inferStatus(
  checkout: CheckoutObservation,
  inventoryExists: boolean,
  proposalMetadataExists: boolean
): StageObservation["status"] {
  if (!checkout.exists || !checkout.gitDirExists || !checkout.detachedHead || checkout.dirty || checkout.headSha === null) {
    return "planned";
  }
  if (!inventoryExists || !proposalMetadataExists) {
    return "planned";
  }
  return "verified";
}

function assertConfig(config: SetupConfig, repository: string): void {
  ensureRepositoryAllowed(config, repository);
  if (!isValidSha(config.release.source_commit)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s09_target_sha_invalid",
      publicMessage: `Target SHA must be a full lowercase commit hash, got '${config.release.source_commit}'.`,
      nextAction: "Set release.source_commit to exact 40-char lowercase SHA and regenerate plan.",
      stage: "S09"
    });
  }
}

async function readCheckoutObservation(
  adapter: ProjectStageAdapter,
  config: SetupConfig,
  repository: string
): Promise<CheckoutObservation> {
  return adapter.observeCheckout(checkoutDir(config, repository));
}

function verifyCheckoutBinding(checkout: CheckoutObservation, targetSha: string): void {
  if (!checkout.exists || !checkout.gitDirExists) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s09_checkout_missing",
      publicMessage: "Target repository checkout is missing.",
      nextAction: "Run S09 apply with a reviewed read-only GitHub adapter.",
      stage: "S09"
    });
  }
  if (checkout.dirty) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s09_checkout_dirty",
      publicMessage: "Checkout is dirty; automatic reset is forbidden.",
      nextAction: "Clean or recreate checkout directory manually, then rerun S09.",
      stage: "S09"
    });
  }
  if (!checkout.detachedHead) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s09_checkout_not_detached",
      publicMessage: "Checkout must stay on detached HEAD for immutable SHA binding.",
      nextAction: "Recreate detached checkout at the planned SHA and rerun S09.",
      stage: "S09"
    });
  }
  if (checkout.headSha !== targetSha) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s09_checkout_sha_mismatch",
      publicMessage: `Checkout SHA mismatch: expected ${targetSha}, got ${checkout.headSha ?? "absent"}.`,
      nextAction: "Recreate checkout at the exact planned SHA and rerun S09.",
      stage: "S09"
    });
  }
}

export class NodeProjectStageAdapter implements ProjectStageAdapter {
  constructor(
    private readonly fsAdapter: FilesystemAdapter,
    private readonly processAdapter: ProcessAdapter
  ) {}

  private async git(args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
    return this.processAdapter.runCommand({
      binary: "/usr/bin/git",
      args: ["-C", cwd, ...args],
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
  }

  async observeCheckout(checkoutPath: string): Promise<CheckoutObservation> {
    if (!(await this.fsAdapter.exists(checkoutPath))) {
      return {
        exists: false,
        gitDirExists: false,
        detachedHead: false,
        headSha: null,
        dirty: false,
        originUrl: null
      };
    }
    const gitDirExists = await this.fsAdapter.exists(path.join(checkoutPath, ".git"));
    if (!gitDirExists) {
      return {
        exists: true,
        gitDirExists: false,
        detachedHead: false,
        headSha: null,
        dirty: false,
        originUrl: null
      };
    }
    const [status, branch, head, origin] = await Promise.all([
      this.git(["status", "--porcelain"], checkoutPath, OBSERVE_TIMEOUT_MS),
      this.git(["rev-parse", "--abbrev-ref", "HEAD"], checkoutPath, OBSERVE_TIMEOUT_MS),
      this.git(["rev-parse", "HEAD"], checkoutPath, OBSERVE_TIMEOUT_MS),
      this.git(["remote", "get-url", "origin"], checkoutPath, OBSERVE_TIMEOUT_MS)
    ]);
    const headCandidate = head.exitCode === 0 ? head.stdout.trim() : "";
    return {
      exists: true,
      gitDirExists: true,
      detachedHead: branch.exitCode === 0 && branch.stdout.trim() === "HEAD",
      headSha: isValidSha(headCandidate) ? headCandidate : null,
      dirty: status.exitCode !== 0 || status.stdout.trim().length > 0,
      originUrl: origin.exitCode === 0 ? origin.stdout.trim() : null
    };
  }

  async fetchDetachedCheckout(input: { repository: string; targetSha: string; checkoutDir: string }): Promise<void> {
    await this.fsAdapter.mkdir(input.checkoutDir, { recursive: true, mode: 0o700 });
    const gitDir = path.join(input.checkoutDir, ".git");
    if (!(await this.fsAdapter.exists(gitDir))) {
      const init = await this.git(["init", "-q"], input.checkoutDir, MUTATION_TIMEOUT_MS);
      if (init.exitCode !== 0 || init.timedOut) {
        throw setupError({
          exitCode: ExitCode.OperationOrVerificationFailed,
          code: "s09_checkout_init_failed",
          publicMessage: "Failed to initialize local checkout repository.",
          nextAction: "Inspect local filesystem permissions and rerun S09.",
          stage: "S09",
          evidenceRef: init.stderr.slice(0, 512)
        });
      }
      const setRemote = await this.git(
        ["remote", "add", "origin", `https://github.com/${input.repository}.git`],
        input.checkoutDir,
        MUTATION_TIMEOUT_MS
      );
      if (setRemote.exitCode !== 0 || setRemote.timedOut) {
        throw setupError({
          exitCode: ExitCode.OperationOrVerificationFailed,
          code: "s09_checkout_remote_set_failed",
          publicMessage: "Failed to configure checkout remote URL.",
          nextAction: "Inspect git remote configuration and rerun S09.",
          stage: "S09",
          evidenceRef: setRemote.stderr.slice(0, 512)
        });
      }
    }

    const fetch = await this.git(
      ["fetch", "--depth", "1", "origin", input.targetSha],
      input.checkoutDir,
      MUTATION_TIMEOUT_MS
    );
    if (fetch.exitCode !== 0 || fetch.timedOut) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s09_checkout_fetch_failed",
        publicMessage: "Failed to fetch target SHA from remote in read-only mode.",
        nextAction: "Verify SHA/repository access and reviewed read-only credentials, then rerun S09.",
        stage: "S09",
        evidenceRef: fetch.stderr.slice(0, 512)
      });
    }

    const checkout = await this.git(["checkout", "--detach", "FETCH_HEAD"], input.checkoutDir, MUTATION_TIMEOUT_MS);
    if (checkout.exitCode !== 0 || checkout.timedOut) {
      throw setupError({
        exitCode: ExitCode.OperationOrVerificationFailed,
        code: "s09_checkout_detach_failed",
        publicMessage: "Failed to switch checkout to detached HEAD.",
        nextAction: "Inspect local git checkout state and rerun S09.",
        stage: "S09",
        evidenceRef: checkout.stderr.slice(0, 512)
      });
    }
  }

  async runChecker(_input: { checkerDir: string; inventoryPath: string }): Promise<CheckerResult> {
    return {
      supported: false,
      status: "unknown",
      details: "PR4 checker adapter is not bundled in this installer build."
    };
  }
}

export function createNodeProjectStageAdapter(
  fsAdapter: FilesystemAdapter,
  processAdapter: ProcessAdapter
): ProjectStageAdapter {
  return new NodeProjectStageAdapter(fsAdapter, processAdapter);
}

export function createProjectStage(
  fsAdapter: FilesystemAdapter,
  adapter: ProjectStageAdapter
): StageModule {
  return {
    id: "S09",
    dependencies: ["S08"],
    supportedProfiles: ["supervised", "service"],
    optional: true,
    requiredCapabilities: ["runner-readonly"],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const config = ctx.config;
      const repository = targetRepository(config);
      assertConfig(config, repository);
      const checkout = await readCheckoutObservation(adapter, config, repository);
      const inventoryExists = await fsAdapter.exists(inventoryPath(config));
      const proposalExists = await fsAdapter.exists(proposalMetadataPath(config));
      const baseline = await readBaselineEvidence(fsAdapter, config, repository);
      await writeBaselineEvidence(fsAdapter, config, baseline);

      return {
        stageId: "S09",
        status: inferStatus(checkout, inventoryExists, proposalExists),
        checks: {
          s09_checkout_exists: checkout.exists,
          s09_checkout_detached: checkout.detachedHead,
          s09_checkout_dirty: checkout.dirty,
          s09_inventory_exists: inventoryExists,
          s09_proposals_exist: proposalExists,
          s09_baseline_owner_note_present: baseline.owner_note_present,
          s09_baseline_collector_verified: baseline.collector_evidence_verified,
          s09_baseline_ci_status: baseline.ci_status,
          s09_baseline_ci_result: baseline.ci_result
        },
        versions: {
          s09_target_repository: repository,
          s09_target_sha_expected: config.release.source_commit,
          s09_checkout_sha_actual: checkout.headSha ?? "absent",
          s09_checkout_origin_url: checkout.originUrl ?? "absent"
        },
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      const repository = targetRepository(config);
      assertConfig(config, repository);
      const ops: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s09-project-${config.installation_id.slice(0, 12)}`,
              stageId: "S09",
              action: "project.prepare" as const,
              kind: "mutate",
              resourceId: "github-project-proposals",
              risk: "medium",
              gateIds: [],
              preconditions: [
                `s09_target_repository:${repository}`,
                `s09_target_sha:${config.release.source_commit}`,
                `s09_checkout_dir:${checkoutDir(config, repository)}`,
                `s09_checker_dir:${checkerDir(config, repository)}`
              ],
              sideEffects: [
                "prepare detached read-only checkout at exact SHA",
                "record inventory without executing repository JavaScript",
                "emit baseline/dependabot proposals and baseline evidence"
              ],
              timeoutSec: 180,
              retryable: false
            }
          ];
      return {
        stageId: "S09",
        optional: true,
        requiredCapabilities: ["runner-readonly"],
        operations: ops,
        requiredGates: []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const config = ctx.config;
      const repository = targetRepository(config);
      assertConfig(config, repository);
      const cDir = checkoutDir(config, repository);
      const chkDir = checkerDir(config, repository);
      await fsAdapter.mkdir(path.dirname(cDir), { recursive: true, mode: 0o700 });
      await fsAdapter.mkdir(chkDir, { recursive: true, mode: 0o700 });
      await adapter.fetchDetachedCheckout({
        repository,
        targetSha: config.release.source_commit,
        checkoutDir: cDir
      });

      const checkout = await adapter.observeCheckout(cDir);
      verifyCheckoutBinding(checkout, config.release.source_commit);
      const inventory = await readInventory(fsAdapter, config, repository, cDir);
      await writeAtomic(fsAdapter, inventoryPath(config), `${JSON.stringify(inventory, null, 2)}\n`, 0o600);
      const proposals = await writeProposalFiles(fsAdapter, config, repository);
      await writeAtomic(
        fsAdapter,
        proposalMetadataPath(config),
        `${JSON.stringify({
          schema_version: 1,
          repository,
          target_sha: config.release.source_commit,
          baseline_path: proposals.baselinePath,
          dependabot_path: proposals.dependabotPath,
          generated_at: new Date().toISOString()
        }, null, 2)}\n`,
        0o600
      );

      const baseline = await readBaselineEvidence(fsAdapter, config, repository);
      await writeBaselineEvidence(fsAdapter, config, baseline);
      const checker = await adapter.runChecker({
        checkerDir: chkDir,
        inventoryPath: inventoryPath(config)
      });

      await writeAtomic(
        fsAdapter,
        receiptPath(config),
        `${JSON.stringify({
          schema_version: 1,
          stage: "S09",
          repository,
          target_sha: config.release.source_commit,
          checkout_dir: cDir,
          checker_dir: chkDir,
          checker_supported: checker.supported,
          checker_status: checker.status,
          baseline_ci_result: baseline.ci_result,
          created_at: new Date().toISOString()
        }, null, 2)}\n`,
        0o600
      );

      return [
        {
          operationId: approvedPlan.operations[0]?.id ?? `s09-apply-${ctx.installationId}`,
          stageId: "S09",
          resourceId: "github-project-proposals",
          observedAt: new Date().toISOString(),
          checks: {
            detached_checkout_bound_to_sha: true,
            checker_path_distinct: cDir !== chkDir,
            baseline_ci_result: baseline.ci_result,
            checker_supported: checker.supported,
            checker_status: checker.status
          },
          versions: {
            repository,
            target_sha: config.release.source_commit
          },
          artifacts: [
            inventoryPath(config),
            proposalMetadataPath(config),
            baselineEvidencePath(config),
            receiptPath(config),
            ownerNotePath(config),
            collectorEvidencePath(config)
          ]
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const config = ctx.config;
      const repository = targetRepository(config);
      assertConfig(config, repository);
      const checkout = await adapter.observeCheckout(checkoutDir(config, repository));
      verifyCheckoutBinding(checkout, config.release.source_commit);
      if (!(await fsAdapter.exists(inventoryPath(config))) || !(await fsAdapter.exists(proposalMetadataPath(config)))) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s09_artifacts_missing",
          publicMessage: "S09 inventory/proposal artifacts are missing.",
          nextAction: "Run S09 apply to regenerate proposals and inventory.",
          stage: "S09"
        });
      }
      const baseline = await readBaselineEvidence(fsAdapter, config, repository);
      await writeBaselineEvidence(fsAdapter, config, baseline);
      return [
        {
          operationId: "s09-verify",
          stageId: "S09",
          resourceId: "github-project-proposals",
          observedAt: new Date().toISOString(),
          checks: {
            detached_checkout_bound_to_sha: true,
            baseline_ci_status: baseline.ci_status,
            baseline_ci_result: baseline.ci_result
          },
          versions: {
            repository,
            target_sha: config.release.source_commit
          },
          artifacts: [
            inventoryPath(config),
            proposalMetadataPath(config),
            baselineEvidencePath(config),
            receiptPath(config)
          ]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
