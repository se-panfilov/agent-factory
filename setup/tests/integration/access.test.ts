import test from "node:test";
import assert from "node:assert/strict";
import { createAccessStage, type AccessAdapter, type AccessRuntimeObservation } from "../../src/stages/access";
import { ExitCode, type StageContext } from "../../src/core/types";

function ctx(): StageContext {
  return {
    installationId: "0f71966d-ef6f-4976-97cb-eb34cb139204",
    contractVersion: "1.0.0",
    profile: "supervised",
    desiredHash: "d".repeat(64),
    planHash: "p".repeat(64)
  };
}

function baseObservation(): AccessRuntimeObservation {
  return {
    tailscale: {
      installedVersion: null,
      candidateVersion: "1.84.0",
      loginState: "connected",
      privateSshReachable: true
    },
    ssh: {
      port: 22,
      hasMatchBlocks: false,
      users: ["factory"],
      configHash: "ssh-config-hash"
    },
    firewall: {
      manager: "ufw",
      enabled: true,
      defaultIncomingPolicy: "deny",
      ipv6Enabled: true,
      rulesHash: "ufw-rules-hash"
    },
    publicExposure: {
      ipv4SshReachable: false,
      ipv6SshReachable: false
    },
    manual: {
      providerConsoleConfirmed: true,
      secondSessionValidated: true,
      secondSessionHasSudo: true,
      tailscaleLoginConfirmed: true,
      cutoverAckConfirmed: true
    },
    rollback: {
      timerTemplatePresent: true,
      serviceTemplatePresent: true,
      armed: false
    },
    diff: {
      sshd: "Port 22 -> 22 (drop-in only)",
      firewall: "allow tailscale0, deny public 22 ipv4/ipv6"
    }
  };
}

class FakeAccessAdapter implements AccessAdapter {
  constructor(public observation: AccessRuntimeObservation) {}

  installCalls = 0;
  stageCalls = 0;
  armCalls = 0;
  cutoverCalls = 0;
  disarmCalls = 0;
  rollbackCalls = 0;
  verifyPrivateResult = true;

  async observe(): Promise<AccessRuntimeObservation> {
    return JSON.parse(JSON.stringify(this.observation)) as AccessRuntimeObservation;
  }

  async installPinnedTailscale(version: string): Promise<void> {
    this.installCalls += 1;
    this.observation.tailscale.installedVersion = version;
  }

  async validateSshdCandidate(): Promise<void> {
    return;
  }

  async stageManagedCutover(): Promise<void> {
    this.stageCalls += 1;
  }

  async armRollbackTimer(): Promise<void> {
    this.armCalls += 1;
    this.observation.rollback.armed = true;
  }

  async applyCutover(): Promise<void> {
    this.cutoverCalls += 1;
    this.observation.publicExposure.ipv4SshReachable = false;
    this.observation.publicExposure.ipv6SshReachable = false;
  }

  async verifyPrivateTailnetAccess(): Promise<boolean> {
    return this.verifyPrivateResult;
  }

  async disarmRollbackTimer(): Promise<void> {
    this.disarmCalls += 1;
    this.observation.rollback.armed = false;
  }

  async rollbackManagedCutover(): Promise<{ ok: boolean; details: string }> {
    this.rollbackCalls += 1;
    this.observation.rollback.armed = false;
    return { ok: true, details: "rolled back" };
  }
}

test("S03 plan includes console/second-login/tailscale/cutover gates and staged operations", async () => {
  const adapter = new FakeAccessAdapter(baseObservation());
  adapter.observation.manual.providerConsoleConfirmed = false;
  adapter.observation.manual.secondSessionValidated = false;

  const stage = createAccessStage(adapter);
  const observation = await stage.observe(ctx());
  assert.equal(observation.stageId, "S03");
  assert.equal(observation.status, "awaiting_manual");

  const plan = stage.plan({}, observation);
  assert.equal(plan.operations.length >= 5, true);
  assert.equal(plan.requiredGates.includes("s03-provider-console-confirmed"), true);
  assert.equal(plan.requiredGates.includes("s03-second-session-validated"), true);
  assert.equal(plan.requiredGates.includes("s03-firewall-cutover-approved"), true);
  assert.equal(plan.requiredGates.includes("s03-cutover-acknowledged"), true);
});

test("S03 apply performs staged cutover and disarms rollback after ack", async () => {
  const adapter = new FakeAccessAdapter(baseObservation());
  const stage = createAccessStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  const receipts = await stage.apply(ctx(), plan);
  assert.equal(receipts.length, 1);
  assert.equal(adapter.installCalls, 1);
  assert.equal(adapter.stageCalls, 1);
  assert.equal(adapter.armCalls, 1);
  assert.equal(adapter.cutoverCalls, 1);
  assert.equal(adapter.disarmCalls, 1);
  assert.equal(adapter.rollbackCalls, 0);
  assert.equal(adapter.observation.rollback.armed, false);
});

test("S03 rolls back when private tailnet verification fails after cutover", async () => {
  const adapter = new FakeAccessAdapter(baseObservation());
  adapter.verifyPrivateResult = false;

  const stage = createAccessStage(adapter);
  const observation = await stage.observe(ctx());
  const plan = stage.plan({}, observation);

  await assert.rejects(
    async () => stage.apply(ctx(), plan),
    (error) => {
      return (
        error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "s03_tailnet_private_login_failed"
        && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
      );
    }
  );

  assert.equal(adapter.rollbackCalls, 1);
  assert.equal(adapter.observation.rollback.armed, false);
});

test("S03 verify fails when IPv6 public SSH remains reachable", async () => {
  const adapter = new FakeAccessAdapter(baseObservation());
  adapter.observation.publicExposure.ipv6SshReachable = true;

  const stage = createAccessStage(adapter);

  await assert.rejects(
    async () => stage.verify(ctx()),
    (error) => {
      return (
        error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "s03_public_ssh_exposed"
        && (error as { exitCode?: number }).exitCode === ExitCode.DriftOrRecoveryRequired
      );
    }
  );
});
