import { createHash } from "node:crypto";
import { type AptAdapter, type AptPackagePin, type AptSystemObservation } from "../adapters/apt";
import { ExitCode, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";
import { setupError } from "../core/errors";

const BASE_PACKAGES = [
  "git",
  "curl",
  "ca-certificates",
  "build-essential",
  "tmux"
] as const;

const SERVICE_ONLY_PACKAGES = ["ufw", "sqlite3"] as const;

function requiredPackageNames(profile: "supervised" | "service"): string[] {
  return profile === "service"
    ? [...BASE_PACKAGES, ...SERVICE_ONLY_PACKAGES]
    : [...BASE_PACKAGES];
}

interface PlannedPins {
  pins: AptPackagePin[];
  packageSetHash: string;
}

function packageSetHash(pins: AptPackagePin[]): string {
  const stable = pins
    .map((pin) => `${pin.name}=${pin.version}`)
    .sort((a, b) => a.localeCompare(b))
    .join("|");
  return createHash("sha256").update(stable).digest("hex");
}

function plannedPinsFromObservation(observation: AptSystemObservation): PlannedPins {
  const pins: AptPackagePin[] = [];
  for (const item of observation.packages) {
    if (item.candidateVersion === null) {
      continue;
    }
    pins.push({ name: item.name, version: item.candidateVersion });
  }
  pins.sort((a, b) => a.name.localeCompare(b.name));
  return {
    pins,
    packageSetHash: packageSetHash(pins)
  };
}

function installedHashFromObservation(observation: AptSystemObservation): string {
  const installedPins: AptPackagePin[] = observation.packages
    .filter((item) => item.installedVersion !== null)
    .map((item) => ({ name: item.name, version: item.installedVersion as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return packageSetHash(installedPins);
}

function allPinsInstalled(observation: AptSystemObservation): boolean {
  return observation.packages.every((item) =>
    item.candidateVersion !== null && item.installedVersion === item.candidateVersion
  );
}

function missingCandidates(observation: AptSystemObservation): string[] {
  return observation.packages
    .filter((item) => item.candidateVersion === null)
    .map((item) => item.name);
}

function parsePlanPins(stagePlan: StagePlan): PlannedPins {
  const pinEntries = new Map<string, string>();
  let expectedHash: string | null = null;

  for (const operation of stagePlan.operations) {
    for (const precondition of operation.preconditions) {
      if (precondition.startsWith("apt_pin:")) {
        const payload = precondition.slice("apt_pin:".length);
        const idx = payload.indexOf("=");
        if (idx <= 0) {
          continue;
        }
        const name = payload.slice(0, idx);
        const version = payload.slice(idx + 1);
        pinEntries.set(name, version);
      }
      if (precondition.startsWith("apt_package_set_hash:")) {
        expectedHash = precondition.slice("apt_package_set_hash:".length);
      }
    }
  }

  const pins = [...pinEntries.entries()]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hash = packageSetHash(pins);
  if (expectedHash !== null && expectedHash !== hash) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s02_plan_hash_mismatch",
      publicMessage: "S02 plan pins are inconsistent with declared package-set hash.",
      nextAction: "Regenerate plan and re-approve S02 gates.",
      stage: "S02"
    });
  }

  return {
    pins,
    packageSetHash: hash
  };
}

function checksFromObservation(
  observation: AptSystemObservation,
  planned: PlannedPins,
  profile: "supervised" | "service"
): Record<string, string | number | boolean> {
  return {
    profile,
    metadata_fresh: observation.metadataFresh,
    sudo_available: observation.sudoAvailable,
    dpkg_audit_clean: observation.dpkgAuditClean,
    reboot_required: observation.rebootRequired,
    planned_package_count: planned.pins.length,
    missing_candidate_count: missingCandidates(observation).length,
    installed_matches_plan: allPinsInstalled(observation),
    planned_package_set_hash: planned.packageSetHash,
    installed_package_set_hash: installedHashFromObservation(observation)
  };
}

function versionsFromObservation(observation: AptSystemObservation): Record<string, string> {
  const versions: Record<string, string> = {};
  if (observation.metadataUpdatedAt !== null) {
    versions.apt_metadata_updated_at = observation.metadataUpdatedAt;
  }
  for (const item of observation.packages) {
    if (item.candidateVersion !== null) {
      versions[`candidate_${item.name}`] = item.candidateVersion;
    }
    if (item.installedVersion !== null) {
      versions[`installed_${item.name}`] = item.installedVersion;
    }
  }
  return versions;
}

function operationPreconditions(planned: PlannedPins): string[] {
  const preconditions = [`apt_package_set_hash:${planned.packageSetHash}`];
  for (const pin of planned.pins) {
    preconditions.push(`apt_pin:${pin.name}=${pin.version}`);
  }
  return preconditions;
}

function operationId(kind: "update" | "simulate" | "install", planned: PlannedPins): string {
  return `s02-apt-${kind}-${planned.packageSetHash.slice(0, 12)}`;
}

export function createSystemStage(aptAdapter: AptAdapter): StageModule {
  let lastObservation: StageObservation | null = null;

  return {
    id: "S02",
    dependencies: ["S01"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const packageNames = requiredPackageNames(ctx.profile);
      const aptObservation = await aptAdapter.observe(packageNames);
      const planned = plannedPinsFromObservation(aptObservation);

      const missing = missingCandidates(aptObservation);
      const blocked = !aptObservation.sudoAvailable || missing.length > 0 || !aptObservation.dpkgAuditClean;
      const status = blocked
        ? "blocked"
        : aptObservation.rebootRequired
          ? "awaiting_manual"
          : allPinsInstalled(aptObservation)
            ? "verified"
            : "planned";

      const checks = checksFromObservation(
        aptObservation,
        planned,
        ctx.profile
      );

      if (missing.length > 0) {
        checks.missing_candidates = missing.join(",");
      }
      if (!aptObservation.dpkgAuditClean) {
        checks.dpkg_audit_summary = aptObservation.dpkgAuditOutput.slice(0, 512);
      }

      const observation: StageObservation = {
        stageId: "S02",
        status,
        checks,
        versions: versionsFromObservation(aptObservation),
        observedAt: new Date().toISOString()
      };
      lastObservation = observation;
      return observation;
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const profile = (desired as { profile?: "supervised" | "service" }).profile === "service" ? "service" : "supervised";
      const packageNames = requiredPackageNames(profile);
      const pinMap = new Map<string, string>();
      for (const pkg of packageNames) {
        const version = observed.versions[`candidate_${pkg}`];
        if (version !== undefined) {
          pinMap.set(pkg, version);
        }
      }
      const pins = [...pinMap.entries()]
        .map(([name, version]) => ({ name, version }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const missing = packageNames.filter((name) => !pinMap.has(name));
      if (missing.length > 0) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s02_package_candidate_missing",
          publicMessage: `Required apt package candidate is unavailable: ${missing.join(", ")}`,
          nextAction: "Run apt metadata refresh and review Ubuntu package sources before planning again.",
          stage: "S02"
        });
      }

      const planned: PlannedPins = {
        pins,
        packageSetHash: packageSetHash(pins)
      };

      const needsInstall = observed.checks.installed_matches_plan !== true;
      const needsMetadataRefresh = observed.checks.metadata_fresh !== true;

      const operations: StagePlan["operations"] = [];
      if (needsMetadataRefresh) {
        operations.push({
          id: operationId("update", planned),
          stageId: "S02" as const,
          kind: "mutate" as const,
          resourceId: "apt-metadata",
          risk: "high" as const,
          gateIds: ["s02-sudo-apt-update"],
          preconditions: operationPreconditions(planned),
          sideEffects: ["refresh apt repository metadata"],
          timeoutSec: 180,
          retryable: false
        });
      }
      if (needsInstall) {
        operations.push(
          {
            id: operationId("simulate", planned),
            stageId: "S02" as const,
            kind: "observe" as const,
            resourceId: "apt-simulation",
            risk: "low" as const,
            gateIds: [],
            preconditions: operationPreconditions(planned),
            sideEffects: [],
            timeoutSec: 180,
            retryable: false
          },
          {
            id: operationId("install", planned),
            stageId: "S02" as const,
            kind: "mutate" as const,
            resourceId: "system-packages",
            risk: "high" as const,
            gateIds: ["s02-sudo-apt-install"],
            preconditions: operationPreconditions(planned),
            sideEffects: ["install exact pinned apt package set"],
            timeoutSec: 300,
            retryable: false
          }
        );
      }

      const requiredGates = [
        ...(operations.some((op) => op.gateIds.includes("s02-sudo-apt-update")) ? ["s02-sudo-apt-update"] : []),
        ...(operations.some((op) => op.gateIds.includes("s02-sudo-apt-install")) ? ["s02-sudo-apt-install"] : []),
        ...(observed.checks.reboot_required === true ? ["s02-reboot-required"] : [])
      ];

      return {
        stageId: "S02",
        optional: false,
        requiredCapabilities: [],
        operations,
        requiredGates
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      const profile = ctx.profile;
      const observed = await aptAdapter.observe(requiredPackageNames(profile));
      if (!observed.sudoAvailable) {
        throw setupError({
          exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
          code: "s02_sudo_required",
          publicMessage: "S02 requires sudo access for apt operations.",
          nextAction: "Grant scoped sudo for apt and rerun plan/apply.",
          stage: "S02"
        });
      }
      if (!observed.dpkgAuditClean) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s02_dpkg_audit_failed",
          publicMessage: "dpkg reports unfinished package state; auto-repair is refused.",
          nextAction: "Run 'sudo dpkg --audit' and, if needed, 'sudo dpkg --configure -a', then rerun plan/apply.",
          stage: "S02",
          evidenceRef: observed.dpkgAuditOutput.slice(0, 512)
        });
      }

      const current = plannedPinsFromObservation(observed);
      if (approvedPlan.operations.length === 0) {
        return [];
      }
      const plannedFromPlan = parsePlanPins(approvedPlan);
      if (plannedFromPlan.packageSetHash !== current.packageSetHash) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s02_package_set_changed",
          publicMessage: "apt package set changed since plan approval.",
          nextAction: "Run 'factory-setup plan --stage S02', review diff, and approve a renewed gate.",
          stage: "S02",
          evidenceRef: `planned=${plannedFromPlan.packageSetHash};observed=${current.packageSetHash}`
        });
      }

      const updateOperation = approvedPlan.operations.find((op) => op.id.startsWith("s02-apt-update-"));
      const simulateOperation = approvedPlan.operations.find((op) => op.id.startsWith("s02-apt-simulate-"));
      const installOperation = approvedPlan.operations.find((op) => op.id.startsWith("s02-apt-install-"));
      const receipts: StageReceipt[] = [];

      if (updateOperation !== undefined) {
        await aptAdapter.refreshMetadata();
        const afterUpdate = await aptAdapter.observe(requiredPackageNames(profile));
        const updatedPins = plannedPinsFromObservation(afterUpdate);
        receipts.push({
          operationId: updateOperation.id,
          stageId: "S02",
          resourceId: updateOperation.resourceId,
          observedAt: new Date().toISOString(),
          checks: checksFromObservation(afterUpdate, updatedPins, profile),
          versions: versionsFromObservation(afterUpdate),
          artifacts: []
        });
      }
      if (simulateOperation !== undefined) {
        await aptAdapter.simulateInstall(plannedFromPlan.pins);
        const afterSimulate = await aptAdapter.observe(requiredPackageNames(profile));
        const simulatedPins = plannedPinsFromObservation(afterSimulate);
        receipts.push({
          operationId: simulateOperation.id,
          stageId: "S02",
          resourceId: simulateOperation.resourceId,
          observedAt: new Date().toISOString(),
          checks: checksFromObservation(afterSimulate, simulatedPins, profile),
          versions: versionsFromObservation(afterSimulate),
          artifacts: []
        });
      }
      if (installOperation !== undefined) {
        await aptAdapter.installPinned(plannedFromPlan.pins);
        const afterInstall = await aptAdapter.observe(requiredPackageNames(profile));
        const installedPins = plannedPinsFromObservation(afterInstall);
        receipts.push({
          operationId: installOperation.id,
          stageId: "S02",
          resourceId: installOperation.resourceId,
          observedAt: new Date().toISOString(),
          checks: checksFromObservation(afterInstall, installedPins, profile),
          versions: versionsFromObservation(afterInstall),
          artifacts: []
        });
      }

      const after = await aptAdapter.observe(requiredPackageNames(profile));
      if (!after.dpkgAuditClean) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s02_dpkg_audit_failed_post",
          publicMessage: "dpkg audit reports unresolved package state after S02 apply.",
          nextAction: "Run 'sudo dpkg --audit' and resolve manually before resume.",
          stage: "S02",
          evidenceRef: after.dpkgAuditOutput.slice(0, 512)
        });
      }
      if (receipts.length === 0) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s02_operation_receipts_missing",
          publicMessage: "S02 plan expected operation receipts but none were produced.",
          nextAction: "Preserve recovery evidence and rerun recover before retrying apply.",
          stage: "S02"
        });
      }
      return receipts;
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const profile = ctx.profile;
      const observation = await aptAdapter.observe(requiredPackageNames(profile));
      const planned = plannedPinsFromObservation(observation);
      if (!observation.dpkgAuditClean) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s02_dpkg_audit_failed_verify",
          publicMessage: "dpkg audit reports unresolved package state.",
          nextAction: "Run 'sudo dpkg --audit' and 'sudo dpkg --configure -a' if required, then rerun verify.",
          stage: "S02",
          evidenceRef: observation.dpkgAuditOutput.slice(0, 512)
        });
      }
      if (!allPinsInstalled(observation)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s02_version_drift",
          publicMessage: "Installed package versions do not match pinned S02 plan.",
          nextAction: "Run plan/apply for S02 to reconcile package versions.",
          stage: "S02",
          evidenceRef: planned.packageSetHash
        });
      }
      if (observation.rebootRequired) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s02_reboot_required",
          publicMessage: "System reboot is required after package changes.",
          nextAction: "Reboot the host manually, then run verify/status --refresh.",
          stage: "S02"
        });
      }

      const receipt: StageReceipt = {
        operationId: "s02-verify-packages",
        stageId: "S02",
        resourceId: "system-packages",
        observedAt: new Date().toISOString(),
        checks: checksFromObservation(observation, planned, profile),
        versions: versionsFromObservation(observation),
        artifacts: []
      };
      return [receipt];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      if (lastObservation === null) {
        await this.observe(ctx);
      }
      return this.verify(ctx);
    }
  };
}
