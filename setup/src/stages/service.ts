import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type AppCommandResult, type SystemdAdapter } from "../adapters/systemd";
import { setupError } from "../core/errors";
import {
  ExitCode,
  type CapabilityName,
  type SetupConfig,
  type StageContext,
  type StageModule,
  type StageObservation,
  type StagePlan,
  type StageReceipt
} from "../core/types";
import { validateContractSchema } from "../core/validators";
import { type ApplicationManifestData } from "../adapters/git";

const OBSERVE_TIMEOUT_MS = 30_000;
const MIGRATION_TIMEOUT_MS = 120_000;
const SERVICE_UNIT_NAME = "agent-factory.service";
const SERVICE_UNIT_TARGET_PATH = "/etc/systemd/system/agent-factory.service";
const SERVICE_RELEASE_ROOT = "/opt/agent-factory/releases";
const SERVICE_DATA_ROOT = "/var/lib/agent-factory";
const REQUIRED_M2_PRS = ["PR8", "PR9", "PR11"] as const;

interface M2SecurityEvidence {
  schema_version: 1;
  status: "verified" | "blocked";
  guide_prs: string[];
  evidence_refs: string[];
  provenance: string;
}

interface ResolvedServiceCommands {
  recover: string[];
  serve: string[];
  pause: string[];
  stop: string[];
  migrate: string[];
  status: string[];
}

interface ServiceSnapshot {
  manifestAvailable: boolean;
  manifestValid: boolean;
  capabilityChecks: {
    requiredCapabilitiesPresent: boolean;
    requiredCommandsPresent: boolean;
    missingCapabilities: string[];
    missingCommands: string[];
  };
  m2EvidencePresent: boolean;
  m2EvidenceVerified: boolean;
  m2GuidePrsPresent: boolean;
  releasePathPrepared: boolean;
  serviceUnitExists: boolean;
  serviceEnabled: boolean;
  serviceActive: boolean;
  pausedStateConfirmed: boolean;
  evidenceRef: string;
}

function templateCandidates(): string[] {
  return [
    path.resolve(__dirname, "../../templates/systemd/agent-factory.service"),
    path.resolve(__dirname, "../../../templates/systemd/agent-factory.service")
  ];
}

async function resolveTemplatePath(fsAdapter: FilesystemAdapter): Promise<string> {
  for (const candidate of templateCandidates()) {
    if (await fsAdapter.exists(candidate)) {
      return candidate;
    }
  }
  throw setupError({
    exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
    code: "s10_template_missing",
    publicMessage: "Service unit template is missing in this installer release.",
    nextAction: "Use an installer release that includes templates/systemd/agent-factory.service.",
    stage: "S10"
  });
}

function m2EvidencePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "m2-security-evidence.json");
}

function baselineEvidencePath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "s09-baseline-evidence.json");
}

function manifestPath(config: SetupConfig): string {
  return path.join(config.paths.application_dir, "deployment-manifest.json");
}

function serviceReleasePath(config: SetupConfig): string {
  return path.join(SERVICE_RELEASE_ROOT, config.release.source_commit);
}

function serviceDbPath(): string {
  return path.join(SERVICE_DATA_ROOT, "state", "factory.sqlite3");
}

function serviceAuthPath(): string {
  return path.join(SERVICE_DATA_ROOT, "auth");
}

function serviceStatePath(): string {
  return path.join(SERVICE_DATA_ROOT, "state");
}

function serviceWorkPath(): string {
  return path.join(SERVICE_DATA_ROOT, "work");
}

function resolveCommandArgv(argv: string[], releaseRoot: string, config: SetupConfig): string[] {
  const [binaryRaw, ...argsRaw] = argv;
  if (binaryRaw === undefined || binaryRaw.length === 0) {
    return [];
  }
  const binary = binaryRaw === "node"
    ? path.join(config.paths.setup_node_dir, "bin", "node")
    : binaryRaw.startsWith("/")
      ? binaryRaw
      : path.join(releaseRoot, binaryRaw);
  const args = argsRaw.map((entry) => (
    entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".ts")
      ? path.join(releaseRoot, entry)
      : entry
  ));
  return [binary, ...args];
}

function findStopCommand(commands: ApplicationManifestData["commands"]): string[] | null {
  const candidates = [
    commands.app_stop,
    (commands as Record<string, string[] | undefined>).app_stop_all,
    commands.runner_stop
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function hasM2GuidePrs(evidence: M2SecurityEvidence): boolean {
  const normalized = new Set(evidence.guide_prs.map((value) => value.trim().toUpperCase()));
  return REQUIRED_M2_PRS.every((value) => normalized.has(value));
}

async function readManifest(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<ApplicationManifestData | null> {
  const targetPath = manifestPath(config);
  if (!(await fsAdapter.exists(targetPath))) {
    return null;
  }
  const parsed = JSON.parse(await fsAdapter.readText(targetPath));
  const validation = validateContractSchema("application-manifest", parsed);
  if (!validation.ok) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: "Provide reviewed M1 deployment-manifest with real service commands and rerun S10.",
      stage: "S10",
      evidenceRef: validation.errors.join(";")
    });
  }
  return parsed as ApplicationManifestData;
}

function validateServiceCapabilities(manifest: ApplicationManifestData): {
  missingCapabilities: string[];
  missingCommands: string[];
} {
  const requiredCapabilities = [
    "app-recover",
    "app-serve",
    "app-pause",
    "app-stop",
    "app-migrate",
    "app-status"
  ];
  const capabilitySet = new Set(manifest.capabilities);
  const missingCapabilities = requiredCapabilities.filter((item) => !capabilitySet.has(item));

  const missingCommands: string[] = [];
  if (!Array.isArray(manifest.commands.app_recover) || manifest.commands.app_recover.length === 0) {
    missingCommands.push("app_recover");
  }
  if (!Array.isArray(manifest.commands.app_serve) || manifest.commands.app_serve.length === 0) {
    missingCommands.push("app_serve");
  }
  if (!Array.isArray(manifest.commands.app_pause) || manifest.commands.app_pause.length === 0) {
    missingCommands.push("app_pause");
  }
  if (!Array.isArray(manifest.commands.app_migrate) || manifest.commands.app_migrate.length === 0) {
    missingCommands.push("app_migrate");
  }
  if (!Array.isArray(manifest.commands.app_status) || manifest.commands.app_status.length === 0) {
    missingCommands.push("app_status");
  }
  if (findStopCommand(manifest.commands) === null) {
    missingCommands.push("app_stop|app_stop_all|runner_stop");
  }
  return { missingCapabilities, missingCommands };
}

async function readM2Evidence(fsAdapter: FilesystemAdapter, config: SetupConfig): Promise<M2SecurityEvidence | null> {
  const targetPath = m2EvidencePath(config);
  if (!(await fsAdapter.exists(targetPath))) {
    return null;
  }
  const parsed = JSON.parse(await fsAdapter.readText(targetPath)) as M2SecurityEvidence;
  if (parsed.schema_version !== 1) {
    return null;
  }
  if (parsed.status !== "verified") {
    return null;
  }
  if (!Array.isArray(parsed.guide_prs) || !Array.isArray(parsed.evidence_refs)) {
    return null;
  }
  if (typeof parsed.provenance !== "string" || parsed.provenance.trim().length === 0) {
    return null;
  }
  return parsed;
}

function ensureM2Evidence(manifest: ApplicationManifestData, evidence: M2SecurityEvidence | null): void {
  if (evidence === null) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: "Provide setup_state/m2-security-evidence.json with verified M2 reports (guide PR8/PR9/PR11) and rerun S10.",
      stage: "S10",
      evidenceRef: "m2-security-evidence.json"
    });
  }
  if (!hasM2GuidePrs(evidence)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: "M2 evidence must reference guide PR8/PR9/PR11 status. Update m2-security-evidence.json and rerun S10.",
      stage: "S10",
      evidenceRef: "m2-security-evidence.json"
    });
  }
  const refs = new Set(evidence.evidence_refs);
  const hasManifestLinkedEvidence = manifest.security_evidence_refs.some((entry) => refs.has(entry));
  if (!hasManifestLinkedEvidence) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: "M2 evidence must prove reviewed reports, not filenames only; link verified refs from deployment-manifest security_evidence_refs.",
      stage: "S10",
      evidenceRef: "deployment-manifest.json"
    });
  }
}

function ensureProjectBaselineProvenance(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s10_provenance_unknown",
      publicMessage: "S09 baseline provenance is unknown; S10 service admission is blocked.",
      nextAction: "Provide reviewed baseline evidence with owner provenance mapping and rerun S10.",
      stage: "S10",
      evidenceRef: "s09-baseline-evidence.json"
    });
  }
  const record = value as Record<string, unknown>;
  const ciResult = record.ci_result;
  if (ciResult !== "pass") {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s10_baseline_not_passed",
      publicMessage: "Baseline CI evidence is not pass; S10 service admission is blocked.",
      nextAction: "Resolve baseline CI and update S09 evidence before running S10.",
      stage: "S10",
      evidenceRef: "s09-baseline-evidence.json"
    });
  }
  const provenance = record.provenance;
  if (typeof provenance !== "string" || provenance.trim().length === 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s10_provenance_unknown",
      publicMessage: "S09 baseline provenance is unknown; S10 service admission is blocked.",
      nextAction: "Record explicit provenance mapping in S09 baseline evidence and rerun S10.",
      stage: "S10",
      evidenceRef: "s09-baseline-evidence.json"
    });
  }
}

function shellEscapeArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderCommand(argv: string[]): string {
  return argv.map(shellEscapeArg).join(" ");
}

async function readTemplate(fsAdapter: FilesystemAdapter): Promise<string> {
  const targetPath = await resolveTemplatePath(fsAdapter);
  return fsAdapter.readText(targetPath);
}

async function snapshot(
  fsAdapter: FilesystemAdapter,
  systemd: SystemdAdapter,
  config: SetupConfig
): Promise<ServiceSnapshot> {
  const manifest = await readManifest(fsAdapter, config);
  const capabilityChecks = manifest === null
    ? {
        requiredCapabilitiesPresent: false,
        requiredCommandsPresent: false,
        missingCapabilities: ["manifest_missing"],
        missingCommands: ["manifest_missing"]
      }
    : (() => {
        const validation = validateServiceCapabilities(manifest);
        return {
          requiredCapabilitiesPresent: validation.missingCapabilities.length === 0,
          requiredCommandsPresent: validation.missingCommands.length === 0,
          missingCapabilities: validation.missingCapabilities,
          missingCommands: validation.missingCommands
        };
      })();

  const m2Evidence = await readM2Evidence(fsAdapter, config);
  const baselinePath = baselineEvidencePath(config);
  if (!(await fsAdapter.exists(baselinePath))) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s10_missing_s09_evidence",
      publicMessage: "S10 requires S09 baseline evidence before service admission.",
      nextAction: "Run S09 and provide reviewed baseline evidence with provenance.",
      stage: "S10",
      evidenceRef: baselinePath
    });
  }
  ensureProjectBaselineProvenance(JSON.parse(await fsAdapter.readText(baselinePath)));

  const unit = await systemd.inspectUnit(SERVICE_UNIT_NAME);
  const releasePath = serviceReleasePath(config);
  const releasePrepared = await systemd.pathExists(releasePath);

  let pausedStateConfirmed = false;
  if (manifest !== null && capabilityChecks.requiredCommandsPresent && unit.active) {
    const statusArgv = resolveCommandArgv(manifest.commands.app_status ?? [], releasePath, config);
    const statusResult = await systemd.runAppCommand({
      argv: statusArgv,
      cwd: releasePath,
      env: {
        FACTORY_STATE: serviceStatePath(),
        FACTORY_AUTH: serviceAuthPath(),
        FACTORY_WORK: serviceWorkPath()
      },
      timeoutMs: OBSERVE_TIMEOUT_MS
    });
    pausedStateConfirmed = statusResult.exitCode === 0 && /paused/i.test(statusResult.stdout);
  }

  return {
    manifestAvailable: manifest !== null,
    manifestValid: manifest !== null,
    capabilityChecks,
    m2EvidencePresent: m2Evidence !== null,
    m2EvidenceVerified: m2Evidence?.status === "verified",
    m2GuidePrsPresent: m2Evidence !== null && hasM2GuidePrs(m2Evidence),
    releasePathPrepared: releasePrepared,
    serviceUnitExists: unit.exists,
    serviceEnabled: unit.enabled,
    serviceActive: unit.active,
    pausedStateConfirmed,
    evidenceRef: m2EvidencePath(config)
  };
}

function statusFromSnapshot(data: ServiceSnapshot): StageObservation["status"] {
  if (!data.manifestAvailable || !data.manifestValid) {
    return "blocked";
  }
  if (!data.capabilityChecks.requiredCapabilitiesPresent || !data.capabilityChecks.requiredCommandsPresent) {
    return "blocked";
  }
  if (!data.m2EvidencePresent || !data.m2EvidenceVerified || !data.m2GuidePrsPresent) {
    return "blocked";
  }
  if (data.serviceUnitExists && data.serviceEnabled && data.serviceActive && data.pausedStateConfirmed) {
    return "verified";
  }
  return "planned";
}

function checksFromSnapshot(data: ServiceSnapshot): Record<string, string | number | boolean> {
  return {
    s10_manifest_available: data.manifestAvailable,
    s10_manifest_valid: data.manifestValid,
    s10_required_capabilities_present: data.capabilityChecks.requiredCapabilitiesPresent,
    s10_required_commands_present: data.capabilityChecks.requiredCommandsPresent,
    s10_m2_evidence_present: data.m2EvidencePresent,
    s10_m2_evidence_verified: data.m2EvidenceVerified,
    s10_m2_guide_prs_present: data.m2GuidePrsPresent,
    s10_release_path_prepared: data.releasePathPrepared,
    s10_service_unit_exists: data.serviceUnitExists,
    s10_service_enabled: data.serviceEnabled,
    s10_service_active: data.serviceActive,
    s10_service_paused_confirmed: data.pausedStateConfirmed,
    s10_missing_capabilities: data.capabilityChecks.missingCapabilities.join(","),
    s10_missing_commands: data.capabilityChecks.missingCommands.join(",")
  };
}

function versionsFromConfig(config: SetupConfig): Record<string, string> {
  return {
    s10_release_commit: config.release.source_commit,
    s10_release_path: serviceReleasePath(config),
    s10_service_unit_name: SERVICE_UNIT_NAME
  };
}

function requiredCapabilitiesForS10(): CapabilityName[] {
  return ["app-recover", "app-serve", "app-pause", "app-stop", "app-migrate", "app-status"];
}

function requiredServiceCommands(manifest: ApplicationManifestData, config: SetupConfig): ResolvedServiceCommands {
  const stopRaw = findStopCommand(manifest.commands);
  if (
    !Array.isArray(manifest.commands.app_recover)
    || !Array.isArray(manifest.commands.app_serve)
    || !Array.isArray(manifest.commands.app_pause)
    || !Array.isArray(manifest.commands.app_migrate)
    || !Array.isArray(manifest.commands.app_status)
    || stopRaw === null
  ) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: "Provide real recover/serve/pause/stop/migrate/status commands in M1 manifest and rerun S10.",
      stage: "S10"
    });
  }
  const releaseRoot = serviceReleasePath(config);
  return {
    recover: resolveCommandArgv(manifest.commands.app_recover, releaseRoot, config),
    serve: resolveCommandArgv(manifest.commands.app_serve, releaseRoot, config),
    pause: resolveCommandArgv(manifest.commands.app_pause, releaseRoot, config),
    stop: resolveCommandArgv(stopRaw, releaseRoot, config),
    migrate: resolveCommandArgv(manifest.commands.app_migrate, releaseRoot, config),
    status: resolveCommandArgv(manifest.commands.app_status, releaseRoot, config)
  };
}

function environmentForService(): Record<string, string> {
  return {
    FACTORY_STATE: serviceStatePath(),
    FACTORY_AUTH: serviceAuthPath(),
    FACTORY_WORK: serviceWorkPath(),
    FACTORY_START_PAUSED: "1"
  };
}

function renderUnitTemplate(
  template: string,
  config: SetupConfig,
  commands: ResolvedServiceCommands
): string {
  const replacements: Record<string, string> = {
    "{{USER}}": config.host.expected_user,
    "{{WORKING_DIR}}": serviceReleasePath(config),
    "{{FACTORY_STATE}}": serviceStatePath(),
    "{{FACTORY_AUTH}}": serviceAuthPath(),
    "{{FACTORY_WORK}}": serviceWorkPath(),
    "{{EXEC_START_PRE}}": renderCommand(commands.recover),
    "{{EXEC_START}}": renderCommand(commands.serve),
    "{{EXEC_STOP}}": renderCommand(commands.stop),
    "{{EXEC_RELOAD}}": renderCommand(commands.pause)
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

function backupPath(config: SetupConfig): string {
  return path.join(config.paths.setup_state_dir, "backups", `s10-${config.release.source_commit}.sqlite3`);
}

async function ensureS10Readiness(fsAdapter: FilesystemAdapter, config: SetupConfig, manifest: ApplicationManifestData): Promise<void> {
  const checks = validateServiceCapabilities(manifest);
  if (checks.missingCapabilities.length > 0 || checks.missingCommands.length > 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "capability_missing",
      publicMessage: "blocked: capability_missing",
      nextAction: `Provide M1 app capabilities/commands (missing caps: ${checks.missingCapabilities.join(",") || "none"}; missing commands: ${checks.missingCommands.join(",") || "none"}) and rerun S10.`,
      stage: "S10",
      evidenceRef: manifestPath(config)
    });
  }
  const evidence = await readM2Evidence(fsAdapter, config);
  ensureM2Evidence(manifest, evidence);
}

async function runCommandStrict(
  adapter: SystemdAdapter,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  code: string,
  message: string
): Promise<AppCommandResult> {
  const result = await adapter.runAppCommand({
    argv,
    cwd,
    env,
    timeoutMs
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code,
      publicMessage: message,
      nextAction: "Review application command stderr and rerun S10 with a fresh plan.",
      stage: "S10",
      evidenceRef: result.stderr.slice(0, 512)
    });
  }
  return result;
}

async function rollbackService(
  adapter: SystemdAdapter,
  commands: ResolvedServiceCommands,
  didMigrate: boolean,
  dbBackupPath: string,
  backupCreated: boolean
): Promise<void> {
  await adapter.stopUnit(SERVICE_UNIT_NAME);
  if (didMigrate && backupCreated) {
    await adapter.restoreFile(dbBackupPath, serviceDbPath());
  }
  await adapter.runAppCommand({
    argv: commands.recover,
    cwd: path.dirname(commands.recover[0] ?? "/"),
    env: environmentForService(),
    timeoutMs: OBSERVE_TIMEOUT_MS
  });
}

export function createServiceStage(
  fsAdapter: FilesystemAdapter,
  systemdAdapter: SystemdAdapter
): StageModule {
  return {
    id: "S10",
    dependencies: ["S09"],
    supportedProfiles: ["service"],
    optional: false,
    requiredCapabilities: requiredCapabilitiesForS10(),
    async observe(ctx: StageContext): Promise<StageObservation> {
      const current = await snapshot(fsAdapter, systemdAdapter, ctx.config);
      return {
        stageId: "S10",
        status: statusFromSnapshot(current),
        checks: checksFromSnapshot(current),
        versions: versionsFromConfig(ctx.config),
        observedAt: new Date().toISOString()
      };
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;
      if (config.profile !== "service") {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s10_service_profile_required",
          publicMessage: "S10 is available only for service profile.",
          nextAction: "Run init with --profile service and regenerate the plan.",
          stage: "S10"
        });
      }
      const operations: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s10-prepare-service-${config.release.source_commit.slice(0, 12)}`,
              stageId: "S10",
              kind: "mutate",
              resourceId: "service-layout-and-unit",
              risk: "high",
              gateIds: ["s10-db-migration-approved", "s10-service-enable-approved"],
              preconditions: [
                `s10_release_commit:${config.release.source_commit}`,
                `s10_manifest_path:${manifestPath(config)}`,
                `s10_m2_evidence_path:${m2EvidencePath(config)}`
              ],
              sideEffects: [
                "prepare /opt versioned release and /var/lib service data paths",
                "pause app, create paired DB backup, run existing app migrator",
                "install+enable service unit and start in paused mode"
              ],
              timeoutSec: 300,
              retryable: false
            }
          ];
      return {
        stageId: "S10",
        optional: false,
        requiredCapabilities: requiredCapabilitiesForS10(),
        operations,
        requiredGates: operations.length === 0 ? [] : ["s10-db-migration-approved", "s10-service-enable-approved"]
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const config = ctx.config;
      const manifest = await readManifest(fsAdapter, config);
      if (manifest === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "capability_missing",
          publicMessage: "blocked: capability_missing",
          nextAction: "Provide reviewed M1 deployment-manifest.json with real service commands and rerun S10.",
          stage: "S10"
        });
      }
      await ensureS10Readiness(fsAdapter, config, manifest);
      const commands = requiredServiceCommands(manifest, config);
      const env = environmentForService();
      const releasePath = serviceReleasePath(config);
      const dbPath = serviceDbPath();
      const dbBackupPath = backupPath(config);
      const operationId = approvedPlan.operations[0]?.id ?? `s10-apply-${ctx.installationId}`;

      let migrationAttempted = false;
      let migrationDone = false;
      let backupCreated = false;
      try {
        await systemdAdapter.ensureDirectory(SERVICE_RELEASE_ROOT, "root", "root", "0755");
        await systemdAdapter.ensureDirectory(SERVICE_DATA_ROOT, "root", "root", "0755");
        await systemdAdapter.ensureDirectory(serviceStatePath(), config.host.expected_user, config.host.expected_user, "0700");
        await systemdAdapter.ensureDirectory(serviceAuthPath(), config.host.expected_user, config.host.expected_user, "0700");
        await systemdAdapter.ensureDirectory(serviceWorkPath(), config.host.expected_user, config.host.expected_user, "0700");
        await systemdAdapter.syncRelease(config.paths.application_dir, releasePath);

        await runCommandStrict(
          systemdAdapter,
          commands.pause,
          releasePath,
          env,
          OBSERVE_TIMEOUT_MS,
          "s10_pause_failed",
          "Pause command failed before migration."
        );

        if (await systemdAdapter.pathExists(dbPath)) {
          await systemdAdapter.backupFile(dbPath, dbBackupPath);
          backupCreated = true;
        }

        migrationAttempted = true;
        await runCommandStrict(
          systemdAdapter,
          commands.migrate,
          releasePath,
          {
            ...env,
            FACTORY_MIGRATION_MODE: "service-upgrade"
          },
          MIGRATION_TIMEOUT_MS,
          "s10_migration_failed",
          "Application migration command failed."
        );
        migrationDone = true;

        const template = await readTemplate(fsAdapter);
        const unitText = renderUnitTemplate(template, config, commands);
        const renderedPath = path.join(config.paths.setup_state_dir, "agent-factory.service");
        await fsAdapter.writeText(renderedPath, unitText, 0o600);
        await fsAdapter.fsyncFile(renderedPath);
        await fsAdapter.fsyncDir(path.dirname(renderedPath));

        await systemdAdapter.verifyUnitFile(renderedPath);
        await systemdAdapter.installUnit(renderedPath, SERVICE_UNIT_TARGET_PATH);
        await systemdAdapter.daemonReload();
        await systemdAdapter.verifyUnitFile(SERVICE_UNIT_TARGET_PATH);
        await systemdAdapter.enableUnit(SERVICE_UNIT_NAME);
        await systemdAdapter.startUnit(SERVICE_UNIT_NAME);

        const statusResult = await runCommandStrict(
          systemdAdapter,
          commands.status,
          releasePath,
          env,
          OBSERVE_TIMEOUT_MS,
          "s10_status_probe_failed",
          "Service status probe failed after start."
        );
        if (!/paused/i.test(statusResult.stdout)) {
          throw setupError({
            exitCode: ExitCode.OperationOrVerificationFailed,
            code: "s10_service_not_paused",
            publicMessage: "Service started without paused state; automatic unpause is forbidden.",
            nextAction: "Inspect app service mode and enforce paused startup before retrying S10.",
            stage: "S10"
          });
        }
      } catch (error) {
        try {
          await rollbackService(systemdAdapter, commands, migrationAttempted || migrationDone, dbBackupPath, backupCreated);
        } catch (rollbackError) {
          const reason = rollbackError instanceof Error ? rollbackError.message : "unknown";
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "s10_rollback_failed",
            publicMessage: "S10 failed and rollback was not fully completed.",
            nextAction: "Run manual stop/restore/recover and then 'factory-setup recover --config PATH'.",
            stage: "S10",
            evidenceRef: reason
          });
        }
        throw error;
      }

      return [
        {
          operationId,
          stageId: "S10",
          resourceId: "service-layout-and-unit",
          observedAt: new Date().toISOString(),
          checks: {
            release_path_prepared: true,
            db_backup_created: backupCreated,
            migration_applied: migrationDone,
            service_started_paused: true,
            service_unpause_automatic: false
          },
          versions: {
            source_commit: config.release.source_commit,
            unit_path: SERVICE_UNIT_TARGET_PATH
          },
          artifacts: [
            SERVICE_UNIT_TARGET_PATH,
            backupCreated ? dbBackupPath : "no-db-backup-created"
          ]
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const current = await snapshot(fsAdapter, systemdAdapter, ctx.config);
      if (statusFromSnapshot(current) !== "verified") {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s10_not_verified",
          publicMessage: "S10 service resources are not fully verified.",
          nextAction: "Run plan/apply for S10 and resolve blockers before verify.",
          stage: "S10",
          evidenceRef: current.evidenceRef
        });
      }
      return [
        {
          operationId: "s10-verify",
          stageId: "S10",
          resourceId: "service-layout-and-unit",
          observedAt: new Date().toISOString(),
          checks: checksFromSnapshot(current),
          versions: versionsFromConfig(ctx.config),
          artifacts: [SERVICE_UNIT_TARGET_PATH]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
