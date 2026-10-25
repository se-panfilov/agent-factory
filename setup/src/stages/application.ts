import path from "node:path";
import { createHash } from "node:crypto";
import { stableStringify } from "../core/config";
import { assertOfflineCommands } from "../adapters/git";
import { setupError, SetupError } from "../core/errors";
import {
  ExitCode,
  type SetupConfig,
  type StageContext,
  type CapabilityName,
  type StageModule,
  type StageObservation,
  type StagePlan,
  type StageReceipt
} from "../core/types";
import { type ApplicationManifestData, type ApplicationReleaseAdapter, type ExistingCheckoutObservation, type ReleaseInspection } from "../adapters/git";

interface RuntimeSnapshot {
  config: SetupConfig;
  checkout: ExistingCheckoutObservation;
  release: ReleaseInspection;
}

interface ParsedPlanPreconditions {
  archiveSha256: string;
  sourceCommit: string;
  applicationDir: string;
  setupCacheDir: string;
}

function requiredCapabilitiesForProfile(profile: "supervised" | "service"): CapabilityName[] {
  if (profile === "service") {
    return ["app-serve", "app-status", "app-stop", "app-recover", "app-migrate"];
  }
  return ["runner-readonly"];
}

function hasCapabilities(manifest: ApplicationManifestData | null, required: string[]): boolean {
  if (manifest === null) {
    return false;
  }
  const declared = new Set(manifest.capabilities);
  return required.every((capability) => declared.has(capability));
}

function checksFromSnapshot(snapshot: RuntimeSnapshot): Record<string, string | number | boolean> {
  const requiredCapabilities = requiredCapabilitiesForProfile(snapshot.config.profile);
  const manifest = snapshot.release.manifest;
  return {
    archive_exists: snapshot.release.archiveExists,
    archive_sha256_match: snapshot.release.sha256Matches,
    release_manifest_present: snapshot.release.manifestPath !== null,
    release_manifest_valid: snapshot.release.manifestValid,
    release_manifest_source_commit_match:
      manifest !== null && manifest.source_commit === snapshot.config.release.source_commit,
    release_manifest_required_capabilities_present: hasCapabilities(manifest, requiredCapabilities),
    release_archive_entry_count: snapshot.release.entryCount,
    release_archive_has_dockerfile: snapshot.release.hasDockerfile,
    release_archive_has_build_context: snapshot.release.hasBuildContext,
    release_archive_traversal_detected: snapshot.release.traversalEntries.length > 0,
    release_archive_symlink_detected: snapshot.release.symlinkEntries.length > 0,
    release_archive_special_entries_detected: snapshot.release.specialEntries.length > 0,
    existing_checkout_present: snapshot.checkout.exists,
    existing_checkout_git_present: snapshot.checkout.hasGitDir,
    existing_checkout_dirty: snapshot.checkout.dirty,
    existing_checkout_detached_head: snapshot.checkout.detachedHead,
    existing_checkout_remote_allowed:
      snapshot.checkout.originUrl === null
      || snapshot.config.github.repository_allowlist.length === 0
      || snapshot.config.github.repository_allowlist.some((allowed) => snapshot.checkout.originUrl?.includes(allowed)),
    existing_checkout_source_commit_match:
      snapshot.checkout.deployedSourceCommit === null
      || snapshot.checkout.deployedSourceCommit === snapshot.config.release.source_commit
  };
}

function versionsFromSnapshot(snapshot: RuntimeSnapshot): Record<string, string> {
  const manifest = snapshot.release.manifest;
  return {
    release_archive_sha256_actual: snapshot.release.archiveSha256 ?? "absent",
    release_archive_sha256_expected: snapshot.config.release.sha256,
    release_manifest_source_commit: manifest?.source_commit ?? "absent",
    release_expected_source_commit: snapshot.config.release.source_commit,
    existing_checkout_head: snapshot.checkout.headCommit ?? "absent",
    existing_checkout_branch: snapshot.checkout.branch ?? "absent",
    existing_checkout_origin: snapshot.checkout.originUrl ?? "absent",
    release_manifest_path: snapshot.release.manifestPath ?? "absent",
    release_application_version: manifest?.application_version ?? "absent",
    release_manifest_hash: manifest === null ? "absent" : createHash("sha256").update(stableStringify(manifest)).digest("hex")
  };
}

function inferStatus(snapshot: RuntimeSnapshot): StageObservation["status"] {
  const checks = checksFromSnapshot(snapshot);
  if (checks.archive_exists !== true) {
    return "blocked";
  }
  if (checks.archive_sha256_match !== true) {
    return "blocked";
  }
  if (checks.release_manifest_present !== true || checks.release_manifest_valid !== true) {
    return "blocked";
  }
  if (checks.release_manifest_source_commit_match !== true) {
    return "blocked";
  }
  if (checks.release_manifest_required_capabilities_present !== true) {
    return "blocked";
  }
  if (
    checks.release_archive_traversal_detected === true
    || checks.release_archive_symlink_detected === true
    || checks.release_archive_special_entries_detected === true
  ) {
    return "blocked";
  }
  if (checks.existing_checkout_dirty === true) {
    return "drifted";
  }
  if (checks.existing_checkout_remote_allowed !== true) {
    return "drifted";
  }
  if (checks.existing_checkout_source_commit_match !== true) {
    return "drifted";
  }
  if (checks.existing_checkout_present === true && checks.existing_checkout_detached_head !== true) {
    return "drifted";
  }
  if (
    checks.existing_checkout_present === true
    && checks.existing_checkout_detached_head === true
  ) {
    return "verified";
  }
  return "planned";
}

function parsePlanPreconditions(plan: StagePlan): ParsedPlanPreconditions {
  let archiveSha256: string | null = null;
  let sourceCommit: string | null = null;
  let applicationDir: string | null = null;
  let setupCacheDir: string | null = null;

  for (const operation of plan.operations) {
    for (const precondition of operation.preconditions) {
      if (precondition.startsWith("s05_archive_sha256:")) {
        archiveSha256 = precondition.slice("s05_archive_sha256:".length);
      } else if (precondition.startsWith("s05_source_commit:")) {
        sourceCommit = precondition.slice("s05_source_commit:".length);
      } else if (precondition.startsWith("s05_application_dir:")) {
        applicationDir = precondition.slice("s05_application_dir:".length);
      } else if (precondition.startsWith("s05_setup_cache_dir:")) {
        setupCacheDir = precondition.slice("s05_setup_cache_dir:".length);
      }
    }
  }

  if (
    archiveSha256 === null
    || sourceCommit === null
    || applicationDir === null
    || setupCacheDir === null
    || archiveSha256.length === 0
    || sourceCommit.length === 0
    || applicationDir.length === 0
    || setupCacheDir.length === 0
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s05_plan_preconditions_missing",
      publicMessage: "S05 plan preconditions are incomplete.",
      nextAction: "Regenerate plan for S05 and re-approve gates.",
      stage: "S05"
    });
  }
  return {
    archiveSha256,
    sourceCommit,
    applicationDir,
    setupCacheDir
  };
}

function validateBlockedSnapshot(snapshot: RuntimeSnapshot): void {
  const checks = checksFromSnapshot(snapshot);
  if (checks.archive_exists !== true) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s05_m0_release_missing",
      publicMessage: "M0 application release archive is missing; S05 is blocked.",
      nextAction: "Provide reviewed owner-exported M0 release archive and rerun plan/apply.",
      stage: "S05",
      evidenceRef: snapshot.config.release.archive_path
    });
  }
  if (checks.archive_sha256_match !== true) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s05_release_hash_mismatch",
      publicMessage: "Release archive hash does not match reviewed pin.",
      nextAction: "Replace archive with reviewed artifact matching release.sha256.",
      stage: "S05"
    });
  }
  if (checks.release_manifest_present !== true || checks.release_manifest_valid !== true) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s05_deployment_manifest_invalid",
      publicMessage: "Release deployment-manifest.json is missing or invalid.",
      nextAction: "Provide reviewed M0/M1 release with valid deployment-manifest.json.",
      stage: "S05",
      evidenceRef: snapshot.release.manifestErrors.join(",")
    });
  }
  if (checks.release_manifest_source_commit_match !== true) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s05_source_commit_mismatch",
      publicMessage: "Manifest source_commit does not match configured release.source_commit.",
      nextAction: "Update config.release.source_commit or provide matching reviewed artifact.",
      stage: "S05"
    });
  }
  if (checks.release_manifest_required_capabilities_present !== true) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s05_required_capabilities_missing",
      publicMessage: "Release manifest does not provide required capabilities for S05 profile.",
      nextAction: "Provide reviewed M0 (supervised) or M1 (service) release manifest.",
      stage: "S05"
    });
  }
  if (checks.release_archive_traversal_detected === true) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s05_archive_path_traversal",
      publicMessage: "Release archive contains traversal paths.",
      nextAction: "Regenerate trusted archive without absolute or parent-relative paths.",
      stage: "S05",
      evidenceRef: snapshot.release.traversalEntries.slice(0, 5).join(",")
    });
  }
  if (checks.release_archive_symlink_detected === true) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s05_archive_symlink_forbidden",
      publicMessage: "Release archive contains symlink/hardlink entries, extraction is blocked.",
      nextAction: "Regenerate trusted archive with regular files/directories only.",
      stage: "S05",
      evidenceRef: snapshot.release.symlinkEntries.slice(0, 5).join(",")
    });
  }
  if (checks.release_archive_special_entries_detected === true) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s05_archive_special_entry_forbidden",
      publicMessage: "Release archive contains unsupported special entries.",
      nextAction: "Regenerate trusted archive without device/FIFO/special entries.",
      stage: "S05",
      evidenceRef: snapshot.release.specialEntries.slice(0, 5).join(",")
    });
  }
  if (checks.existing_checkout_dirty === true) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s05_existing_checkout_dirty",
      publicMessage: "Existing application checkout is dirty; destructive reset is forbidden.",
      nextAction: "Clean or archive existing checkout manually, then rerun S05.",
      stage: "S05"
    });
  }
  if (checks.existing_checkout_remote_allowed !== true) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s05_existing_checkout_remote_mismatch",
      publicMessage: "Existing checkout origin is outside repository allowlist.",
      nextAction: "Recreate checkout from allowed remote or adjust allowlist with owner review.",
      stage: "S05"
    });
  }
  if (checks.existing_checkout_present === true && checks.existing_checkout_detached_head !== true) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s05_existing_checkout_branch_mismatch",
      publicMessage: "Existing checkout is on a branch; S05 requires immutable release checkout.",
      nextAction: "Prepare clean detached checkout manually; installer will not reset branches.",
      stage: "S05"
    });
  }
  if (checks.existing_checkout_source_commit_match !== true) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s05_existing_checkout_version_mismatch",
      publicMessage: "Existing checkout version differs from planned release commit.",
      nextAction: "Move existing checkout aside manually and rerun S05 for fresh deploy.",
      stage: "S05"
    });
  }
}

function releaseRootFromManifestPath(stagingRoot: string, manifestPath: string | null): string {
  if (manifestPath === null || manifestPath.length === 0) {
    return stagingRoot;
  }
  const normalized = manifestPath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return stagingRoot;
  }
  return path.join(stagingRoot, ...segments.slice(0, -1));
}

function hasDeployedReleaseProof(ctx: StageContext, manifest: ApplicationManifestData | null): boolean {
  return (ctx.completedOperationReceipts ?? []).some(r => r.stageId === "S05"
    && ["application-checkout", "application-release"].includes(r.resourceId)
    && (r.versions.archive_sha256 ?? r.versions.release_archive_sha256_expected) === ctx.config.release.sha256
    && (r.versions.source_commit ?? r.versions.release_expected_source_commit) === ctx.config.release.source_commit
    && r.artifacts.includes(ctx.config.paths.application_dir)
    && (r.versions.release_manifest_hash === undefined || (manifest !== null && r.versions.release_manifest_hash === createHash("sha256").update(stableStringify(manifest)).digest("hex"))));
}

export function createApplicationStage(adapter: ApplicationReleaseAdapter): StageModule {
  let lastObservation: StageObservation | null = null;

  const snapshot = async (config: SetupConfig): Promise<RuntimeSnapshot> => {
    const [checkout, release] = await Promise.all([
      adapter.observeExistingCheckout(config),
      adapter.inspectArchive(config)
    ]);
    return {
      config,
      checkout,
      release
    };
  };

  const checkDeployment = async (ctx: StageContext, current: RuntimeSnapshot): Promise<ApplicationManifestData> => {
    validateBlockedSnapshot(current);
    if (!hasDeployedReleaseProof(ctx, current.release.manifest)) throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence, code: "s05_release_trust_evidence_missing",
      publicMessage: "Executable probes require matching journal-bound reviewed deployment evidence.", nextAction: "Review a new S05 plan before running executable probes.", stage: "S05" });
    if (!current.checkout.exists || current.checkout.deployedSourceCommit !== ctx.config.release.source_commit) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s05_deployed_commit_mismatch",
      publicMessage: "The trusted deployment is absent or has a different commit.", nextAction: "Reconcile deployment ownership and release identity.", stage: "S05" });
    const manifest = current.release.manifest!;
    assertOfflineCommands(manifest, ctx.config);
    let mismatches: string[];
    try { mismatches = await adapter.verifyContentHashes(ctx.config.paths.application_dir, manifest.content_hashes); }
    catch { mismatches = ["content-read-failed"]; }
    if (mismatches.length > 0) throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code: "s05_deployed_integrity_failed",
      publicMessage: "Current deployment content is missing, unsafe, unreadable or differs from the reviewed release.", nextAction: "Restore reviewed content before invoking any application command.", stage: "S05", evidenceRef: ctx.config.paths.application_dir });
    return manifest;
  };
  const checkedProbes = async (ctx: StageContext, current: RuntimeSnapshot) => {
    const manifest = await checkDeployment(ctx, current);
    let probes: Awaited<ReturnType<ApplicationReleaseAdapter["probeCommands"]>>;
    try { probes = await adapter.probeCommands(ctx.config.paths.application_dir, manifest, ctx.config); }
    catch (error) {
      if (error instanceof SetupError) throw error;
      throw setupError({ exitCode: ExitCode.OperationOrVerificationFailed, code: "s05_runner_probe_error",
        publicMessage: "Integrity-checked offline command could not complete within its execution contract.", nextAction: "Inspect the reviewed command/runtime availability and bounded timeout result.", stage: "S05" });
    }
    if (!probes.runnerVerifyHelpOk || !probes.runnerStopHelpOk) throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence, code: "s05_runner_probe_failed",
      publicMessage: "Integrity-checked application failed mandatory offline command probes.", nextAction: "Repair the reviewed release's offline commands.", stage: "S05" });
    return probes;
  };

  return {
    id: "S05",
    dependencies: ["S04"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const observedSnapshot = await snapshot(ctx.config);
      let runnable = false;
      if (inferStatus(observedSnapshot) === "verified" && observedSnapshot.release.manifest !== null && hasDeployedReleaseProof(ctx, observedSnapshot.release.manifest)) {
        await checkedProbes(ctx, observedSnapshot);
        runnable = true;
      }
      const observation: StageObservation = {
        stageId: "S05",
        status: inferStatus(observedSnapshot) === "verified" && !runnable ? (hasDeployedReleaseProof(ctx, observedSnapshot.release.manifest) ? "blocked" : "planned") : inferStatus(observedSnapshot),
        checks: { ...checksFromSnapshot(observedSnapshot), deployed_content_and_commands_verified: runnable },
        versions: versionsFromSnapshot(observedSnapshot),
        observedAt: new Date().toISOString()
      };
      lastObservation = observation;
      return observation;
    },
    async observePolicy(ctx) {
      const current = await snapshot(ctx.config);
      validateBlockedSnapshot(current);
      if (current.checkout.exists && current.release.manifest !== null) {
        const mismatches = await adapter.verifyContentHashes(ctx.config.paths.application_dir, current.release.manifest.content_hashes);
        if (mismatches.length > 0) throw setupError({exitCode:ExitCode.SecurityBoundaryViolation,code:"s05_deployed_integrity_failed",
          publicMessage:"Current deployment integrity failed during read-only policy admission.",nextAction:"Restore reviewed deployment bytes before executable probes.",stage:"S05"});
      }
      return {stageId:"S05",status:"planned",checks:checksFromSnapshot(current),versions:versionsFromSnapshot(current),observedAt:new Date().toISOString()};
    },
    policyInputs(observed) {
      const {deployed_content_and_commands_verified: _executableProof, ...checks}=observed.checks;
      return {checks, versions:observed.versions};
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const config = desired as SetupConfig;

      const operations: StagePlan["operations"] = observed.status === "verified"
        ? []
        : [
            {
              id: `s05-extract-release-${config.release.source_commit.slice(0, 12)}`,
              stageId: "S05",
              kind: "mutate",
              resourceId: "application-release-staging",
              risk: "high",
              gateIds: ["s05-application-release-reviewed", "s05-source-commit-reviewed", "s05-dockerfile-build-reviewed"],
              preconditions: [
                `s05_archive_sha256:${config.release.sha256}`,
                `s05_source_commit:${config.release.source_commit}`,
                `s05_application_dir:${config.paths.application_dir}`,
                `s05_setup_cache_dir:${config.paths.setup_cache_dir}`
              ],
              sideEffects: [
                "extract reviewed application release into isolated staging",
                "extract and hash-verify reviewed archive again in operation-owned staging",
                "materialize immutable application checkout without reset"
              ],
              timeoutSec: 300,
              retryable: false
            },
            {
              id: `s05-materialize-checkout-${config.release.source_commit.slice(0, 12)}`,
              stageId: "S05",
              kind: "mutate",
              resourceId: "application-checkout",
              risk: "high",
              gateIds: ["s05-application-release-reviewed", "s05-source-commit-reviewed", "s05-dockerfile-build-reviewed"],
              preconditions: [
                `s05_archive_sha256:${config.release.sha256}`,
                `s05_source_commit:${config.release.source_commit}`,
                `s05_application_dir:${config.paths.application_dir}`,
                `s05_setup_cache_dir:${config.paths.setup_cache_dir}`
              ],
              sideEffects: [
                "extract and hash-verify reviewed archive again in operation-owned staging",
                "materialize immutable application checkout without reset"
              ],
              timeoutSec: 300,
              retryable: false
            },
            {
              id: `s05-probe-release-${config.release.source_commit.slice(0, 12)}`,
              stageId: "S05",
              kind: "observe",
              resourceId: "application-release",
              risk: "medium",
              gateIds: ["s05-application-release-reviewed", "s05-source-commit-reviewed", "s05-dockerfile-build-reviewed"],
              preconditions: [
                `s05_archive_sha256:${config.release.sha256}`,
                `s05_source_commit:${config.release.source_commit}`,
                `s05_application_dir:${config.paths.application_dir}`,
                `s05_setup_cache_dir:${config.paths.setup_cache_dir}`
              ],
              sideEffects: [
                "probe offline runner commands from deployed release without live credentials"
              ],
              timeoutSec: 120,
              retryable: false
            }
          ];

      const gates = operations.flatMap((operation) => operation.gateIds);
      return {
        stageId: "S05",
        optional: false,
        requiredCapabilities: [],
        operations,
        requiredGates: [...new Set(gates)]
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const config = ctx.config;
      if (approvedPlan.operations.length === 0) {
        return [];
      }
      const parsed = parsePlanPreconditions(approvedPlan);
      if (parsed.archiveSha256 !== config.release.sha256 || parsed.sourceCommit !== config.release.source_commit) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s05_plan_drifted",
          publicMessage: "S05 plan preconditions drifted from current release config.",
          nextAction: "Regenerate plan and re-approve gates for S05.",
          stage: "S05"
        });
      }

      const observedSnapshot = await snapshot(config);
      validateBlockedSnapshot(observedSnapshot);

      const manifest = observedSnapshot.release.manifest;
      if (manifest === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s05_manifest_unavailable",
          publicMessage: "Release manifest is unavailable after extraction.",
          nextAction: "Regenerate reviewed archive and rerun S05.",
          stage: "S05"
        });
      }
      const extractAndValidate = async (operationId: string): Promise<{
        releaseRoot: string;
        stagingRoot: string;
      }> => {
        const stagingRoot = path.join(
          config.paths.setup_cache_dir,
          "application-release",
          config.release.source_commit,
          operationId
        );
        await adapter.extractArchive(config, stagingRoot);
        const releaseRoot = releaseRootFromManifestPath(stagingRoot, observedSnapshot.release.manifestPath);
        const mismatches = await adapter.verifyContentHashes(releaseRoot, manifest.content_hashes);
        if (mismatches.length > 0) {
          throw setupError({
            exitCode: ExitCode.SecurityBoundaryViolation,
            code: "s05_content_hash_mismatch",
            publicMessage: "Extracted release content hashes do not match deployment-manifest pins.",
            nextAction: "Replace archive with reviewed artifact and rerun S05.",
            stage: "S05",
            evidenceRef: mismatches.slice(0, 5).join(",")
          });
        }
        return { releaseRoot, stagingRoot };
      };

      const receipts: StageReceipt[] = [];
      for (const operation of approvedPlan.operations) {
        if (operation.id.includes("extract-release")) {
          const extracted = await extractAndValidate(operation.id);
          receipts.push({
            operationId: operation.id,
            stageId: "S05",
            resourceId: operation.resourceId,
            observedAt: new Date().toISOString(),
            checks: {
              archive_extracted: true,
              content_hashes_verified: true
            },
            versions: {
              release_manifest_hash: createHash("sha256").update(stableStringify(manifest)).digest("hex"),
              archive_sha256: config.release.sha256,
              source_commit: config.release.source_commit,
              application_version: manifest.application_version
            },
            artifacts: [extracted.stagingRoot]
          });
          continue;
        }

        if (operation.id.includes("materialize-checkout")) {
          if (observedSnapshot.checkout.exists && observedSnapshot.checkout.deployedSourceCommit === config.release.source_commit
            && (await adapter.verifyContentHashes(parsed.applicationDir, manifest.content_hashes)).length === 0) {
            receipts.push({ operationId: operation.id, stageId: "S05", resourceId: operation.resourceId,
              observedAt: new Date().toISOString(), checks: { checkout_materialized: true, content_hashes_verified: true, noop: true },
              versions: versionsFromSnapshot(observedSnapshot), artifacts: [parsed.applicationDir] });
            continue;
          }
          if (observedSnapshot.checkout.hasGitDir && observedSnapshot.checkout.headCommit !== null) {
            const commitExists = await adapter.commitExists(config.paths.application_dir, config.release.source_commit);
            if (!commitExists) {
              throw setupError({
                exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
                code: "s05_source_commit_missing",
                publicMessage: "Configured source commit is absent in existing checkout git history.",
                nextAction: "Fetch reviewed commit manually or redeploy clean checkout.",
                stage: "S05"
              });
            }
          }
          const extracted = await extractAndValidate(operation.id);
          await adapter.materializeRelease(extracted.releaseRoot, parsed.applicationDir);
          receipts.push({
            operationId: operation.id,
            stageId: "S05",
            resourceId: operation.resourceId,
            observedAt: new Date().toISOString(),
            checks: {
              source_commit_verified: true,
              content_hashes_verified: true,
              checkout_materialized: true
            },
            versions: {
              release_manifest_hash: createHash("sha256").update(stableStringify(manifest)).digest("hex"),
              archive_sha256: config.release.sha256,
              source_commit: config.release.source_commit,
              application_version: manifest.application_version
            },
            artifacts: [parsed.applicationDir]
          });
          continue;
        }

        if (operation.id.includes("probe-release")) {
          const probeContext = { ...ctx, completedOperationReceipts: [...(ctx.completedOperationReceipts ?? []), ...receipts] };
          const probes = await checkedProbes(probeContext, await snapshot(config));
          receipts.push({
            operationId: operation.id,
            stageId: "S05",
            resourceId: operation.resourceId,
            observedAt: new Date().toISOString(),
            checks: {
              runner_verify_help_ok: probes.runnerVerifyHelpOk,
              runner_stop_help_ok: probes.runnerStopHelpOk
            },
            versions: {
              release_manifest_hash: createHash("sha256").update(stableStringify(manifest)).digest("hex"),
              archive_sha256: config.release.sha256,
              source_commit: config.release.source_commit,
              application_version: manifest.application_version
            },
            artifacts: [parsed.applicationDir]
          });
          continue;
        }

        throw setupError({
          exitCode: ExitCode.CliOrSchemaError,
          code: "s05_unplanned_operation",
          publicMessage: `S05 received unsupported operation '${operation.id}'.`,
          nextAction: "Regenerate S05 plan with a supported installer release.",
          stage: "S05",
          operationId: operation.id
        });
      }

      return receipts;
    },
    async verifyOperation(ctx, receipt) {
      const current = await snapshot(ctx.config); validateBlockedSnapshot(current);
      const manifest = current.release.manifest;
      let ok = manifest !== null;
      if (receipt.resourceId === "application-release-staging") {
        ok = ok && receipt.artifacts.length === 1 && (await adapter.verifyContentHashes(releaseRootFromManifestPath(receipt.artifacts[0]!, current.release.manifestPath), manifest!.content_hashes)).length === 0;
      } else if (receipt.resourceId === "application-checkout") {
        ok = ok && current.checkout.deployedSourceCommit === ctx.config.release.source_commit
          && (await adapter.verifyContentHashes(ctx.config.paths.application_dir, manifest!.content_hashes)).length === 0;
      } else if (receipt.resourceId === "application-release") {
        await checkDeployment(ctx, current);
        ok = ok && receipt.checks.runner_verify_help_ok === true && receipt.checks.runner_stop_help_ok === true
          && receipt.versions.archive_sha256 === ctx.config.release.sha256 && receipt.versions.source_commit === ctx.config.release.source_commit;
      } else ok = false;
      if (!ok) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s05_operation_postcondition_failed",
        publicMessage: "Release operation postcondition could not be confirmed.", nextAction: "Preserve deployment evidence and repair the reviewed release.", stage: "S05" });
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const observedSnapshot = await snapshot(ctx.config);
      validateBlockedSnapshot(observedSnapshot);
      if (observedSnapshot.checkout.deployedSourceCommit !== ctx.config.release.source_commit) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s05_deployed_commit_mismatch",
          publicMessage: "Deployed source commit differs from expected release commit.",
          nextAction: "Inspect checkout and rerun S05 with a fresh clean target.",
          stage: "S05"
        });
      }
      await checkedProbes(ctx, observedSnapshot);
      return [
        {
          operationId: "s05-verify",
          stageId: "S05",
          resourceId: "application-release",
          observedAt: new Date().toISOString(),
          checks: checksFromSnapshot(observedSnapshot),
          versions: versionsFromSnapshot(observedSnapshot),
          artifacts: [ctx.config.paths.application_dir]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
