import test from "node:test";
import assert from "node:assert/strict";
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

function baseObservation(): DockerRuntimeObservation {
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

class FakeDockerAdapter implements DockerAdapter {
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

test("S04 plans Docker package/config/group/probe operations and required gates", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.dockerGroup.currentUserInGroup = false;
  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  assert.equal(observation.stageId, "S04");
  assert.equal(plan.operations.length, 6);
  assert.equal(plan.requiredGates.includes("s04-docker-group-root-equivalent-ack"), true);
  assert.equal(plan.requiredGates.includes("s04-docker-daemon-restart-approved"), true);
  assert.equal(plan.requiredGates.includes("s04-docker-daemon-config-diff-reviewed"), true);
  assert.equal(plan.requiredGates.includes("s04-sudo-docker-install"), true);
});

test("S04 apply blocks unmanaged pre-existing Docker installation", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.dockerInstalled = true;
  adapter.observation.clientVersion = "27.3.1";
  adapter.observation.serverVersion = "27.3.1";
  adapter.observation.daemonReachable = true;
  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  await assert.rejects(
    async () => stage.apply(ctx(), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_existing_docker_requires_inspection"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );
});

test("S04 apply blocks when daemon has foreign containers", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.workloads.foreignContainerCount = 2;
  adapter.observation.workloads.foreignContainerIds = ["c1", "c2"];
  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  await assert.rejects(
    async () => stage.apply(ctx(), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_foreign_workloads_detected"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );
});

test("S04 apply returns manual relogin requirement after docker group change", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.dockerGroup.currentUserInGroup = false;
  adapter.changeGroupMembership = true;
  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  await assert.rejects(
    async () => stage.apply(ctx(), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_relogin_required"
      && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
    )
  );

  assert.equal(adapter.installCalls, 1);
  assert.equal(adapter.mergeCalls, 1);
  assert.equal(adapter.validateCalls, 1);
  assert.equal(adapter.restartCalls, 1);
  assert.equal(adapter.groupCalls, 1);
  assert.equal(adapter.probeCalls, 0);
});

test("S04 verify fails on public Docker TCP API exposure", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.managedByInstaller = true;
  adapter.observation.dockerInstalled = true;
  markAllPinnedInstalled(adapter.observation);
  adapter.observation.clientVersion = "27.3.1";
  adapter.observation.serverVersion = "27.3.1";
  adapter.observation.daemonReachable = true;
  adapter.observation.apiCompatible = true;
  adapter.observation.tcpApi.listening = true;

  const stage = createDockerStage(adapter);
  await assert.rejects(
    async () => stage.verify(ctx()),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_public_docker_api_detected"
      && (error as { exitCode?: number }).exitCode === ExitCode.SecurityBoundaryViolation
    )
  );
});

test("S04 verify fails when pids resource limit is unsupported", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.managedByInstaller = true;
  adapter.observation.dockerInstalled = true;
  markAllPinnedInstalled(adapter.observation);
  adapter.observation.clientVersion = "27.3.1";
  adapter.observation.serverVersion = "27.3.1";
  adapter.observation.daemonReachable = true;
  adapter.observation.apiCompatible = true;
  adapter.observation.resources.pidsLimitSupported = false;
  const stage = createDockerStage(adapter);

  await assert.rejects(
    async () => stage.verify(ctx()),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_pids_limit_unsupported"
      && (error as { exitCode?: number }).exitCode === ExitCode.BlockedByMissingCapabilityOrEvidence
    )
  );
});

test("S04 apply rejects plan when daemon config hash drifted after approval", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);
  adapter.observation.daemonConfig.contentHash = "daemon-hash-2";

  await assert.rejects(
    async () => stage.apply(ctx(), plan),
    (error) => (
      error instanceof Error
      && "code" in error
      && (error as { code?: string }).code === "s04_daemon_config_drifted"
      && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
    )
  );
});

test("S04 is idempotent when already verified and managed", async () => {
  const adapter = new FakeDockerAdapter(baseObservation());
  adapter.observation.managedByInstaller = true;
  adapter.observation.dockerInstalled = true;
  markAllPinnedInstalled(adapter.observation);
  adapter.observation.clientVersion = "27.3.1";
  adapter.observation.serverVersion = "27.3.1";
  adapter.observation.daemonReachable = true;
  adapter.observation.apiCompatible = true;

  const stage = createDockerStage(adapter);
  const observation = await stage.observe(ctx());
  assert.equal(observation.status, "verified");
  const plan = stage.plan({}, observation);
  assert.equal(plan.operations.length, 0);
  const receipts = await stage.apply(ctx(), plan);
  assert.equal(receipts.length, 0);
});
