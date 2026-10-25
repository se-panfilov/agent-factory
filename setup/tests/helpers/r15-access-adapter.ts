// Fixture effects remain fake; V10 observation hashes come from the actual collector.
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

export function baseObservation(): AccessRuntimeObservation {
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

export class FakeAccessAdapter implements AccessAdapter {
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
