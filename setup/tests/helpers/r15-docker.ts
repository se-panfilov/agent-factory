// Standalone typed fixtures; no test callbacks are imported.
import {
  type DockerAdapter,
  type DockerFixtureProbeResult,
  type DockerPackagePin,
  type DockerRuntimeObservation
} from "../../src/adapters/docker";
import { createDockerStage } from "../../src/stages/docker";
import { ExitCode, type SetupConfig, type StageContext } from "../../src/core/types";

function ctx(): StageContext {
  return {
    installationId: "0f71966d-ef6f-4976-97cb-eb34cb139204",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "d".repeat(64),
    planHash: "p".repeat(64),
    config: {} as SetupConfig
  };
}

export function baseObservation(): DockerRuntimeObservation {
  return {
    sudoAvailable: true,
    packages: [
      {
        name: "docker-ce",
        installedVersion: null,
        candidateVersion: "5:27.3.1-1~ubuntu.24.04~noble",
        officialRepoVisible: true
      },
      {
        name: "docker-ce-cli",
        installedVersion: null,
        candidateVersion: "5:27.3.1-1~ubuntu.24.04~noble",
        officialRepoVisible: true
      },
      {
        name: "containerd.io",
        installedVersion: null,
        candidateVersion: "1.7.22-1",
        officialRepoVisible: true
      },
      {
        name: "docker-buildx-plugin",
        installedVersion: null,
        candidateVersion: "0.18.0-1~ubuntu.24.04~noble",
        officialRepoVisible: true
      },
      {
        name: "docker-compose-plugin",
        installedVersion: null,
        candidateVersion: "2.29.7-1~ubuntu.24.04~noble",
        officialRepoVisible: true
      }
    ],
    conflictPackagesInstalled: [],
    dockerInstalled: false,
    managedByInstaller: false,
    daemonReachable: false,
    clientVersion: null,
    serverVersion: null,
    apiCompatible: false,
    currentContext: "default",
    contextHost: "unix:///var/run/docker.sock",
    localContext: true,
    rootlessMode: false,
    firewallBackend: "iptables",
    daemonConfig: {
      path: "/etc/docker/daemon.json",
      exists: true,
      isSymlink: false,
      validJson: true,
      contentHash: "daemon-hash-1",
      ownedLogHash: "owned-log-hash-1",
      hosts: [],
      current: {
        "log-driver": "json-file",
        "log-opts": {
          "max-size": "10m",
          "max-file": "3"
        }
      }
    },
    dockerSocket: {
      exists: true,
      mode: "0660",
      worldWritable: false,
      uid: 0,
      gid: 998
    },
    tcpApi: {
      configured: false,
      listening: false
    },
    workloads: {
      foreignContainerCount: 0,
      foreignContainerIds: [],
      publicPublishedPortCount: 0
    },
    resources: {
      cpuCount: 2,
      memoryBytes: 2 * 1024 * 1024 * 1024,
      cgroupVersion: "2",
      pidsLimitSupported: true
    },
    dockerGroup: {
      exists: true,
      currentUserInGroup: true
    },
    reloginRequired: false
  };
}

function markAllPinnedInstalled(observation: DockerRuntimeObservation): void {
  observation.packages = observation.packages.map((pkg) => ({
    ...pkg,
    installedVersion: pkg.candidateVersion
  }));
}

export class FakeDockerAdapter implements DockerAdapter {
  constructor(public observation: DockerRuntimeObservation) {}

  installCalls = 0;
  mergeCalls = 0;
  validateCalls = 0;
  restartCalls = 0;
  groupCalls = 0;
  probeCalls = 0;
  markManagedCalls = 0;
  changeGroupMembership = false;
  probeResult: DockerFixtureProbeResult = {
    fixtureRef: "docker.io/library/busybox:1.36.1",
    containerName: "fixture",
    cleanupOk: true,
    cleanupDetails: "ok",
    readOnlyRootFs: true,
    noNewPrivileges: true,
    capDropAll: true,
    pidsLimit: 64,
    memoryBytes: 268_435_456,
    cpuQuotaCpus: "1",
    cgroupApplied: true,
    labelsPresent: true
  };

  async observe(): Promise<DockerRuntimeObservation> {
    return JSON.parse(JSON.stringify(this.observation)) as DockerRuntimeObservation;
  }

  async installPinnedPackages(pins: DockerPackagePin[]): Promise<void> {
    this.installCalls += 1;
    const byName = new Map(pins.map((pin) => [pin.name, pin.version] as const));
    this.observation.packages = this.observation.packages.map((pkg) => ({
      ...pkg,
      installedVersion: byName.get(pkg.name) ?? pkg.installedVersion
    }));
    this.observation.dockerInstalled = true;
    this.observation.clientVersion = "27.3.1";
    this.observation.serverVersion = "27.3.1";
    this.observation.apiCompatible = true;
    this.observation.daemonReachable = true;
  }

  async mergeOwnedDaemonLogConfig(): Promise<{ changed: boolean; resultingHash: string }> {
    this.mergeCalls += 1;
    return { changed: true, resultingHash: "new-hash" };
  }

  async validateDaemonConfig(): Promise<void> {
    this.validateCalls += 1;
  }

  async restartDaemon(): Promise<void> {
    this.restartCalls += 1;
  }

  async ensureDockerGroupMembership(): Promise<{ changed: boolean }> {
    this.groupCalls += 1;
    if (this.changeGroupMembership) {
      this.observation.dockerGroup.currentUserInGroup = false;
      this.observation.reloginRequired = true;
      this.observation.dockerGroup.exists = true;
      this.observation.dockerGroup.accountUserInGroup = true;
      return { changed: true };
    }
    return { changed: false };
  }

  async runPinnedResourceProbe(): Promise<DockerFixtureProbeResult> {
    this.probeCalls += 1;
    return this.probeResult;
  }

  async markManagedInstallation(): Promise<void> {
    this.markManagedCalls += 1;
    this.observation.managedByInstaller = true;
  }
}

/** Service health and effective owner access are deliberately separate. */
export class SessionDockerAdapter extends FakeDockerAdapter {
  healthy = true;
  compatible = true;
  inspection: "verified" | "unavailable" | "malformed" = "verified";
  override async observe(): Promise<DockerRuntimeObservation> {
    const o = await super.observe();
    const accessible = o.dockerInstalled && o.dockerGroup.currentUserInGroup && this.healthy;
    o.daemonReachable = accessible;
    o.apiCompatible = accessible && this.compatible;
    o.serverVersion = accessible ? "27.3.1" : null;
    o.daemonAccess = accessible ? "available" : o.dockerGroup.currentUserInGroup ? "unavailable" : "permission_denied";
    o.workloads.inspection = accessible ? this.inspection : "unavailable";
    if (o.workloads.inspection !== "verified") { o.workloads.foreignContainerCount = -1; o.workloads.publicPublishedPortCount = -1; }
    o.dockerSocket.exists = o.dockerInstalled;
    o.dockerSocket.inspectionVerified = true; o.tcpApi.inspectionVerified = true;
    return o;
  }
}
