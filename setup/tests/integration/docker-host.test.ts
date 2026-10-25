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
    const observed = JSON.parse(JSON.stringify(this.observation)) as DockerRuntimeObservation;
    if (!observed.dockerGroup.currentUserInGroup) { observed.daemonReachable = false; observed.apiCompatible = false; observed.serverVersion = null; }
    return observed;
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
  assert.equal(adapter.mergeCalls, 0);
  assert.equal(adapter.validateCalls, 0);
  assert.equal(adapter.restartCalls, 0);
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

import { r14Fixture, r14Noop } from "../helpers/r14-engine";
import fs from "node:fs/promises";
import path from "node:path";
test("U06 clean S04 engine installs, checkpoints group, pauses, observes new session, resumes and repeats", async () => {
  const x = await r14Fixture("S04"), a = new FakeDockerAdapter(baseObservation());
  a.observation.dockerGroup = { exists: false, currentUserInGroup: false, accountUserInGroup: false };
  a.observation.reloginRequired = false;
  a.changeGroupMembership = true;
  const makeEngine = () => x.engine([r14Noop("S03"), createDockerStage(a)]);
  let e = makeEngine();
  const planned = await x.planAndApprove(e);
  assert.equal(planned.stages.flatMap(s => s.required_gates).includes("s04-docker-group-relogin-required"), false);
  const first = await e.run("apply", x.applyOptions);
  assert.equal(first.exitCode, 4, JSON.stringify(first));
  assert.equal(first.envelope.error?.code, "operation_manual_pause");
  assert.equal(a.installCalls, 1); assert.equal(a.groupCalls, 1); assert.equal(a.probeCalls, 0);
  let state = await x.state();
  assert.equal(state.in_flight_operation, null, "known group effect is checkpointed, never unknown retry");
  assert.equal(state.stages.find(s => s.id === "S04")?.status, "awaiting_manual");
  const journal = (await fs.readFile(path.join(x.config.paths.setup_state_dir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { operation_id: string; code: string });
  assert.ok(journal.some(r => r.operation_id.includes("docker-group-membership") && r.code === "checkpoint"));
  e = makeEngine(); // discard all process-local stage data
  const stillOldSession = await e.run("resume", { configPath: x.configPath });
  assert.equal(stillOldSession.exitCode, 4, JSON.stringify(stillOldSession));
  assert.equal(a.installCalls, 1); assert.equal(a.groupCalls, 1); assert.equal(a.probeCalls, 0);
  // An admission refusal before resource probe must not create an unknown effect intent.
  state = await x.state();
  assert.equal(state.in_flight_operation, null);
  a.observation.dockerGroup.currentUserInGroup = true;
  a.observation.reloginRequired = false;
  e = makeEngine();
  await x.planAndApprove(e); // remaining config/restart effects need fresh plan-bound owner approvals
  const resumed = await e.run("resume", { configPath: x.configPath });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(a.installCalls, 1); assert.equal(a.groupCalls, 1); assert.equal(a.probeCalls, 1); assert.equal(a.markManagedCalls, 1);
  assert.equal((await x.state()).stages.find(s => s.id === "S04")?.status, "verified");
  const again = await e.run("resume", { configPath: x.configPath });
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.equal(a.installCalls, 1); assert.equal(a.probeCalls, 1);
});

test("U06 engine never adopts unmanaged matching Docker without durable install progress", async () => {
  const x = await r14Fixture("S04"), a = new FakeDockerAdapter(baseObservation());
  a.observation.dockerInstalled = true;
  for (const p of a.observation.packages) p.installedVersion = p.candidateVersion;
  const e = x.engine([r14Noop("S03"), createDockerStage(a)]);
  await x.planAndApprove(e);
  const result = await e.run("apply", x.applyOptions);
  assert.equal(result.exitCode, 5, JSON.stringify(result)); assert.equal(result.envelope.error?.code, "s04_existing_docker_requires_inspection");
  assert.equal(a.installCalls + a.mergeCalls + a.groupCalls + a.probeCalls + a.markManagedCalls, 0);
});
