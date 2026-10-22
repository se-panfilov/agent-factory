import { createHash } from "node:crypto";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
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

const WORKFLOW_TEMPLATE_PATHS = [
  path.resolve(__dirname, "../../templates/github/factory-platform-check.yml"),
  path.resolve(__dirname, "../../../templates/github/factory-platform-check.yml")
];

const PLATFORM_REQUEST_FILENAME = "s13-platform-request.json";
const PLATFORM_READINESS_FILENAME = "s13-platform-readiness.json";
const PLATFORM_COLLECTOR_FILENAME = "s13-platform-collector-evidence.json";
const PLATFORM_RECEIPT_FILENAME = "s13-platform-receipt.json";
const BROWSER_SMOKE_ADAPTER_FILENAME = "s13-browser-smoke-adapter.json";
const WORKFLOW_PROPOSAL_FILENAME = "factory-platform-check.proposed.yml";

const APPLY_GATE_ID = "s13-platforms-owner-approved";
const TRUSTED_WORKFLOW_PATH = ".github/workflows/factory-platform-check.yml";
const TRUSTED_PRODUCER = "github-actions:factory-platform-check";
const TRUSTED_CHECKOUT_ACTION_SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
const TRUSTED_SETUP_NODE_ACTION_SHA = "a0853c24544627f65ddf259abe73b1d18a591444";

const PLATFORM_LABELS = {
  "linux-x64": "ubuntu-24.04",
  "windows-x64": "windows-2025",
  "macos-arm64": "macos-15"
} as const;

const PLATFORM_OS_ARCH = {
  "linux-x64": { os: "Linux", arch: "X64" },
  "windows-x64": { os: "Windows", arch: "X64" },
  "macos-arm64": { os: "macOS", arch: "ARM64" }
} as const;

type PlatformId = keyof typeof PLATFORM_LABELS;
type CheckProfile = "guard" | "browser_smoke";
type CheckVerdict = "pass" | "fail" | "unknown";

interface BrowserSmokeAdapterRecord {
  schema_version: 1;
  profile: "browser_smoke";
  command: string[];
}

interface PlatformRequestRecord {
  schema_version: 1;
  candidate_sha: string;
  profile: CheckProfile;
  platforms: PlatformId[];
  trusted_workflow_sha: string;
  allowed_workflow_path: string;
  allowed_producer: string;
  actions_allowed: boolean;
  billing_reviewed: boolean;
}

interface CollectorEvidenceCheck {
  platform: PlatformId;
  check_key: CheckProfile;
  verdict: CheckVerdict;
  producer: string;
  workflow_ref: string;
  run_id: string;
  runner_label: string;
  runner_os: string;
  runner_arch: string;
  runner_image: string;
  candidate_sha: string;
  actual_checkout_sha: string;
}

interface CollectorEvidenceRecord {
  schema_version: 1;
  checks: CollectorEvidenceCheck[];
  dispatch: {
    accepted: boolean;
    dispatch_key: string | null;
    timed_out: boolean;
    reconciled: boolean;
  };
  observed_at: string;
}

interface PlatformReadinessRecord {
  schema_version: 1;
  candidate_sha: string;
  profile: CheckProfile;
  platforms: PlatformId[];
  workflow_template_sha256: string;
  trusted_workflow_sha: string;
  allowed_workflow_path: string;
  allowed_producer: string;
  dispatch_required: boolean;
  dispatch_reconciliation: "not-run" | "reconciled" | "ambiguous";
  checks_status: "unknown" | "pass" | "fail";
  integration_verified: boolean;
  manual_actions: string[];
  observed_at: string;
}

interface PlatformObservationSnapshot {
  request: PlatformRequestRecord | null;
  adapter: BrowserSmokeAdapterRecord | null;
  readiness: PlatformReadinessRecord | null;
  collector: CollectorEvidenceRecord | null;
  templateValid: boolean;
  templateSha: string | null;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSha40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function isPlatform(value: string): value is PlatformId {
  return value === "linux-x64" || value === "windows-x64" || value === "macos-arm64";
}

function isCheckProfile(value: string): value is CheckProfile {
  return value === "guard" || value === "browser_smoke";
}

function requestPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, PLATFORM_REQUEST_FILENAME);
}

function readinessPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, PLATFORM_READINESS_FILENAME);
}

function collectorPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, PLATFORM_COLLECTOR_FILENAME);
}

function receiptPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, PLATFORM_RECEIPT_FILENAME);
}

function adapterPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, BROWSER_SMOKE_ADAPTER_FILENAME);
}

function proposalsDir(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "s13-proposals");
}

function workflowProposalPath(config: SetupConfig): string {
  return path.join(proposalsDir(config), WORKFLOW_PROPOSAL_FILENAME);
}

async function writeAtomic(fsAdapter: FilesystemAdapter, targetPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fsAdapter.writeText(tempPath, content, mode);
  await fsAdapter.fsyncFile(tempPath);
  await fsAdapter.rename(tempPath, targetPath);
  await fsAdapter.fsyncDir(path.dirname(targetPath));
}

async function readRegularJson(fsAdapter: FilesystemAdapter, targetPath: string): Promise<unknown> {
  if (!(await fsAdapter.exists(targetPath))) {
    return null;
  }
  const stat = await fsAdapter.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s13_forbidden_entry_type",
      publicMessage: `S13 input '${path.basename(targetPath)}' must be a regular file.`,
      nextAction: "Replace symlink/special file with a reviewed regular JSON file.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  return JSON.parse(await fsAdapter.readText(targetPath));
}

function validateBrowserSmokeAdapter(raw: unknown, targetPath: string): BrowserSmokeAdapterRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_browser_smoke_adapter_invalid",
      publicMessage: "S13 browser_smoke adapter record is invalid.",
      nextAction: "Provide reviewed PR12 adapter record with schema_version/profile/command.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  const record = raw as Partial<BrowserSmokeAdapterRecord>;
  if (record.schema_version !== 1 || record.profile !== "browser_smoke" || !Array.isArray(record.command) || record.command.length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_browser_smoke_adapter_invalid",
      publicMessage: "S13 browser_smoke adapter record is invalid.",
      nextAction: "Provide reviewed PR12 adapter record with schema_version/profile/command.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  for (const value of record.command) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\n") || value.includes("\r")) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s13_browser_smoke_command_unsafe",
        publicMessage: "S13 browser_smoke adapter command contains unsafe arguments.",
        nextAction: "Provide adapter command as safe argv strings without control characters.",
        stage: "S13",
        evidenceRef: targetPath
      });
    }
  }
  return {
    schema_version: 1,
    profile: "browser_smoke",
    command: record.command
  };
}

function validateRequest(raw: unknown, targetPath: string): PlatformRequestRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_request_invalid",
      publicMessage: "S13 platform request is invalid.",
      nextAction: "Create s13-platform-request.json with reviewed candidate/profile/platform settings.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  const record = raw as Partial<PlatformRequestRecord>;
  if (
    record.schema_version !== 1
    || typeof record.candidate_sha !== "string"
    || typeof record.profile !== "string"
    || !Array.isArray(record.platforms)
    || typeof record.trusted_workflow_sha !== "string"
    || typeof record.allowed_workflow_path !== "string"
    || typeof record.allowed_producer !== "string"
    || typeof record.actions_allowed !== "boolean"
    || typeof record.billing_reviewed !== "boolean"
  ) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_request_invalid",
      publicMessage: "S13 platform request is invalid.",
      nextAction: "Create s13-platform-request.json with reviewed candidate/profile/platform settings.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  if (!isSha40(record.candidate_sha)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s13_candidate_sha_invalid",
      publicMessage: "S13 request candidate_sha must be a full lowercase 40-char SHA.",
      nextAction: "Set candidate_sha to exact target commit SHA and regenerate request.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  if (!isCheckProfile(record.profile)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s13_profile_invalid",
      publicMessage: "S13 request profile is unsupported.",
      nextAction: "Use profile 'guard' or 'browser_smoke' in request.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  if (!isSha40(record.trusted_workflow_sha)) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s13_trusted_workflow_sha_invalid",
      publicMessage: "S13 trusted workflow SHA must be a full lowercase 40-char SHA.",
      nextAction: "Set trusted_workflow_sha to reviewed workflow commit and regenerate request.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  if (record.allowed_workflow_path !== TRUSTED_WORKFLOW_PATH || record.allowed_producer !== TRUSTED_PRODUCER) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_workflow_identity_not_allowed",
      publicMessage: "S13 request references unsupported workflow path or producer identity.",
      nextAction: "Use .github/workflows/factory-platform-check.yml and github-actions:factory-platform-check.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  if (record.platforms.length > 3) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_platforms_too_many",
      publicMessage: "S13 request exceeds max 3 platforms per dispatch.",
      nextAction: "Reduce platforms list to at most 3 entries.",
      stage: "S13",
      evidenceRef: targetPath
    });
  }
  const unique = new Set<PlatformId>();
  const normalized: PlatformId[] = [];
  for (const platform of record.platforms) {
    if (typeof platform !== "string" || !isPlatform(platform)) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "s13_platform_unsupported",
        publicMessage: `S13 request has unsupported platform '${String(platform)}'.`,
        nextAction: "Use only linux-x64, windows-x64, macos-arm64.",
        stage: "S13",
        evidenceRef: targetPath
      });
    }
    if (unique.has(platform)) {
      throw setupError({
        exitCode: ExitCode.CliOrSchemaError,
        code: "s13_platform_duplicate",
        publicMessage: `S13 request has duplicate platform '${platform}'.`,
        nextAction: "Deduplicate platforms list before planning/applying S13.",
        stage: "S13",
        evidenceRef: targetPath
      });
    }
    unique.add(platform);
    normalized.push(platform);
  }
  return {
    schema_version: 1,
    candidate_sha: record.candidate_sha,
    profile: record.profile,
    platforms: normalized,
    trusted_workflow_sha: record.trusted_workflow_sha,
    allowed_workflow_path: record.allowed_workflow_path,
    allowed_producer: record.allowed_producer,
    actions_allowed: record.actions_allowed,
    billing_reviewed: record.billing_reviewed
  };
}

function validateTemplateShape(template: string): void {
  const requiredSnippets = [
    "name: Factory platform check",
    "workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "persist-credentials: false",
    `uses: actions/checkout@${TRUSTED_CHECKOUT_ACTION_SHA}`,
    `uses: actions/setup-node@${TRUSTED_SETUP_NODE_ACTION_SHA}`,
    "ubuntu-24.04",
    "windows-2025",
    "macos-15"
  ];
  for (const snippet of requiredSnippets) {
    if (!template.includes(snippet)) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s13_template_invalid",
        publicMessage: "S13 workflow template is missing required pinned fields.",
        nextAction: "Restore reviewed factory-platform-check.yml template from installer release.",
        stage: "S13"
      });
    }
  }
  if (!template.includes("new Set(wanted).size !== wanted.length")) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_template_invalid",
      publicMessage: "S13 workflow template does not enforce unique platform entries.",
      nextAction: "Use reviewed template with duplicate-platform guard.",
      stage: "S13"
    });
  }
  if (template.includes(": write") || template.includes("${{ secrets.")) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s13_template_permissions_unsafe",
      publicMessage: "S13 workflow template contains forbidden write permissions or secret usage.",
      nextAction: "Remove write permissions/secrets from platform workflow template.",
      stage: "S13"
    });
  }
}

async function readTemplate(fsAdapter: FilesystemAdapter): Promise<{ content: string; sha256: string }> {
  for (const candidate of WORKFLOW_TEMPLATE_PATHS) {
    if (!(await fsAdapter.exists(candidate))) {
      continue;
    }
    const content = await fsAdapter.readText(candidate);
    validateTemplateShape(content);
    return {
      content,
      sha256: sha256Hex(content)
    };
  }
  throw setupError({
    exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "s13_template_missing",
    publicMessage: "S13 workflow template is missing in this installer release.",
    nextAction: "Use installer release containing templates/github/factory-platform-check.yml.",
    stage: "S13"
  });
}

async function readRequest(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<PlatformRequestRecord | null> {
  const target = requestPath(config);
  const parsed = await readRegularJson(fsAdapter, target);
  if (parsed === null) {
    return null;
  }
  return validateRequest(parsed, target);
}

async function readAdapter(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<BrowserSmokeAdapterRecord | null> {
  const target = adapterPath(config);
  const parsed = await readRegularJson(fsAdapter, target);
  if (parsed === null) {
    return null;
  }
  return validateBrowserSmokeAdapter(parsed, target);
}

async function readReadiness(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<PlatformReadinessRecord | null> {
  const target = readinessPath(config);
  const parsed = await readRegularJson(fsAdapter, target);
  if (parsed === null || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Partial<PlatformReadinessRecord>;
  if (
    record.schema_version !== 1
    || typeof record.candidate_sha !== "string"
    || typeof record.profile !== "string"
    || !Array.isArray(record.platforms)
    || typeof record.workflow_template_sha256 !== "string"
    || typeof record.trusted_workflow_sha !== "string"
    || typeof record.allowed_workflow_path !== "string"
    || typeof record.allowed_producer !== "string"
    || typeof record.dispatch_required !== "boolean"
    || typeof record.dispatch_reconciliation !== "string"
    || typeof record.checks_status !== "string"
    || typeof record.integration_verified !== "boolean"
    || !Array.isArray(record.manual_actions)
  ) {
    return null;
  }
  return record as PlatformReadinessRecord;
}

function parseWorkflowRef(value: string): { workflowPath: string; workflowSha: string } | null {
  const pieces = value.split("@");
  if (pieces.length !== 2) {
    return null;
  }
  const workflowPath = pieces[0];
  const workflowSha = pieces[1];
  if (workflowPath === undefined || workflowSha === undefined || !isSha40(workflowSha)) {
    return null;
  }
  return { workflowPath, workflowSha };
}

function parseCollectorChecks(raw: unknown): CollectorEvidenceCheck[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const checks: CollectorEvidenceCheck[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.platform !== "string"
      || !isPlatform(item.platform)
      || typeof item.check_key !== "string"
      || !isCheckProfile(item.check_key)
      || typeof item.verdict !== "string"
      || (item.verdict !== "pass" && item.verdict !== "fail" && item.verdict !== "unknown")
      || typeof item.producer !== "string"
      || typeof item.workflow_ref !== "string"
      || typeof item.run_id !== "string"
      || typeof item.runner_label !== "string"
      || typeof item.runner_os !== "string"
      || typeof item.runner_arch !== "string"
      || typeof item.runner_image !== "string"
      || typeof item.candidate_sha !== "string"
      || typeof item.actual_checkout_sha !== "string"
    ) {
      continue;
    }
    checks.push({
      platform: item.platform,
      check_key: item.check_key,
      verdict: item.verdict,
      producer: item.producer,
      workflow_ref: item.workflow_ref,
      run_id: item.run_id,
      runner_label: item.runner_label,
      runner_os: item.runner_os,
      runner_arch: item.runner_arch,
      runner_image: item.runner_image,
      candidate_sha: item.candidate_sha,
      actual_checkout_sha: item.actual_checkout_sha
    });
  }
  return checks;
}

async function readCollectorEvidence(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<CollectorEvidenceRecord | null> {
  const target = collectorPath(config);
  const parsed = await readRegularJson(fsAdapter, target);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schema_version !== 1 || typeof raw.observed_at !== "string") {
    return null;
  }
  const checks = parseCollectorChecks(raw.checks);
  const dispatchRaw = raw.dispatch;
  const dispatch = typeof dispatchRaw === "object" && dispatchRaw !== null && !Array.isArray(dispatchRaw)
    ? dispatchRaw as Record<string, unknown>
    : {};
  if (
    typeof dispatch.accepted !== "boolean"
    || typeof dispatch.timed_out !== "boolean"
    || typeof dispatch.reconciled !== "boolean"
    || (dispatch.dispatch_key !== null && typeof dispatch.dispatch_key !== "string")
  ) {
    return null;
  }
  return {
    schema_version: 1,
    checks,
    dispatch: {
      accepted: dispatch.accepted,
      dispatch_key: (dispatch.dispatch_key as string | null) ?? null,
      timed_out: dispatch.timed_out,
      reconciled: dispatch.reconciled
    },
    observed_at: raw.observed_at
  };
}

function requireBrowserSmokeAdapter(
  request: PlatformRequestRecord,
  adapter: BrowserSmokeAdapterRecord | null,
  config: SetupConfig
): void {
  if (request.profile !== "browser_smoke") {
    return;
  }
  if (adapter === null) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s13_browser_smoke_adapter_missing",
      publicMessage: "S13 browser_smoke profile is blocked: PR12 adapter command is missing.",
      nextAction: "Provide reviewed s13-browser-smoke-adapter.json from application PR12 and rerun S13.",
      stage: "S13",
      evidenceRef: adapterPath(config)
    });
  }
}

function validateCollectorAgainstRequest(
  request: PlatformRequestRecord,
  collector: CollectorEvidenceRecord
): { status: "pass" | "fail" | "unknown"; verified: boolean } {
  if (!collector.dispatch.accepted) {
    return { status: "unknown", verified: false };
  }
  if (collector.dispatch.timed_out && !collector.dispatch.reconciled) {
    return { status: "unknown", verified: false };
  }
  if (request.platforms.length === 0) {
    return { status: "unknown", verified: false };
  }
  for (const platform of request.platforms) {
    const check = collector.checks.find((entry) => entry.platform === platform && entry.check_key === request.profile);
    if (check === undefined) {
      return { status: "unknown", verified: false };
    }
    if (check.producer !== request.allowed_producer) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s13_untrusted_producer",
        publicMessage: `S13 check producer mismatch for ${platform}.`,
        nextAction: "Collect evidence only from allowed producer identity and rerun verify.",
        stage: "S13",
        evidenceRef: check.producer
      });
    }
    const workflowRef = parseWorkflowRef(check.workflow_ref);
    if (workflowRef === null || workflowRef.workflowPath !== request.allowed_workflow_path || workflowRef.workflowSha !== request.trusted_workflow_sha) {
      throw setupError({
        exitCode: ExitCode.SecurityBoundaryViolation,
        code: "s13_untrusted_workflow_ref",
        publicMessage: `S13 check workflow ref is untrusted for ${platform}.`,
        nextAction: "Use trusted workflow path and reviewed workflow SHA in collector evidence.",
        stage: "S13",
        evidenceRef: check.workflow_ref
      });
    }
    const expectedLabel = PLATFORM_LABELS[platform];
    const expectedOsArch = PLATFORM_OS_ARCH[platform];
    if (
      check.runner_label !== expectedLabel
      || check.runner_os !== expectedOsArch.os
      || check.runner_arch !== expectedOsArch.arch
    ) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s13_runner_identity_mismatch",
        publicMessage: `S13 runner identity mismatch for ${platform}.`,
        nextAction: "Collect evidence with pinned runner label and actual OS/arch matching platform requirement.",
        stage: "S13",
        evidenceRef: `${check.runner_label}/${check.runner_os}/${check.runner_arch}`
      });
    }
    if (check.candidate_sha !== request.candidate_sha || check.actual_checkout_sha !== request.candidate_sha) {
      throw setupError({
        exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
        code: "s13_candidate_sha_mismatch",
        publicMessage: `S13 check does not match requested candidate SHA for ${platform}.`,
        nextAction: "Dispatch checks for exact candidate SHA and collect updated evidence.",
        stage: "S13",
        evidenceRef: `${check.candidate_sha}/${check.actual_checkout_sha}`
      });
    }
    if (check.verdict !== "pass") {
      return { status: check.verdict === "fail" ? "fail" : "unknown", verified: false };
    }
  }
  return { status: "pass", verified: true };
}

function snapshotStatus(snapshot: PlatformObservationSnapshot): StageObservation["status"] {
  if (!snapshot.templateValid || snapshot.request === null) {
    return "planned";
  }
  if (snapshot.request.profile === "browser_smoke" && snapshot.adapter === null) {
    return "blocked";
  }
  if (snapshot.readiness === null) {
    return "planned";
  }
  if (snapshot.readiness.integration_verified) {
    return "verified";
  }
  if (snapshot.readiness.checks_status === "fail") {
    return "blocked";
  }
  return "planned";
}

function snapshotChecks(snapshot: PlatformObservationSnapshot): Record<string, string | number | boolean> {
  return {
    s13_optional_enabled: true,
    s13_template_valid: snapshot.templateValid,
    s13_request_present: snapshot.request !== null,
    s13_browser_smoke_adapter_present: snapshot.adapter !== null,
    s13_collector_present: snapshot.collector !== null,
    s13_dispatch_required: snapshot.readiness?.dispatch_required ?? false,
    s13_dispatch_reconciliation: snapshot.readiness?.dispatch_reconciliation ?? "not-run",
    s13_checks_status: snapshot.readiness?.checks_status ?? "unknown",
    s13_integration_verified: snapshot.readiness?.integration_verified ?? false
  };
}

async function observationSnapshot(
  fsAdapter: FilesystemAdapter,
  config: SetupConfig
): Promise<PlatformObservationSnapshot> {
  const template = await readTemplate(fsAdapter);
  const request = await readRequest(fsAdapter, config);
  const adapter = await readAdapter(fsAdapter, config);
  const readiness = await readReadiness(fsAdapter, config);
  const collector = await readCollectorEvidence(fsAdapter, config);
  if (request !== null && request.profile === "browser_smoke" && adapter === null) {
    return {
      request,
      adapter: null,
      readiness,
      collector,
      templateValid: true,
      templateSha: template.sha256
    };
  }
  return {
    request,
    adapter,
    readiness,
    collector,
    templateValid: true,
    templateSha: template.sha256
  };
}

function readinessManualActions(request: PlatformRequestRecord): string[] {
  return [
    "Review and merge .github/workflows/factory-platform-check.yml proposal in target repository.",
    "Confirm GitHub Actions billing and hosted-runner availability for selected platforms.",
    `Run one explicit workflow_dispatch for candidate ${request.candidate_sha} and collect API evidence.`,
    "Populate s13-platform-collector-evidence.json using trusted collector output (not job-generated evidence.json)."
  ];
}

export function createPlatformsStage(fsAdapter: FilesystemAdapter): StageModule {
  let lastConfig: SetupConfig | null = null;
  return {
    id: "S13",
    dependencies: ["S09"],
    supportedProfiles: ["supervised", "service"],
    optional: true,
    requiredCapabilities: ["platform-browser-smoke", "platform-collector"],
    async observe(): Promise<StageObservation> {
      if (lastConfig === null) {
        return {
          stageId: "S13",
          status: "planned",
          checks: {
            s13_config_loaded: false
          },
          versions: {},
          observedAt: new Date().toISOString()
        };
      }
      if (!lastConfig.optional_features.platforms) {
        return {
          stageId: "S13",
          status: "skipped",
          checks: {
            s13_optional_enabled: false
          },
          versions: {},
          observedAt: new Date().toISOString()
        };
      }
      const snapshot = await observationSnapshot(fsAdapter, lastConfig);
      return {
        stageId: "S13",
        status: snapshotStatus(snapshot),
        checks: snapshotChecks(snapshot),
        versions: {
          s13_candidate_sha: snapshot.request?.candidate_sha ?? "absent",
          s13_profile: snapshot.request?.profile ?? "absent",
          s13_template_sha256: snapshot.templateSha ?? "absent",
          s13_trusted_workflow_sha: snapshot.request?.trusted_workflow_sha ?? "absent",
          s13_allowed_workflow_path: snapshot.request?.allowed_workflow_path ?? "absent",
          s13_allowed_producer: snapshot.request?.allowed_producer ?? "absent"
        },
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      lastConfig = config;
      if (!config.optional_features.platforms) {
        return {
          stageId: "S13",
          optional: true,
          requiredCapabilities: ["platform-browser-smoke", "platform-collector"],
          operations: [],
          requiredGates: []
        };
      }
      const operations = observed.status === "verified"
        ? []
        : [
            {
              id: `s13-platforms-${config.installation_id.slice(0, 12)}`,
              stageId: "S13" as const,
              kind: "mutate" as const,
              resourceId: "s13-platform-proposal",
              risk: "medium" as const,
              gateIds: [APPLY_GATE_ID],
              preconditions: [
                "s09_target_inventory_present",
                "s13_request_reviewed",
                "s13_actions_billing_reviewed",
                "s13_template_pinned"
              ],
              sideEffects: [
                "write workflow proposal and readiness artifact",
                "do not dispatch matrix workflows automatically"
              ],
              timeoutSec: 120,
              retryable: false
            }
          ];
      return {
        stageId: "S13",
        optional: true,
        requiredCapabilities: ["platform-browser-smoke", "platform-collector"],
        operations,
        requiredGates: operations.length > 0 ? [APPLY_GATE_ID] : []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s13_config_not_initialized",
          publicMessage: "S13 apply requires plan generation in the same process.",
          nextAction: "Run plan/apply sequence for S13.",
          stage: "S13"
        });
      }
      if (!lastConfig.optional_features.platforms) {
        return [];
      }

      const template = await readTemplate(fsAdapter);
      const request = await readRequest(fsAdapter, lastConfig);
      if (request === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s13_request_missing",
          publicMessage: "S13 platform request is missing.",
          nextAction: "Create reviewed s13-platform-request.json and rerun S13.",
          stage: "S13",
          evidenceRef: requestPath(lastConfig)
        });
      }
      if (!request.actions_allowed || !request.billing_reviewed) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s13_actions_allowance_missing",
          publicMessage: "S13 requires owner review of Actions allowance and billing before proposal apply.",
          nextAction: "Set actions_allowed=true and billing_reviewed=true in request after owner review.",
          stage: "S13",
          evidenceRef: requestPath(lastConfig)
        });
      }
      if (request.candidate_sha !== lastConfig.release.source_commit) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s13_candidate_sha_drift",
          publicMessage: "S13 request candidate SHA differs from current config release.source_commit.",
          nextAction: "Update request candidate_sha to current target SHA and regenerate plan.",
          stage: "S13",
          evidenceRef: `${request.candidate_sha}/${lastConfig.release.source_commit}`
        });
      }

      const browserSmokeAdapter = await readAdapter(fsAdapter, lastConfig);
      requireBrowserSmokeAdapter(request, browserSmokeAdapter, lastConfig);

      await fsAdapter.mkdir(proposalsDir(lastConfig), { recursive: true, mode: 0o700 });
      await writeAtomic(fsAdapter, workflowProposalPath(lastConfig), template.content, 0o600);
      const readiness: PlatformReadinessRecord = {
        schema_version: 1,
        candidate_sha: request.candidate_sha,
        profile: request.profile,
        platforms: request.platforms,
        workflow_template_sha256: template.sha256,
        trusted_workflow_sha: request.trusted_workflow_sha,
        allowed_workflow_path: request.allowed_workflow_path,
        allowed_producer: request.allowed_producer,
        dispatch_required: request.platforms.length > 0,
        dispatch_reconciliation: "not-run",
        checks_status: "unknown",
        integration_verified: false,
        manual_actions: readinessManualActions(request),
        observed_at: new Date().toISOString()
      };

      const collector = await readCollectorEvidence(fsAdapter, lastConfig);
      if (collector !== null) {
        const collectorStatus = validateCollectorAgainstRequest(request, collector);
        readiness.dispatch_reconciliation = collector.dispatch.timed_out && !collector.dispatch.reconciled
          ? "ambiguous"
          : collector.dispatch.reconciled
            ? "reconciled"
            : "not-run";
        readiness.checks_status = collectorStatus.status;
        readiness.integration_verified = collectorStatus.verified;
      }

      await writeAtomic(fsAdapter, readinessPath(lastConfig), `${JSON.stringify(readiness, null, 2)}\n`, 0o600);
      await writeAtomic(
        fsAdapter,
        receiptPath(lastConfig),
        `${JSON.stringify({
          schema_version: 1,
          stage: "S13",
          candidate_sha: request.candidate_sha,
          profile: request.profile,
          platforms: request.platforms,
          workflow_template_sha256: template.sha256,
          workflow_proposal_path: workflowProposalPath(lastConfig),
          readiness_path: readinessPath(lastConfig),
          collector_present: collector !== null,
          dispatch_required: readiness.dispatch_required,
          generated_at: new Date().toISOString()
        }, null, 2)}\n`,
        0o600
      );

      return [
        {
          operationId: approvedPlan.operations[0]?.id ?? `s13-apply-${ctx.installationId}`,
          stageId: "S13",
          resourceId: "s13-platform-proposal",
          observedAt: new Date().toISOString(),
          checks: {
            s13_request_validated: true,
            s13_browser_smoke_adapter_present: browserSmokeAdapter !== null,
            s13_dispatch_required: readiness.dispatch_required,
            s13_checks_status: readiness.checks_status,
            s13_integration_verified: readiness.integration_verified
          },
          versions: {
            s13_candidate_sha: request.candidate_sha,
            s13_profile: request.profile,
            s13_template_sha256: template.sha256,
            s13_trusted_workflow_sha: request.trusted_workflow_sha
          },
          artifacts: [
            workflowProposalPath(lastConfig),
            readinessPath(lastConfig),
            receiptPath(lastConfig)
          ]
        }
      ];
    },
    async verify(): Promise<StageReceipt[]> {
      if (lastConfig === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s13_verify_without_config",
          publicMessage: "S13 verify requires previously loaded config context.",
          nextAction: "Run plan/apply or status --refresh before verify.",
          stage: "S13"
        });
      }
      if (!lastConfig.optional_features.platforms) {
        return [];
      }
      const request = await readRequest(fsAdapter, lastConfig);
      if (request === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s13_request_missing",
          publicMessage: "S13 verify cannot continue without platform request.",
          nextAction: "Provide reviewed s13-platform-request.json and rerun S13 verify.",
          stage: "S13",
          evidenceRef: requestPath(lastConfig)
        });
      }
      const template = await readTemplate(fsAdapter);
      const readiness = await readReadiness(fsAdapter, lastConfig);
      if (readiness === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s13_readiness_missing",
          publicMessage: "S13 readiness artifact is missing.",
          nextAction: "Run S13 apply to generate readiness proposal artifacts.",
          stage: "S13",
          evidenceRef: readinessPath(lastConfig)
        });
      }
      if (readiness.workflow_template_sha256 !== template.sha256) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s13_template_drift",
          publicMessage: "S13 workflow template hash drift detected.",
          nextAction: "Re-apply S13 with reviewed template pins and rerun verify.",
          stage: "S13"
        });
      }
      const browserSmokeAdapter = await readAdapter(fsAdapter, lastConfig);
      requireBrowserSmokeAdapter(request, browserSmokeAdapter, lastConfig);

      const collector = await readCollectorEvidence(fsAdapter, lastConfig);
      let checksStatus: "pass" | "fail" | "unknown" = "unknown";
      let integrationVerified = false;
      let reconciliation: "not-run" | "reconciled" | "ambiguous" = "not-run";
      if (collector !== null) {
        const collectorStatus = validateCollectorAgainstRequest(request, collector);
        checksStatus = collectorStatus.status;
        integrationVerified = collectorStatus.verified;
        reconciliation = collector.dispatch.timed_out && !collector.dispatch.reconciled
          ? "ambiguous"
          : collector.dispatch.reconciled
            ? "reconciled"
            : "not-run";
      }
      const nextReadiness: PlatformReadinessRecord = {
        ...readiness,
        checks_status: checksStatus,
        integration_verified: integrationVerified,
        dispatch_reconciliation: reconciliation,
        observed_at: new Date().toISOString()
      };
      await writeAtomic(fsAdapter, readinessPath(lastConfig), `${JSON.stringify(nextReadiness, null, 2)}\n`, 0o600);

      return [
        {
          operationId: "s13-verify",
          stageId: "S13",
          resourceId: "s13-platform-proposal",
          observedAt: new Date().toISOString(),
          checks: {
            s13_checks_status: checksStatus,
            s13_integration_verified: integrationVerified,
            s13_dispatch_reconciliation: reconciliation,
            s13_collector_present: collector !== null
          },
          versions: {
            s13_candidate_sha: request.candidate_sha,
            s13_profile: request.profile,
            s13_template_sha256: template.sha256
          },
          artifacts: [
            workflowProposalPath(lastConfig),
            readinessPath(lastConfig),
            receiptPath(lastConfig)
          ]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}

export const PLATFORM_GATES = {
  APPLY_GATE_ID
} as const;
