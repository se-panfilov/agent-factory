import test from "node:test";
import assert from "node:assert/strict";
import { createAccessStage, type AccessAdapter, type AccessRuntimeObservation } from "../../src/stages/access";
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

function baseObservation(): AccessRuntimeObservation {
  return {
    securityInputs: { contentHash: "synthetic-config-content", ownershipHash: "synthetic-root-owner-modes" },
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
  assert.equal(receipts.length, plan.operations.length);
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

// Production composition: the engine passes a single operation per call.
import { r14Fixture, r14Noop } from "../helpers/r14-engine";
for (const mode of ["normal", "before", "between", "during-install", "tailnet-failure", "ownership-before", "ownership-between", "diff-before", "manual-before"] as const) {
  test(`U01 S03 engine ${mode}: reviewed inputs and own transitions`, async () => {
    const x = await r14Fixture("S03"), adapter = new FakeAccessAdapter(baseObservation());
    if (mode === "tailnet-failure") adapter.verifyPrivateResult = false;
    const originalInstall = adapter.installPinnedTailscale.bind(adapter);
    adapter.installPinnedTailscale = async version => {
      await originalInstall(version);
      if (mode === "during-install") adapter.observation.ssh.configHash = "foreign-during-install";
    };
    // Change after the first operation's confirmed receipt, at the next adapter admission observation.
    const originalObserve = adapter.observe.bind(adapter);
    let postInstallObservations = 0;
    adapter.observe = async () => {
      if (adapter.installCalls > 0 && ++postInstallObservations === 2) {
        if (mode === "between") adapter.observation.firewall.rulesHash = "foreign-between-operations";
        if (mode === "ownership-between") adapter.observation.securityInputs.ownershipHash = "changed-owner-between";
      }
      return originalObserve();
    };
    const e = x.engine([r14Noop("S02"), createAccessStage(adapter)]);
    await x.planAndApprove(e);
    if (mode === "before") adapter.observation.ssh.configHash = "foreign-before-first-effect";
    if (mode === "ownership-before") adapter.observation.securityInputs.ownershipHash = "changed-owner-before";
    if (mode === "diff-before") adapter.observation.diff.sshd = "unapproved complete SSH diff";
    if (mode === "manual-before") adapter.observation.manual.cutoverAckConfirmed = false;
    const result = await e.run("apply", x.applyOptions);
    if (mode === "normal") {
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(adapter.cutoverCalls, 1); assert.equal(adapter.disarmCalls, 1);
      assert.equal((await x.state()).stages.find(s => s.id === "S03")?.status, "verified");
    } else if (mode === "tailnet-failure") {
      assert.equal(result.exitCode, 4, JSON.stringify(result)); assert.equal(adapter.rollbackCalls, 1); assert.equal(adapter.disarmCalls, 0);
    } else {
      assert.equal(result.exitCode, 4, JSON.stringify(result)); assert.equal(result.envelope.error?.code, "s03_observation_drifted");
      assert.equal(adapter.cutoverCalls, 0); assert.equal(adapter.stageCalls, 0);
      assert.equal(adapter.installCalls, ["before", "ownership-before", "diff-before", "manual-before"].includes(mode) ? 0 : 1);
      if (["before", "ownership-before", "diff-before", "manual-before"].includes(mode)) {
        assert.equal((await x.state()).in_flight_operation, null, "pre-effect admission refusal permits a new reviewed plan without inventing unknown effect");
      }
    }
  });
}

import { observeAccessInputProof } from "../../src/stages/access";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("U01 real input proof hashes raw config and ownership and refuses unsafe/unbounded input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "af-r14-access-inputs-"));
  const target = new NodeFilesystemAdapter();
  const mapped = (p: string) => path.join(root, p.replace(/^\/+/, ""));
  await fs.mkdir(mapped("/etc/ssh/sshd_config.d"), { recursive: true, mode: 0o700 });
  await fs.writeFile(mapped("/etc/ssh/sshd_config"), "Port 22\n", { mode: 0o600 });
  let owner = 0, bounds: number[] = [];
  const adapter = new Proxy(target, { get(t, key, receiver) {
    if (key === "lstat") return async (p: string) => Object.assign(await t.lstat(mapped(p)), { uid: owner, gid: 0 });
    if (key === "readdir") return (p: string) => t.readdir(mapped(p));
    if (key === "readTextBounded") return (p: string, max: number) => { bounds.push(max); return t.readTextBounded(mapped(p), max); };
    const value: unknown = Reflect.get(t, key, receiver); return typeof value === "function" ? value.bind(t) : value;
  } });
  const first = await observeAccessInputProof(adapter, 1000, "/manual");
  await fs.writeFile(mapped("/etc/ssh/sshd_config"), "Port 22\n# changed raw input\n");
  const second = await observeAccessInputProof(adapter, 1000, "/manual");
  assert.notEqual(first.contentHash, second.contentHash); assert.equal(first.ownershipHash, second.ownershipHash);
  owner = 1;
  await assert.rejects(() => observeAccessInputProof(adapter, 1000, "/manual"), { code: "s03_security_input_ownership_unsafe" });
  owner = 0;
  await fs.writeFile(mapped("/etc/ssh/sshd_config"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(() => observeAccessInputProof(adapter, 1000, "/manual"), { code: "s03_security_input_oversized" });
  assert.ok(bounds.length >= 3 && bounds.every(n => n === 256 * 1024));
  await fs.unlink(mapped("/etc/ssh/sshd_config"));
  await fs.symlink("/foreign", mapped("/etc/ssh/sshd_config"));
  await assert.rejects(() => observeAccessInputProof(adapter, 1000, "/manual"), { code: "s03_security_input_ownership_unsafe" });
});
