import { createHash } from "node:crypto";
import {
  type DockerAdapter,
  type DockerFixtureProbeResult,
  type DockerPackagePin,
  type DockerRuntimeObservation
} from "../adapters/docker";
import { setupError } from "../core/errors";
import { ExitCode, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";

const REQUIRED_PACKAGE_NAMES = [
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-buildx-plugin",
  "docker-compose-plugin"
] as const;

const DEFAULT_LOG_CONFIG = {
  logDriver: "json-file",
  logOpts: {
    "max-size": "10m",
    "max-file": "3"
  }
} as const;

const DEFAULT_FIXTURE_REF = "docker.io/library/busybox:1.36.1";

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationId(kind: string, observationHash: string): string {
  return `s04-${kind}-${observationHash.slice(0, 12)}`;
}

function plannedPinsFromObservation(observation: DockerRuntimeObservation): DockerPackagePin[] {
  return observation.packages
    .filter((item) => item.candidateVersion !== null)
    .map((item) => ({ name: item.name, version: item.candidateVersion as string }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function packageSetHash(pins: DockerPackagePin[]): string {
  const stable = pins
    .map((pin) => `${pin.name}=${pin.version}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
  return createHash("sha256").update(stable).digest("hex");
}

function missingCandidatePackages(observation: DockerRuntimeObservation): string[] {
  return observation.packages
    .filter((item) => item.candidateVersion === null)
    .map((item) => item.name);
}

function pinsMatchInstalled(observation: DockerRuntimeObservation, pins: DockerPackagePin[]): boolean {
  const byName = new Map(pins.map((pin) => [pin.name, pin.version] as const));
  return observation.packages.every((item) => byName.get(item.name) === item.installedVersion);
}

function checksFromObservation(
  observation: DockerRuntimeObservation,
  plannedPins: DockerPackagePin[]
): Record<string, string | number | boolean> {
  return {
    docker_installed: observation.dockerInstalled,
    docker_managed_by_installer: observation.managedByInstaller,
    docker_daemon_reachable: observation.daemonReachable,
    docker_client_daemon_api_compatible: observation.apiCompatible,
    docker_context_local: observation.localContext,
    docker_rootless_mode: observation.rootlessMode,
    docker_firewall_backend_iptables: observation.firewallBackend === "iptables",
    docker_conflict_packages_installed: observation.conflictPackagesInstalled.length > 0,
    docker_foreign_container_count: observation.workloads.foreignContainerCount,
    docker_public_published_port_count: observation.workloads.publicPublishedPortCount,
    docker_tcp_api_configured: observation.tcpApi.configured,
    docker_tcp_api_listening: observation.tcpApi.listening,
    docker_socket_exists: observation.dockerSocket.exists,
    docker_socket_world_writable: observation.dockerSocket.worldWritable,
    docker_daemon_config_valid_json: observation.daemonConfig.validJson,
    docker_daemon_config_symlink: observation.daemonConfig.isSymlink,
    docker_group_exists: observation.dockerGroup.exists,
    docker_group_current_user_member: observation.dockerGroup.currentUserInGroup,
    docker_group_account_user_member: observation.dockerGroup.accountUserInGroup ?? observation.dockerGroup.currentUserInGroup,
    docker_relogin_required: observation.reloginRequired,
    docker_workload_inspection: observation.workloads.inspection ?? "legacy-adapter-explicit-counts",
    docker_socket_inspection_verified: observation.dockerSocket.inspectionVerified ?? true,
    docker_tcp_inspection_verified: observation.tcpApi.inspectionVerified ?? true,
    docker_resource_cpu_count: observation.resources.cpuCount,
    docker_resource_memory_bytes: observation.resources.memoryBytes,
    docker_resource_pids_limit_supported: observation.resources.pidsLimitSupported,
    docker_planned_package_count: plannedPins.length,
    docker_missing_candidate_count: missingCandidatePackages(observation).length
  };
}

function versionsFromObservation(observation: DockerRuntimeObservation): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of observation.packages) {
    if (item.installedVersion !== null) {
      versions[`docker_installed_${item.name}`] = item.installedVersion;
    }
    if (item.candidateVersion !== null) {
      versions[`docker_candidate_${item.name}`] = item.candidateVersion;
    }
    versions[`docker_official_repo_visible_${item.name}`] = String(item.officialRepoVisible);
  }
  versions.docker_client = observation.clientVersion ?? "absent";
  versions.docker_server = observation.serverVersion ?? "absent";
  versions.docker_context = observation.currentContext ?? "unknown";
  versions.docker_context_host = observation.contextHost ?? "unknown";
  versions.docker_firewall_backend = observation.firewallBackend;
  versions.docker_daemon_config_hash = observation.daemonConfig.contentHash;
  versions.docker_daemon_owned_log_hash = observation.daemonConfig.ownedLogHash;
  versions.docker_socket_mode = observation.dockerSocket.mode;
  versions.docker_cgroup_version = observation.resources.cgroupVersion;
  versions.docker_conflict_packages = observation.conflictPackagesInstalled.join(",");
  versions.docker_foreign_container_ids = observation.workloads.foreignContainerIds.join(",");
  return versions;
}

function inferStatus(observation: DockerRuntimeObservation): StageObservation["status"] {
  if (!observation.sudoAvailable) {
    return "blocked";
  }
  if (!observation.localContext || observation.rootlessMode) {
    return "blocked";
  }
  if (observation.daemonConfig.isSymlink || !observation.daemonConfig.validJson) {
    return "blocked";
  }
  if (observation.firewallBackend === "nftables") {
    return "blocked";
  }
  if (missingCandidatePackages(observation).length > 0) {
    return "blocked";
  }
  if (observation.packages.some((item) => !item.officialRepoVisible)) {
    return "blocked";
  }
  if (observation.conflictPackagesInstalled.length > 0) {
    return "blocked";
  }
  if (observation.dockerInstalled && !observation.managedByInstaller) {
    return "blocked";
  }
  if (observation.workloads.foreignContainerCount > 0) {
    return "blocked";
  }
  if (observation.reloginRequired || !observation.dockerGroup.currentUserInGroup) {
    return "awaiting_manual";
  }
  if (
    observation.dockerInstalled
    && observation.daemonReachable
    && observation.apiCompatible
    && observation.firewallBackend === "iptables"
    && !observation.tcpApi.configured
    && !observation.tcpApi.listening
    && observation.workloads.publicPublishedPortCount === 0
    && observation.dockerSocket.exists
    && !observation.dockerSocket.worldWritable
    && observation.resources.pidsLimitSupported
  ) {
    return "verified";
  }
  return "planned";
}

function requiredGatesFromObserved(observed: StageObservation): string[] {
  const gates = [
    "s04-sudo-docker-install",
    "s04-docker-daemon-config-diff-reviewed",
    "s04-docker-daemon-restart-approved",
    "s04-docker-group-root-equivalent-ack"
  ];
  return gates;
}

interface ParsedPlanPreconditions {
  packageSetHash: string;
  observationHash: string;
  fixtureRef: string;
  daemonConfigHash: string;
  observedDockerInstalled: boolean;
  observedManagedByInstaller: boolean;
}

function parsePlanPreconditions(plan: StagePlan): ParsedPlanPreconditions {
  let packageSetHashValue: string | null = null;
  let observationHash: string | null = null;
  let fixtureRef: string | null = null;
  let daemonConfigHash: string | null = null;
  let observedDockerInstalled: boolean | null = null;
  let observedManagedByInstaller: boolean | null = null;

  for (const operation of plan.operations) {
    for (const precondition of operation.preconditions) {
      if (precondition.startsWith("s04_package_set_hash:")) {
        packageSetHashValue = precondition.slice("s04_package_set_hash:".length);
      } else if (precondition.startsWith("s04_observation_hash:")) {
        observationHash = precondition.slice("s04_observation_hash:".length);
      } else if (precondition.startsWith("s04_fixture_ref:")) {
        fixtureRef = precondition.slice("s04_fixture_ref:".length);
      } else if (precondition.startsWith("s04_daemon_config_hash:")) {
        daemonConfigHash = precondition.slice("s04_daemon_config_hash:".length);
      } else if (precondition.startsWith("s04_observed_docker_installed:")) {
        const value = precondition.slice("s04_observed_docker_installed:".length);
        if (value === "true") {
          observedDockerInstalled = true;
        } else if (value === "false") {
          observedDockerInstalled = false;
        }
      } else if (precondition.startsWith("s04_observed_managed_by_installer:")) {
        const value = precondition.slice("s04_observed_managed_by_installer:".length);
        if (value === "true") {
          observedManagedByInstaller = true;
        } else if (value === "false") {
          observedManagedByInstaller = false;
        }
      }
    }
  }

  if (
    packageSetHashValue === null
    || observationHash === null
    || fixtureRef === null
    || daemonConfigHash === null
    || packageSetHashValue.length === 0
    || observationHash.length === 0
    || fixtureRef.length === 0
    || daemonConfigHash.length === 0
    || observedDockerInstalled === null
    || observedManagedByInstaller === null
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s04_plan_preconditions_missing",
      publicMessage: "S04 plan is missing required preconditions.",
      nextAction: "Regenerate S04 plan and re-approve required gates.",
      stage: "S04"
    });
  }

  return {
    packageSetHash: packageSetHashValue,
    observationHash,
    fixtureRef,
    daemonConfigHash,
    observedDockerInstalled,
    observedManagedByInstaller
  };
}

function validateBlockedPreconditions(
  observation: DockerRuntimeObservation,
  options: { allowUnmanagedInstalledTransition?: boolean; sessionPreparation?: boolean } = {}
): void {
  if (!observation.sudoAvailable) {
    throw setupError({
      exitCode: ExitCode.UnsupportedHostOrMissingPrivileges,
      code: "s04_sudo_required",
      publicMessage: "S04 requires sudo for reviewed Docker package/system changes.",
      nextAction: "Grant scoped sudo privileges and rerun S04 plan/apply.",
      stage: "S04"
    });
  }
  if (!observation.localContext) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_remote_context_blocked",
      publicMessage: "Remote Docker context is active; S04 blocks host mutations on remote daemons.",
      nextAction: "Switch to local docker context (unix socket) and rerun S04.",
      stage: "S04",
      evidenceRef: observation.contextHost ?? "unknown"
    });
  }
  if (observation.rootlessMode) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_rootless_unsupported",
      publicMessage: "Rootless Docker mode is unsupported for S04 host policy.",
      nextAction: "Use reviewed rootful Docker daemon for this installer profile.",
      stage: "S04"
    });
  }
  if (observation.daemonConfig.isSymlink) {
    throw setupError({
      exitCode: ExitCode.SecurityBoundaryViolation,
      code: "s04_daemon_config_symlink",
      publicMessage: "Symlinked Docker daemon config is unsupported for S04.",
      nextAction: "Replace /etc/docker/daemon.json symlink with a regular file under owner review.",
      stage: "S04"
    });
  }
  if (!observation.daemonConfig.validJson) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s04_daemon_config_invalid_json",
      publicMessage: "Docker daemon config JSON is invalid.",
      nextAction: "Fix daemon.json syntax and rerun S04.",
      stage: "S04"
    });
  }
  if (observation.firewallBackend === "nftables") {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_firewall_backend_unsupported",
      publicMessage: "S04 requires Docker iptables backend; nftables backend is blocked.",
      nextAction: "Switch Docker firewall backend to iptables under owner-approved change control.",
      stage: "S04"
    });
  }
  if (missingCandidatePackages(observation).length > 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_required_package_candidate_missing",
      publicMessage: "Required Docker package candidates are unavailable.",
      nextAction: "Review Docker official apt repository and rerun S04 plan.",
      stage: "S04",
      evidenceRef: missingCandidatePackages(observation).join(",")
    });
  }
  if (observation.packages.some((item) => !item.officialRepoVisible)) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_unofficial_docker_repo_detected",
      publicMessage: "S04 requires package candidates from official Docker apt repository.",
      nextAction: "Fix apt sources to include official signed Docker repository and replan.",
      stage: "S04"
    });
  }
  if (observation.conflictPackagesInstalled.length > 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_conflict_packages_installed",
      publicMessage: "Conflicting Docker packages are installed; auto-removal is blocked.",
      nextAction: "Inspect conflict packages and prepare explicit owner-approved remediation plan.",
      stage: "S04",
      evidenceRef: observation.conflictPackagesInstalled.join(",")
    });
  }
  if (
    observation.dockerInstalled
    && !observation.managedByInstaller
    && options.allowUnmanagedInstalledTransition !== true
  ) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_existing_docker_requires_inspection",
      publicMessage: "Docker is already installed and unmanaged by this installer; automatic change is blocked.",
      nextAction: "Inspect existing Docker installation and approve explicit adoption/change plan before S04 apply.",
      stage: "S04"
    });
  }
  if (observation.tcpApi.configured || observation.tcpApi.listening || observation.dockerSocket.worldWritable || observation.workloads.publicPublishedPortCount > 0) {
    throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code: observation.tcpApi.configured || observation.tcpApi.listening ? "s04_public_docker_api_detected" : observation.dockerSocket.worldWritable ? "s04_socket_world_writable" : "s04_public_ports_detected",
      publicMessage: "Unsafe socket, TCP API or public workload exposure blocks Docker changes.", nextAction: "Review Docker boundaries before proceeding.", stage: "S04" });
  }
  if (observation.workloads.foreignContainerCount > 0) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s04_foreign_workloads_detected",
      publicMessage: "Foreign Docker containers are present; daemon restart/reconfiguration is blocked.",
      nextAction: "Inspect existing workloads and obtain explicit owner confirmation before any Docker daemon change.",
      stage: "S04",
      evidenceRef: observation.workloads.foreignContainerIds.join(",")
    });
  }
  if (observation.tcpApi.inspectionVerified === false || observation.dockerSocket.inspectionVerified === false) {
    throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_boundary_inspection_unknown",
      publicMessage: "Docker socket or TCP exposure inspection is unavailable.", nextAction: "Restore trustworthy read-only boundary inspection before changes.", stage: "S04" });
  }
  if (observation.dockerSocket.exists && observation.dockerSocket.uid !== 0) {
    throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code: "s04_socket_owner_unsafe",
      publicMessage: "Docker socket is not owned by root.", nextAction: "Inspect socket ownership; automatic adoption is forbidden.", stage: "S04" });
  }
  const unknownWorkloads = observation.workloads.inspection !== undefined && observation.workloads.inspection !== "verified";
  if (unknownWorkloads && (observation.dockerInstalled ? options.sessionPreparation !== true : observation.dockerSocket.exists)) {
    throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_workloads_unknown",
      publicMessage: "Docker workloads are unknown; configuration/restart cannot assume an empty daemon.", nextAction: "Observe workloads in an active owner session before daemon changes.", stage: "S04" });
  }

}

function validateProbeResult(probe: DockerFixtureProbeResult): void {
  if (!probe.cleanupOk) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s04_fixture_cleanup_failed",
      publicMessage: "Fixture cleanup failed after S04 resource probe.",
      nextAction: "Remove fixture resources manually and rerun verify/recover.",
      stage: "S04",
      evidenceRef: probe.cleanupDetails
    });
  }
  const constraintsOk = probe.readOnlyRootFs
    && probe.noNewPrivileges
    && probe.capDropAll
    && probe.pidsLimit !== null
    && probe.pidsLimit > 0
    && probe.memoryBytes !== null
    && probe.memoryBytes > 0
    && probe.cpuQuotaCpus !== null
    && probe.labelsPresent;
  if (!constraintsOk || !probe.cgroupApplied) {
    throw setupError({
      exitCode: ExitCode.DriftOrRecoveryRequired,
      code: "s04_resource_probe_constraints_failed",
      publicMessage: "S04 resource probe did not enforce required container hardening/resource limits.",
      nextAction: "Inspect Docker daemon cgroup/security configuration and rerun S04.",
      stage: "S04",
      evidenceRef: JSON.stringify({
        readOnly: probe.readOnlyRootFs,
        noNewPrivileges: probe.noNewPrivileges,
        capDropAll: probe.capDropAll,
        pidsLimit: probe.pidsLimit,
        memoryBytes: probe.memoryBytes,
        cpuQuotaCpus: probe.cpuQuotaCpus,
        labelsPresent: probe.labelsPresent,
        cgroupApplied: probe.cgroupApplied
      })
    });
  }
}

const SESSION_RESOURCES = new Set(["docker-daemon-log-config", "docker-daemon-service", "docker-fixture-probe", "docker-managed-installation"]);
function assertOwnerRuntime(observed: DockerRuntimeObservation): void {
  if (observed.daemonAccess === "malformed") throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_daemon_observation_malformed",
    publicMessage: "Docker daemon observation is malformed.", nextAction: "Restore valid daemon/version evidence before effects.", stage: "S04" });
  if (observed.reloginRequired || !observed.dockerGroup.currentUserInGroup) throw setupError({ exitCode: ExitCode.ManualActionRequired, code: "s04_relogin_required",
    publicMessage: "The current process lacks active Docker group access.", nextAction: "Open a new owner login session, replan/review remaining operations and resume.", stage: "S04" });
  if (observed.daemonAccess === "permission_denied") throw setupError({ exitCode: ExitCode.UnsupportedHostOrMissingPrivileges, code: "s04_owner_daemon_access_denied",
    publicMessage: "The active owner session still cannot access the protected Docker daemon.", nextAction: "Inspect socket/group permissions without sudo docker, chmod 666 or root installer.", stage: "S04" });
  if (!observed.daemonReachable) throw setupError({ exitCode: ExitCode.OperationOrVerificationFailed, code: "s04_daemon_unreachable",
    publicMessage: "Docker daemon is unavailable in the active owner session.", nextAction: "Inspect daemon health; this is not a relogin acknowledgement.", stage: "S04" });
  if (!observed.apiCompatible) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_client_daemon_incompatible",
    publicMessage: "Docker API/version evidence is incompatible or malformed.", nextAction: "Reconcile Docker API/version evidence before changes.", stage: "S04" });
  if (observed.firewallBackend !== "iptables") throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence, code: "s04_firewall_backend_unsupported",
    publicMessage: "Daemon firewall backend evidence is missing or unsupported.", nextAction: "Verify the reviewed iptables backend before daemon changes.", stage: "S04" });

}

function completedResources(ctx: StageContext, observation: DockerRuntimeObservation): string[] {
  const receipts = (ctx.completedOperationReceipts ?? []).filter(r => r.stageId === "S04");
  const install = receipts.find(r => r.resourceId === "docker-package-set");
  if (install === undefined || !observation.dockerInstalled || !pinsMatchInstalled(observation, plannedPinsFromObservation(observation))
    || !observation.packages.every(p => install.versions[`docker_installed_${p.name}`] === p.installedVersion)) return [];
  const merge = receipts.find(r => r.resourceId === "docker-daemon-log-config");
  if (merge !== undefined && merge.versions.docker_daemon_config_hash !== observation.daemonConfig.contentHash) return [];
  return receipts.map(r => r.resourceId);
}

export function createDockerStage(dockerAdapter: DockerAdapter): StageModule {
  return {
    id: "S04",
    dependencies: ["S03"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const observation = await dockerAdapter.observe(ctx);
      const plannedPins = plannedPinsFromObservation(observation);
      const completed = completedResources(ctx, observation);
      const checks: StageObservation["checks"] = { ...checksFromObservation(observation, plannedPins), s04_completed_resources: completed.join(",") };
      const ownProgress = completed.includes("docker-package-set");
      if (missingCandidatePackages(observation).length > 0) {
        checks.docker_missing_candidates = missingCandidatePackages(observation).join(",");
      }
      if (observation.conflictPackagesInstalled.length > 0) {
        checks.docker_conflict_packages = observation.conflictPackagesInstalled.join(",");
      }
      if (observation.workloads.foreignContainerCount > 0) {
        checks.docker_foreign_container_ids = observation.workloads.foreignContainerIds.join(",");
      }
      return {
        stageId: "S04",
        status: ownProgress && !observation.managedByInstaller
          ? (observation.reloginRequired || !observation.dockerGroup.currentUserInGroup ? "awaiting_manual" : "planned")
          : inferStatus(observation),
        checks,
        versions: versionsFromObservation(observation),
        observedAt: new Date().toISOString()
      };
    },
    reconcilePolicyOperation(ctx, reviewed, current) {
      const prefix=current.id.replace(/-[0-9a-f]{12}$/, "");
      const original=reviewed.operations.find(op=>op.id.replace(/-[0-9a-f]{12}$/, "")===prefix);
      if(!original)return {id:current.id,preconditions:current.preconditions};
      const proven=(resource:string)=>(ctx.completedOperationReceipts ?? []).some(r=>r.stageId==="S04" && r.resourceId===resource);
      return {id:original.id,preconditions:current.preconditions.map(value=>{
        const key=value.split(":",1)[0]!;
        return key==="s04_observation_hash" || (proven("docker-package-set") && key==="s04_observed_docker_installed")
          || (proven("docker-managed-installation") && key==="s04_observed_managed_by_installer") || (proven("docker-daemon-log-config") && key==="s04_daemon_config_hash")
          ? original.preconditions.find(p=>p.startsWith(key+":")) ?? value : value;
      })};
    },
    policyInputs(observed) {
      const { s04_completed_resources: _derived, ...checks } = observed.checks;
      return {checks, versions: observed.versions};
    },
    plan(desired: unknown, observed: StageObservation): StagePlan {
      const fixtureRef = (desired as { dockerFixtureRef?: string }).dockerFixtureRef ?? DEFAULT_FIXTURE_REF;
      const candidatePins: DockerPackagePin[] = [];
      for (const packageName of REQUIRED_PACKAGE_NAMES) {
        const candidate = observed.versions[`docker_candidate_${packageName}`];
        if (candidate === undefined || candidate === "absent") {
          throw setupError({
            exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
            code: "s04_required_package_candidate_missing",
            publicMessage: "S04 planning requires all pinned Docker package candidates.",
            nextAction: "Fix Docker apt metadata and rerun S04 plan.",
            stage: "S04"
          });
        }
        candidatePins.push({ name: packageName, version: candidate });
      }

      const completed = String(observed.checks.s04_completed_resources ?? "").split(",");
      if (completed.includes("docker-group-membership") && observed.checks.docker_group_current_user_member !== true) {
        if (observed.checks.docker_group_account_user_member !== true) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_group_membership_drift",
          publicMessage: "Previously confirmed Docker account membership is no longer present.", nextAction: "Reconcile group ownership and account membership before resuming.", stage: "S04" });
        throw setupError({ exitCode: ExitCode.ManualActionRequired, code: "s04_relogin_required",
          publicMessage: "Completed group update is not active in this process session.", nextAction: "Open a new owner login session, then generate/review the remaining plan and resume.", stage: "S04" });
      }

      if (observed.status === "verified") {
        return {
          stageId: "S04",
          optional: false,
          requiredCapabilities: [],
          operations: [],
          requiredGates: []
        };
      }

      const observationHash = stableHash({ checks: observed.checks, versions: observed.versions });
      const preconditions = [
        `s04_package_set_hash:${packageSetHash(candidatePins)}`,
        `s04_observation_hash:${observationHash}`,
        `s04_fixture_ref:${fixtureRef}`,
        `s04_daemon_config_hash:${observed.versions.docker_daemon_config_hash ?? "unknown"}`,
        `s04_observed_docker_installed:${observed.checks.docker_installed === true}`,
        `s04_observed_managed_by_installer:${observed.checks.docker_managed_by_installer === true}`
      ];

      const operations: StagePlan["operations"] = [
        {
          id: operationId("install-packages", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-package-set",
          risk: "high",
          gateIds: ["s04-sudo-docker-install"],
          preconditions,
          sideEffects: ["install exact pinned Docker CE package set from official signed repository"],
          timeoutSec: 600,
          retryable: false
        },
        {
          id: operationId("docker-group-membership", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-group-membership",
          risk: "critical",
          gateIds: ["s04-docker-group-root-equivalent-ack"],
          preconditions,
          sideEffects: ["add owner user to docker group (root-equivalent)"],
          timeoutSec: 120,
          retryable: false
        },
        {
          id: operationId("daemon-log-config-merge", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-daemon-log-config",
          risk: "high",
          gateIds: ["s04-docker-daemon-config-diff-reviewed"],
          preconditions,
          sideEffects: ["merge owned Docker daemon log keys without overwriting foreign keys"],
          timeoutSec: 180,
          retryable: false
        },
        {
          id: operationId("daemon-validate-restart", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-daemon-service",
          risk: "critical",
          gateIds: ["s04-docker-daemon-restart-approved"],
          preconditions,
          sideEffects: ["validate and restart Docker daemon"],
          timeoutSec: 180,
          retryable: false
        },
        {
          id: operationId("resource-probe", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-fixture-probe",
          risk: "high",
          gateIds: [],
          preconditions,
          sideEffects: ["run pinned no-secret fixture and inspect enforced limits"],
          timeoutSec: 180,
          retryable: false
        },
        {
          id: operationId("mark-managed-installation", observationHash),
          stageId: "S04",
          kind: "mutate",
          resourceId: "docker-managed-installation",
          risk: "medium",
          gateIds: [],
          preconditions,
          sideEffects: ["persist installer ownership marker for Docker host resources"],
          timeoutSec: 60,
          retryable: false
        }
      ];

      return {
        stageId: "S04",
        optional: false,
        requiredCapabilities: [],
        operations: operations.filter(op => !String(observed.checks.s04_completed_resources ?? "").split(",").includes(op.resourceId)),
        requiredGates: [...new Set(operations.filter(op => !String(observed.checks.s04_completed_resources ?? "").split(",").includes(op.resourceId)).flatMap(op => op.gateIds))]
      };
    },
    async admitOperation(ctx, operation) {
      const observation = await dockerAdapter.observe(ctx);
      const owned = completedResources(ctx, observation).includes("docker-package-set");
      if ((ctx.completedOperationReceipts ?? []).some(r => r.stageId === "S04" && r.resourceId === "docker-package-set") && !owned)
        throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"s04_package_progress_drift",publicMessage:"Confirmed Docker package/config progress no longer matches current pins or resources.",nextAction:"Reconcile ownership and review a fresh plan.",stage:"S04"});
      if ((ctx.completedOperationReceipts ?? []).some(r => r.stageId === "S04" && r.resourceId === "docker-group-membership")
        && (observation.dockerGroup.accountUserInGroup ?? observation.dockerGroup.currentUserInGroup) !== true)
        throw setupError({exitCode:ExitCode.DriftOrRecoveryRequired,code:"s04_group_membership_drift",publicMessage:"Confirmed Docker account membership disappeared.",nextAction:"Reconcile group ownership before resuming.",stage:"S04"});
      if (SESSION_RESOURCES.has(operation.resourceId)) assertOwnerRuntime(observation);
      validateBlockedPreconditions(observation, { allowUnmanagedInstalledTransition: owned,
        sessionPreparation: operation.resourceId === "docker-group-membership" && owned });
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      let observation = await dockerAdapter.observe(ctx);

      if (approvedPlan.operations.length === 0) {
        return [];
      }

      const preconditions = parsePlanPreconditions(approvedPlan);
      const currentOperation = approvedPlan.operations[0]!;
      const currentOperationId = currentOperation.id;
      const allowUnmanagedInstalledTransition = completedResources(ctx, observation).includes("docker-package-set");
      validateBlockedPreconditions(observation, { allowUnmanagedInstalledTransition,
        sessionPreparation: currentOperation.resourceId === "docker-group-membership" && allowUnmanagedInstalledTransition });

      const plannedPins = plannedPinsFromObservation(observation);
      if (currentOperationId.startsWith("s04-install-packages-")) {
        const observedPackageSetHash = packageSetHash(plannedPins);
        if (preconditions.packageSetHash !== observedPackageSetHash) {
          throw setupError({
            exitCode: ExitCode.ManualActionRequired,
            code: "s04_package_set_changed",
            publicMessage: "Docker package candidates changed after S04 plan approval.",
            nextAction: "Regenerate S04 plan and re-approve gates before apply.",
            stage: "S04",
            evidenceRef: `planned=${preconditions.packageSetHash};observed=${observedPackageSetHash}`
          });
        }
        const observedConfigHash = observation.daemonConfig.contentHash;
        if (preconditions.daemonConfigHash !== observedConfigHash) {
          throw setupError({
            exitCode: ExitCode.ManualActionRequired,
            code: "s04_daemon_config_drifted",
            publicMessage: "Docker daemon config changed after S04 plan approval.",
            nextAction: "Review config diff and regenerate S04 plan.",
            stage: "S04",
            evidenceRef: `planned=${preconditions.daemonConfigHash};observed=${observedConfigHash}`
          });
        }
        const observedHash = stableHash({
          checks: { ...checksFromObservation(observation, plannedPins), s04_completed_resources: completedResources(ctx, observation).join(",") },
          versions: versionsFromObservation(observation)
        });
        if (preconditions.observationHash !== observedHash) {
          throw setupError({
            exitCode: ExitCode.ManualActionRequired,
            code: "s04_observation_drifted",
            publicMessage: "S04 observed state changed after plan approval.",
            nextAction: "Run plan for S04 again and re-approve gates.",
            stage: "S04",
            evidenceRef: `planned=${preconditions.observationHash};observed=${observedHash}`
          });
        }
      }

      ctx = { ...ctx, completedOperationReceipts: [...(ctx.completedOperationReceipts ?? [])] };
      const receipts: StageReceipt[] = [];
      for (const operation of approvedPlan.operations) {
        if (SESSION_RESOURCES.has(operation.resourceId)) {
          observation = await dockerAdapter.observe(ctx); assertOwnerRuntime(observation);
          validateBlockedPreconditions(observation, { allowUnmanagedInstalledTransition: completedResources(ctx, observation).includes("docker-package-set") });
        }
        if (operation.id.includes("install-packages")) {
          if (!(observation.managedByInstaller && pinsMatchInstalled(observation, plannedPins))) await dockerAdapter.installPinnedPackages(plannedPins);
        } else if (operation.id.includes("daemon-log-config-merge")) {
          await dockerAdapter.mergeOwnedDaemonLogConfig(DEFAULT_LOG_CONFIG);
        } else if (operation.id.includes("daemon-validate-restart")) {
          await dockerAdapter.validateDaemonConfig();
          await dockerAdapter.restartDaemon();
        } else if (operation.id.includes("docker-group-membership")) {
          const membership = await dockerAdapter.ensureDockerGroupMembership(ctx);
          observation = await dockerAdapter.observe(ctx);
          if (!observation.dockerGroup.exists || !observation.dockerGroup.currentUserInGroup) {
            // Effect is complete in the account database; session activation is checked independently.
            if (observation.dockerGroup.accountUserInGroup !== true) {
              throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_group_postcondition_missing",
                publicMessage: "Docker group account membership was not confirmed after update.", nextAction: "Inspect group database and preserve evidence.", stage: "S04" });
            }
          }
        } else if (operation.id.includes("resource-probe")) {
          if (observation.reloginRequired || !observation.dockerGroup.currentUserInGroup) {
            throw setupError({ exitCode: ExitCode.ManualActionRequired, code: "s04_relogin_required",
              publicMessage: "Docker group is not active in this process session.", nextAction: "Open a new login session, then resume.", stage: "S04" });
          }
          const probe = await dockerAdapter.runPinnedResourceProbe(ctx, operation.id, preconditions.fixtureRef);
          validateProbeResult(probe);
        } else if (operation.id.includes("mark-managed-installation")) {
          await dockerAdapter.markManagedInstallation(ctx);
        } else {
          throw setupError({
            exitCode: ExitCode.CliOrSchemaError,
            code: "s04_unplanned_operation",
            publicMessage: `S04 received unsupported operation '${operation.id}'.`,
            nextAction: "Regenerate S04 plan with a supported installer release.",
            stage: "S04",
            operationId: operation.id
          });
        }

        observation = await dockerAdapter.observe(ctx);
        const observedPins = plannedPinsFromObservation(observation);
        if (observation.tcpApi.configured || observation.tcpApi.listening) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "s04_public_docker_api_detected",
            publicMessage: "Docker TCP API exposure detected after S04 apply.",
            nextAction: "Disable Docker TCP API listeners and rerun S04 verify.",
            stage: "S04"
          });
        }
        if (observation.workloads.publicPublishedPortCount > 0) {
          throw setupError({
            exitCode: ExitCode.DriftOrRecoveryRequired,
            code: "s04_public_ports_detected",
            publicMessage: "Publicly published container ports detected after S04 apply.",
            nextAction: "Inspect published ports and enforce non-public Docker workload policy.",
            stage: "S04",
            evidenceRef: String(observation.workloads.publicPublishedPortCount)
          });
        }

        receipts.push({
          operationId: operation.id,
          stageId: "S04",
          resourceId: operation.resourceId,
          observedAt: new Date().toISOString(),
          checks: { ...checksFromObservation(observation, observedPins),
            s04_probe_verified: operation.resourceId === "docker-fixture-probe",
            manual_pause_required: operation.resourceId === "docker-group-membership" && (observation.reloginRequired || !observation.dockerGroup.currentUserInGroup) },
          versions: versionsFromObservation(observation),
          artifacts: ["/etc/docker/daemon.json"]
        });
        ctx.completedOperationReceipts!.push(receipts[receipts.length - 1]!);
      }
      return receipts;
    },
    async verifyOperation(ctx, receipt) {
      const observed = await dockerAdapter.observe(ctx);
      validateBlockedPreconditions(observed, { allowUnmanagedInstalledTransition: receipt.resourceId === "docker-package-set" || completedResources(ctx, observed).includes("docker-package-set"),
        sessionPreparation: receipt.resourceId === "docker-package-set" || receipt.resourceId === "docker-group-membership" });
      let ok = false;
      if (receipt.resourceId === "docker-package-set") ok = pinsMatchInstalled(observed, plannedPinsFromObservation(observed));
      if (receipt.resourceId === "docker-daemon-log-config") ok = observed.daemonConfig.contentHash === receipt.versions.docker_daemon_config_hash;
      if (receipt.resourceId === "docker-daemon-service") ok = observed.daemonReachable && observed.apiCompatible;
      if (receipt.resourceId === "docker-group-membership") ok = observed.dockerGroup.currentUserInGroup || observed.dockerGroup.accountUserInGroup === true;
      if (receipt.resourceId === "docker-fixture-probe") ok = receipt.checks.s04_probe_verified === true && observed.dockerGroup.currentUserInGroup;
      if (receipt.resourceId === "docker-managed-installation") ok = observed.managedByInstaller;
      if (!ok) throw setupError({ exitCode: ExitCode.DriftOrRecoveryRequired, code: "s04_operation_postcondition_failed",
        publicMessage: "Docker operation postcondition could not be confirmed.", nextAction: "Preserve Docker operation evidence and reconcile resources.", stage: "S04" });
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const observation = await dockerAdapter.observe(ctx);
      validateBlockedPreconditions(observation);
      if (!observation.daemonReachable) {
        throw setupError({
          exitCode: ExitCode.OperationOrVerificationFailed,
          code: "s04_daemon_unreachable",
          publicMessage: "Docker daemon is unreachable during S04 verify.",
          nextAction: "Inspect docker.service health and rerun verify.",
          stage: "S04"
        });
      }
      if (!observation.apiCompatible) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s04_client_daemon_incompatible",
          publicMessage: "Docker client/daemon versions are incompatible for S04 policy.",
          nextAction: "Reconcile docker-ce and docker-ce-cli pinned versions and rerun verify.",
          stage: "S04",
          evidenceRef: `client=${observation.clientVersion ?? "absent"};server=${observation.serverVersion ?? "absent"}`
        });
      }
      const plannedPins = plannedPinsFromObservation(observation);
      if (!pinsMatchInstalled(observation, plannedPins)) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s04_package_version_drift",
          publicMessage: "Installed Docker package versions do not match pinned candidates.",
          nextAction: "Run S04 plan/apply again to reconcile package pins.",
          stage: "S04"
        });
      }
      if (observation.tcpApi.configured || observation.tcpApi.listening) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "s04_public_docker_api_detected",
          publicMessage: "Public or TCP Docker API exposure is forbidden.",
          nextAction: "Disable Docker TCP API endpoints and rerun verify.",
          stage: "S04"
        });
      }
      if (observation.dockerSocket.worldWritable) {
        throw setupError({
          exitCode: ExitCode.SecurityBoundaryViolation,
          code: "s04_socket_world_writable",
          publicMessage: "Docker Unix socket is world-writable.",
          nextAction: "Restore secure socket permissions and rerun verify.",
          stage: "S04"
        });
      }
      if (observation.workloads.publicPublishedPortCount > 0) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s04_public_ports_detected",
          publicMessage: "Publicly published container ports were detected.",
          nextAction: "Close public Docker ports and rerun verify.",
          stage: "S04"
        });
      }
      if (!observation.resources.pidsLimitSupported) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s04_pids_limit_unsupported",
          publicMessage: "Docker daemon does not report pids-limit support required by S04.",
          nextAction: "Enable required cgroup/pids support and rerun S04.",
          stage: "S04"
        });
      }
      if (observation.reloginRequired || !observation.dockerGroup.currentUserInGroup) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s04_relogin_required",
          publicMessage: "Current session is not active in docker group; relogin required.",
          nextAction: "Log out and back in, then rerun verify/status --refresh.",
          stage: "S04"
        });
      }

      return [
        {
          operationId: "s04-verify-docker-host",
          stageId: "S04",
          resourceId: "docker-host",
          observedAt: new Date().toISOString(),
          checks: { ...checksFromObservation(observation, plannedPins), s04_completed_resources: completedResources(ctx, observation).join(",") },
          versions: versionsFromObservation(observation),
          artifacts: ["/etc/docker/daemon.json", "/var/run/docker.sock"]
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
