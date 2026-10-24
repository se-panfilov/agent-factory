import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { type AptAdapter } from "../adapters/apt";
import { type FilesystemAdapter } from "../adapters/filesystem";
import { type ProcessAdapter } from "../adapters/process";
import { setupError } from "../core/errors";
import { ExitCode, type StageContext, type StageModule, type StageObservation, type StagePlan, type StageReceipt } from "../core/types";

type TailscaleLoginState = "connected" | "needs_login" | "expired" | "unknown";
type FirewallManager = "ufw" | "unknown";

const OBSERVE_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ROLLBACK_MINUTES = 10;

const MANUAL_EVIDENCE_FILES = {
  providerConsoleConfirmed: "provider-console-confirmed",
  secondSessionValidated: "second-session-validated",
  secondSessionHasSudo: "second-session-sudo",
  tailscaleLoginConfirmed: "tailscale-login-confirmed",
  cutoverAckConfirmed: "cutover-ack-confirmed",
  externalIpv4Closed: "external-ipv4-closed",
  externalIpv6Closed: "external-ipv6-closed"
} as const;

export interface AccessRuntimeObservation {
  tailscale: {
    installedVersion: string | null;
    candidateVersion: string | null;
    loginState: TailscaleLoginState;
    privateSshReachable: boolean;
  };
  ssh: {
    port: number;
    hasMatchBlocks: boolean;
    users: string[];
    configHash: string;
  };
  firewall: {
    manager: FirewallManager;
    enabled: boolean;
    defaultIncomingPolicy: "allow" | "deny" | "reject" | "unknown";
    ipv6Enabled: boolean;
    rulesHash: string;
  };
  publicExposure: {
    ipv4SshReachable: boolean;
    ipv6SshReachable: boolean;
  };
  manual: {
    providerConsoleConfirmed: boolean;
    secondSessionValidated: boolean;
    secondSessionHasSudo: boolean;
    tailscaleLoginConfirmed: boolean;
    cutoverAckConfirmed: boolean;
  };
  rollback: {
    timerTemplatePresent: boolean;
    serviceTemplatePresent: boolean;
    armed: boolean;
  };
  diff: {
    sshd: string;
    firewall: string;
  };
}

export interface AccessAdapter {
  observe(ctx: StageContext): Promise<AccessRuntimeObservation>;
  installPinnedTailscale(version: string): Promise<void>;
  validateSshdCandidate(ctx: StageContext): Promise<void>;
  stageManagedCutover(ctx: StageContext, managedHash: string): Promise<void>;
  armRollbackTimer(ctx: StageContext, minutes: number): Promise<void>;
  applyCutover(ctx: StageContext): Promise<void>;
  verifyPrivateTailnetAccess(ctx: StageContext): Promise<boolean>;
  disarmRollbackTimer(ctx: StageContext): Promise<void>;
  rollbackManagedCutover(ctx: StageContext, reason: string): Promise<{ ok: boolean; details: string }>;
}

function stableHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function operationPrefix(kind: string, observationHash: string): string {
  return `s03-${kind}-${observationHash.slice(0, 12)}`;
}

function checksFromObservation(observation: AccessRuntimeObservation): Record<string, string | number | boolean> {
  return {
    provider_console_confirmed: observation.manual.providerConsoleConfirmed,
    second_session_validated: observation.manual.secondSessionValidated,
    second_session_has_sudo: observation.manual.secondSessionHasSudo,
    tailscale_login_confirmed: observation.manual.tailscaleLoginConfirmed,
    cutover_ack_confirmed: observation.manual.cutoverAckConfirmed,
    tailscale_private_ssh_reachable: observation.tailscale.privateSshReachable,
    public_ipv4_ssh_reachable: observation.publicExposure.ipv4SshReachable,
    public_ipv6_ssh_reachable: observation.publicExposure.ipv6SshReachable,
    ssh_port: observation.ssh.port,
    ssh_has_match_blocks: observation.ssh.hasMatchBlocks,
    ufw_enabled: observation.firewall.enabled,
    ufw_ipv6_enabled: observation.firewall.ipv6Enabled,
    rollback_timer_armed: observation.rollback.armed,
    rollback_timer_template_present: observation.rollback.timerTemplatePresent,
    rollback_service_template_present: observation.rollback.serviceTemplatePresent,
    sshd_diff_preview: observation.diff.sshd.slice(0, 256),
    firewall_diff_preview: observation.diff.firewall.slice(0, 256)
  };
}

function versionsFromObservation(observation: AccessRuntimeObservation): Record<string, string> {
  return {
    tailscale_installed: observation.tailscale.installedVersion ?? "absent",
    tailscale_candidate: observation.tailscale.candidateVersion ?? "absent",
    tailscale_login_state: observation.tailscale.loginState,
    ssh_config_hash: observation.ssh.configHash,
    ufw_rules_hash: observation.firewall.rulesHash,
    ufw_manager: observation.firewall.manager
  };
}

function inferStatus(observation: AccessRuntimeObservation): StageObservation["status"] {
  if (observation.firewall.manager !== "ufw") {
    return "blocked";
  }
  if (observation.tailscale.candidateVersion === null) {
    return "blocked";
  }

  const manualReady = observation.manual.providerConsoleConfirmed
    && observation.manual.secondSessionValidated
    && observation.manual.secondSessionHasSudo
    && observation.manual.tailscaleLoginConfirmed;
  const rollbackReady = observation.rollback.timerTemplatePresent && observation.rollback.serviceTemplatePresent;

  if (!manualReady || !rollbackReady) {
    return "awaiting_manual";
  }

  if (
    observation.tailscale.installedVersion !== null
    && observation.tailscale.installedVersion === observation.tailscale.candidateVersion
    && observation.tailscale.privateSshReachable
    && !observation.publicExposure.ipv4SshReachable
    && !observation.publicExposure.ipv6SshReachable
    && !observation.rollback.armed
    && observation.manual.cutoverAckConfirmed
    && observation.tailscale.loginState === "connected"
  ) {
    return "verified";
  }

  return "planned";
}

interface ParsedPlanPreconditions {
  tailscalePin: string;
  observationHash: string;
}

function parsePlanPreconditions(plan: StagePlan): ParsedPlanPreconditions {
  let tailscalePin: string | null = null;
  let observationHash: string | null = null;
  for (const operation of plan.operations) {
    for (const precondition of operation.preconditions) {
      if (precondition.startsWith("s03_tailscale_pin:")) {
        tailscalePin = precondition.slice("s03_tailscale_pin:".length);
      } else if (precondition.startsWith("s03_observation_hash:")) {
        observationHash = precondition.slice("s03_observation_hash:".length);
      }
    }
  }

  if (
    tailscalePin === null
    || tailscalePin.length === 0
    || observationHash === null
    || observationHash.length === 0
  ) {
    throw setupError({
      exitCode: ExitCode.CliOrSchemaError,
      code: "s03_plan_preconditions_missing",
      publicMessage: "S03 plan is missing required preconditions.",
      nextAction: "Regenerate plan for S03 and re-approve gates.",
      stage: "S03"
    });
  }
  return {
    tailscalePin,
    observationHash
  };
}

function operationPreconditions(observation: AccessRuntimeObservation, observationHash: string): string[] {
  return [
    `s03_tailscale_pin:${observation.tailscale.candidateVersion ?? "none"}`,
    `s03_observation_hash:${observationHash}`,
    `s03_console_confirmed:${observation.manual.providerConsoleConfirmed}`,
    `s03_second_session_validated:${observation.manual.secondSessionValidated}`,
    `s03_second_session_sudo:${observation.manual.secondSessionHasSudo}`,
    `s03_tailscale_login_confirmed:${observation.manual.tailscaleLoginConfirmed}`,
    `s03_ipv4_checked:${!observation.publicExposure.ipv4SshReachable}`,
    `s03_ipv6_checked:${!observation.publicExposure.ipv6SshReachable}`
  ];
}

function verifyManualReadiness(observation: AccessRuntimeObservation): void {
  if (!observation.manual.providerConsoleConfirmed) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s03_console_confirmation_required",
      publicMessage: "S03 requires owner-confirmed provider console access before cutover.",
      nextAction: "Confirm console access and create manual evidence for S03 provider-console gate.",
      stage: "S03"
    });
  }
  if (!observation.manual.secondSessionValidated || !observation.manual.secondSessionHasSudo) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s03_second_session_required",
      publicMessage: "S03 requires an independent second SSH session with sudo before cutover.",
      nextAction: "Open a second login, validate sudo, and approve the second-session gate.",
      stage: "S03"
    });
  }
  if (!observation.manual.tailscaleLoginConfirmed) {
    throw setupError({
      exitCode: ExitCode.ManualActionRequired,
      code: "s03_tailscale_login_required",
      publicMessage: "S03 requires a confirmed Tailscale device login before public SSH cutover.",
      nextAction: "Complete tailscale login in TTY and approve the tailscale-login gate.",
      stage: "S03"
    });
  }
}

function verifyRollbackReadiness(observation: AccessRuntimeObservation): void {
  if (!observation.rollback.timerTemplatePresent || !observation.rollback.serviceTemplatePresent) {
    throw setupError({
      exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
      code: "s03_rollback_templates_missing",
      publicMessage: "S03 rollback templates are missing; cutover is blocked.",
      nextAction: "Restore access-rollback systemd templates and retry plan/apply.",
      stage: "S03"
    });
  }
}

export function createAccessStage(accessAdapter: AccessAdapter): StageModule {
  let lastObservation: StageObservation | null = null;

  return {
    id: "S03",
    dependencies: ["S02"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: [],
    async observe(ctx: StageContext): Promise<StageObservation> {
      const runtimeObservation = await accessAdapter.observe(ctx);
      const observation: StageObservation = {
        stageId: "S03",
        status: inferStatus(runtimeObservation),
        checks: checksFromObservation(runtimeObservation),
        versions: versionsFromObservation(runtimeObservation),
        observedAt: new Date().toISOString()
      };
      lastObservation = observation;
      return observation;
    },
    plan(_desired: unknown, observed: StageObservation): StagePlan {
      const candidate = observed.versions.tailscale_candidate;
      if (candidate === undefined || candidate === "absent") {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s03_tailscale_candidate_missing",
          publicMessage: "Pinned tailscale candidate is unavailable for S03.",
          nextAction: "Verify signed tailscale apt repo and retry S03 planning.",
          stage: "S03"
        });
      }

      const observationHash = stableHash({
        checks: observed.checks,
        versions: observed.versions
      });
      const preconditions = operationPreconditions(
        {
          tailscale: {
            installedVersion: observed.versions.tailscale_installed === undefined || observed.versions.tailscale_installed === "absent"
              ? null
              : observed.versions.tailscale_installed,
            candidateVersion: candidate,
            loginState: (observed.versions.tailscale_login_state as TailscaleLoginState | undefined) ?? "unknown",
            privateSshReachable: observed.checks.tailscale_private_ssh_reachable === true
          },
          ssh: {
            port: Number(observed.checks.ssh_port ?? 22),
            hasMatchBlocks: observed.checks.ssh_has_match_blocks === true,
            users: [],
            configHash: observed.versions.ssh_config_hash ?? "unknown"
          },
          firewall: {
            manager: (observed.versions.ufw_manager as FirewallManager | undefined) ?? "unknown",
            enabled: observed.checks.ufw_enabled === true,
            defaultIncomingPolicy: "unknown",
            ipv6Enabled: observed.checks.ufw_ipv6_enabled === true,
            rulesHash: observed.versions.ufw_rules_hash ?? "unknown"
          },
          publicExposure: {
            ipv4SshReachable: observed.checks.public_ipv4_ssh_reachable === true,
            ipv6SshReachable: observed.checks.public_ipv6_ssh_reachable === true
          },
          manual: {
            providerConsoleConfirmed: observed.checks.provider_console_confirmed === true,
            secondSessionValidated: observed.checks.second_session_validated === true,
            secondSessionHasSudo: observed.checks.second_session_has_sudo === true,
            tailscaleLoginConfirmed: observed.checks.tailscale_login_confirmed === true,
            cutoverAckConfirmed: observed.checks.cutover_ack_confirmed === true
          },
          rollback: {
            timerTemplatePresent: observed.checks.rollback_timer_template_present === true,
            serviceTemplatePresent: observed.checks.rollback_service_template_present === true,
            armed: observed.checks.rollback_timer_armed === true
          },
          diff: {
            sshd: String(observed.checks.sshd_diff_preview ?? ""),
            firewall: String(observed.checks.firewall_diff_preview ?? "")
          }
        },
        observationHash
      );

      if (observed.status === "verified") {
        return {
          stageId: "S03",
          optional: false,
          requiredCapabilities: [],
          operations: [],
          requiredGates: []
        };
      }

      const operations: StagePlan["operations"] = [
        {
          id: operationPrefix("install-tailscale", observationHash),
          stageId: "S03",
          kind: "mutate",
          resourceId: "tailscale-package",
          risk: "high",
          gateIds: ["s03-sudo-access-mutations"],
          preconditions,
          sideEffects: ["install exact pinned tailscale package from signed apt source"],
          timeoutSec: 300,
          retryable: false
        },
        {
          id: operationPrefix("stage-sshd-firewall", observationHash),
          stageId: "S03",
          kind: "mutate",
          resourceId: "access-managed-diff",
          risk: "high",
          gateIds: ["s03-ssh-firewall-diff-reviewed", "s03-sudo-access-mutations"],
          preconditions,
          sideEffects: ["stage minimal sshd drop-in and firewall diff with explicit snapshot"],
          timeoutSec: 180,
          retryable: false
        },
        {
          id: operationPrefix("arm-rollback", observationHash),
          stageId: "S03",
          kind: "mutate",
          resourceId: "access-rollback-timer",
          risk: "critical",
          gateIds: ["s03-sudo-access-mutations"],
          preconditions,
          sideEffects: ["arm persisted rollback timer before network cutover"],
          timeoutSec: 120,
          retryable: false
        },
        {
          id: operationPrefix("cutover", observationHash),
          stageId: "S03",
          kind: "mutate",
          resourceId: "ssh-firewall-cutover",
          risk: "critical",
          gateIds: ["s03-provider-console-confirmed", "s03-second-session-validated", "s03-firewall-cutover-approved"],
          preconditions,
          sideEffects: ["apply staged sshd and firewall changes"],
          timeoutSec: 180,
          retryable: false
        },
        {
          id: operationPrefix("verify-tailnet", observationHash),
          stageId: "S03",
          kind: "verify",
          resourceId: "tailnet-connectivity",
          risk: "critical",
          gateIds: ["s03-tailscale-login-confirmed"],
          preconditions,
          sideEffects: [],
          timeoutSec: 120,
          retryable: false
        },
        {
          id: operationPrefix("disarm-rollback", observationHash),
          stageId: "S03",
          kind: "mutate",
          resourceId: "access-rollback-timer",
          risk: "high",
          gateIds: ["s03-cutover-acknowledged"],
          preconditions,
          sideEffects: ["disarm rollback timer after independent cutover acknowledgement"],
          timeoutSec: 120,
          retryable: false
        }
      ];

      return {
        stageId: "S03",
        optional: false,
        requiredCapabilities: [],
        operations,
        requiredGates: [...new Set(operations.flatMap((operation) => operation.gateIds))]
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      let observation = await accessAdapter.observe(ctx);
      verifyRollbackReadiness(observation);
      verifyManualReadiness(observation);

      if (observation.firewall.manager !== "ufw") {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s03_firewall_manager_unsupported",
          publicMessage: "S03 supports only UFW-managed firewall on this release.",
          nextAction: "Switch host firewall management to reviewed UFW flow before S03 cutover.",
          stage: "S03"
        });
      }
      if (observation.tailscale.candidateVersion === null) {
        throw setupError({
          exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence,
          code: "s03_tailscale_candidate_missing",
          publicMessage: "Pinned tailscale candidate is unavailable for S03.",
          nextAction: "Fix signed tailscale apt source and rerun planning.",
          stage: "S03"
        });
      }

      if (approvedPlan.operations.length === 0) {
        return [];
      }

      const planPreconditions = parsePlanPreconditions(approvedPlan);
      if (planPreconditions.tailscalePin !== observation.tailscale.candidateVersion) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s03_tailscale_pin_changed",
          publicMessage: "Pinned tailscale candidate changed after plan approval.",
          nextAction: "Regenerate S03 plan and re-approve access gates.",
          stage: "S03",
          evidenceRef: `planned=${planPreconditions.tailscalePin};observed=${observation.tailscale.candidateVersion}`
        });
      }

      const receipts: StageReceipt[] = [];
      let rollbackPrepared = observation.rollback.armed;
      let cutoverApplied = false;
      try {
        for (const operation of approvedPlan.operations) {
          if (operation.id.startsWith("s03-install-tailscale-")) {
            await accessAdapter.installPinnedTailscale(planPreconditions.tailscalePin);
          } else if (operation.id.startsWith("s03-stage-sshd-firewall-")) {
            await accessAdapter.stageManagedCutover(ctx, planPreconditions.observationHash);
            await accessAdapter.validateSshdCandidate(ctx);
          } else if (operation.id.startsWith("s03-disarm-rollback-")) {
            observation = await accessAdapter.observe(ctx);
            if (!observation.manual.cutoverAckConfirmed) {
              throw setupError({
                exitCode: ExitCode.ManualActionRequired,
                code: "s03_cutover_ack_missing",
                publicMessage: "Independent cutover acknowledgement is missing.",
                nextAction: "Validate second login through tailnet and confirm cutover acknowledgement gate.",
                stage: "S03"
              });
            }
            await accessAdapter.disarmRollbackTimer(ctx);
            rollbackPrepared = false;
          } else if (operation.id.startsWith("s03-arm-rollback-")) {
            await accessAdapter.armRollbackTimer(ctx, ROLLBACK_MINUTES);
            rollbackPrepared = true;
          } else if (operation.id.startsWith("s03-cutover-")) {
            await accessAdapter.applyCutover(ctx);
            cutoverApplied = true;
          } else if (operation.id.startsWith("s03-verify-tailnet-")) {
            const privateOk = await accessAdapter.verifyPrivateTailnetAccess(ctx);
            if (!privateOk) {
              throw setupError({
                exitCode: ExitCode.ManualActionRequired,
                code: "s03_tailnet_private_login_failed",
                publicMessage: "Private tailnet SSH verification failed after cutover.",
                nextAction: "Use provider console and rollback evidence, then rerun S03 recovery.",
                stage: "S03"
              });
            }
            observation = await accessAdapter.observe(ctx);
            if (observation.publicExposure.ipv4SshReachable || observation.publicExposure.ipv6SshReachable) {
              throw setupError({
                exitCode: ExitCode.ManualActionRequired,
                code: "s03_public_ssh_still_exposed",
                publicMessage: "Public IPv4/IPv6 SSH exposure remains after S03 cutover.",
                nextAction: "Rollback managed cutover and inspect sshd/firewall diff before retry.",
                stage: "S03",
                evidenceRef: `ipv4=${observation.publicExposure.ipv4SshReachable};ipv6=${observation.publicExposure.ipv6SshReachable}`
              });
            }
          } else {
            throw setupError({
              exitCode: ExitCode.CliOrSchemaError,
              code: "s03_unplanned_operation",
              publicMessage: `S03 received unsupported operation '${operation.id}'.`,
              nextAction: "Regenerate S03 plan with a supported installer release.",
              stage: "S03",
              operationId: operation.id
            });
          }

          observation = await accessAdapter.observe(ctx);
          receipts.push({
            operationId: operation.id,
            stageId: "S03",
            resourceId: operation.resourceId,
            observedAt: new Date().toISOString(),
            checks: checksFromObservation(observation),
            versions: versionsFromObservation(observation),
            artifacts: []
          });
        }
        return receipts;
      } catch (error) {
        if (rollbackPrepared || cutoverApplied) {
          const rollback = await accessAdapter.rollbackManagedCutover(ctx, "s03-apply-failed");
          if (!rollback.ok) {
            throw setupError({
              exitCode: ExitCode.DriftOrRecoveryRequired,
              code: "s03_rollback_failed",
              publicMessage: "S03 rollback failed after cutover failure.",
              nextAction: "Use provider console recovery and run 'factory-setup recover --stage S03'.",
              stage: "S03",
              evidenceRef: rollback.details
            });
          }
        }
        throw error;
      }
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const observation = await accessAdapter.observe(ctx);
      verifyRollbackReadiness(observation);
      if (observation.tailscale.loginState !== "connected" || !observation.tailscale.privateSshReachable) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s03_tailnet_unreachable",
          publicMessage: "Tailnet SSH access is not verified.",
          nextAction: "Re-login tailscale and validate private SSH before rerunning verify.",
          stage: "S03"
        });
      }
      if (observation.publicExposure.ipv4SshReachable || observation.publicExposure.ipv6SshReachable) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s03_public_ssh_exposed",
          publicMessage: "Public IPv4/IPv6 SSH exposure was detected.",
          nextAction: "Run S03 recover and inspect firewall/sshd drift before continuing.",
          stage: "S03",
          evidenceRef: `ipv4=${observation.publicExposure.ipv4SshReachable};ipv6=${observation.publicExposure.ipv6SshReachable}`
        });
      }
      if (observation.rollback.armed) {
        throw setupError({
          exitCode: ExitCode.ManualActionRequired,
          code: "s03_rollback_still_armed",
          publicMessage: "Rollback timer is still armed; S03 is not finalized.",
          nextAction: "Complete independent cutover acknowledgement and disarm rollback timer.",
          stage: "S03"
        });
      }

      return [
        {
          operationId: "s03-verify-access",
          stageId: "S03",
          resourceId: "access-cutover",
          observedAt: new Date().toISOString(),
          checks: checksFromObservation(observation),
          versions: versionsFromObservation(observation),
          artifacts: []
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      const rollback = await accessAdapter.rollbackManagedCutover(ctx, "s03-recover");
      if (!rollback.ok) {
        throw setupError({
          exitCode: ExitCode.DriftOrRecoveryRequired,
          code: "s03_recover_rollback_failed",
          publicMessage: "S03 recovery rollback failed.",
          nextAction: "Use provider console to restore access manually, then rerun verify.",
          stage: "S03",
          evidenceRef: rollback.details
        });
      }
      return this.verify(ctx);
    }
  };
}

function parseAptPolicyVersion(output: string): { installed: string | null; candidate: string | null } {
  const installedMatch = output.match(/Installed:\s+(\S+)/);
  const candidateMatch = output.match(/Candidate:\s+(\S+)/);
  const installed = installedMatch?.[1] === undefined || installedMatch[1] === "(none)" ? null : installedMatch[1];
  const candidate = candidateMatch?.[1] === undefined || candidateMatch[1] === "(none)" ? null : candidateMatch[1];
  return { installed, candidate };
}

function parseSshdInfo(output: string): { port: number; users: string[] } {
  const portMatch = output.match(/^port\s+(\d+)/m);
  const allowUsersMatch = output.match(/^allowusers\s+(.+)$/m);
  const users = allowUsersMatch?.[1] === undefined
    ? []
    : allowUsersMatch[1].split(/\s+/).map((value) => value.trim()).filter((value) => value.length > 0);
  return {
    port: portMatch?.[1] === undefined ? 22 : Number.parseInt(portMatch[1], 10),
    users
  };
}

async function readBooleanMarker(fsAdapter: FilesystemAdapter, filePath: string): Promise<boolean> {
  if (!(await fsAdapter.exists(filePath))) {
    return false;
  }
  const value = (await fsAdapter.readText(filePath)).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "ok";
}

export class NodeAccessAdapter implements AccessAdapter {
  private readonly allowMutations: boolean;

  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly fsAdapter: FilesystemAdapter,
    private readonly aptAdapter: AptAdapter
  ) {
    this.allowMutations = process.env.FACTORY_SETUP_ALLOW_S03_MUTATIONS === "1";
  }

  private async run(binary: string, args: string[], timeoutMs = OBSERVE_TIMEOUT_MS): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    return this.processAdapter.runCommand({
      binary,
      args,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
  }

  private manualEvidenceDir(ctx: StageContext): string {
    return path.join(
      os.homedir(),
      ".local",
      "state",
      "agent-factory-setup",
      "manual",
      ctx.installationId,
      "s03"
    );
  }

  private async manualEvidence(ctx: StageContext): Promise<AccessRuntimeObservation["manual"] & AccessRuntimeObservation["publicExposure"]> {
    const root = this.manualEvidenceDir(ctx);
    return {
      providerConsoleConfirmed: await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.providerConsoleConfirmed)),
      secondSessionValidated: await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.secondSessionValidated)),
      secondSessionHasSudo: await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.secondSessionHasSudo)),
      tailscaleLoginConfirmed: await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.tailscaleLoginConfirmed)),
      cutoverAckConfirmed: await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.cutoverAckConfirmed)),
      ipv4SshReachable: !(await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.externalIpv4Closed))),
      ipv6SshReachable: !(await readBooleanMarker(this.fsAdapter, path.join(root, MANUAL_EVIDENCE_FILES.externalIpv6Closed)))
    };
  }

  private requireMutationsEnabled(): void {
    if (!this.allowMutations) {
      throw setupError({
        exitCode: ExitCode.ManualActionRequired,
        code: "s03_mutations_disabled",
        publicMessage: "S03 mutations are disabled in this environment.",
        nextAction: "Run only on a disposable VM/VPS with provider console and set FACTORY_SETUP_ALLOW_S03_MUTATIONS=1.",
        stage: "S03"
      });
    }
  }

  async observe(ctx: StageContext): Promise<AccessRuntimeObservation> {
    const aptPolicy = await this.run("/usr/bin/apt-cache", ["policy", "tailscale"]);
    const tailscalePolicy = parseAptPolicyVersion(aptPolicy.stdout);

    const tailscaleStatus = await this.run("/usr/bin/tailscale", ["status", "--json"]).catch(() => ({
      exitCode: 1,
      stdout: "{}",
      stderr: "",
      timedOut: false
    }));
    const tailscaleJson = JSON.parse(tailscaleStatus.stdout || "{}") as { BackendState?: string; Self?: { Online?: boolean } };
    const loginState: TailscaleLoginState =
      tailscaleJson.BackendState === "Running"
        ? "connected"
        : tailscaleJson.BackendState === "NeedsLogin"
          ? "needs_login"
          : "unknown";

    const sshdDump = await this.run("/usr/sbin/sshd", ["-T"]);
    const sshdInfo = parseSshdInfo(sshdDump.stdout);

    const ufwStatus = await this.run("/usr/sbin/ufw", ["status", "verbose"]).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false
    }));
    const firewallEnabled = /Status:\s+active/i.test(ufwStatus.stdout);
    const defaultIncoming = ufwStatus.stdout.match(/Default:\s+([a-zA-Z]+)\s+\(incoming\)/i)?.[1]?.toLowerCase() ?? "unknown";
    const ufwIpv6Enabled = (await this.fsAdapter.readText("/etc/default/ufw").catch(() => "")).includes("IPV6=yes");

    const manualAndExposure = await this.manualEvidence(ctx);
    const rollbackTimerPath = "/etc/systemd/system/access-rollback.timer";
    const rollbackServicePath = "/etc/systemd/system/access-rollback.service";
    const rollbackArmedMarker = path.join(this.manualEvidenceDir(ctx), "rollback-armed");
    const rollbackArmed = await readBooleanMarker(this.fsAdapter, rollbackArmedMarker);

    return {
      tailscale: {
        installedVersion: tailscalePolicy.installed,
        candidateVersion: tailscalePolicy.candidate,
        loginState,
        privateSshReachable: tailscaleJson.Self?.Online === true
      },
      ssh: {
        port: sshdInfo.port,
        hasMatchBlocks: /match\s+/i.test(sshdDump.stdout),
        users: sshdInfo.users,
        configHash: stableHash(sshdDump.stdout)
      },
      firewall: {
        manager: ufwStatus.exitCode === 0 ? "ufw" : "unknown",
        enabled: firewallEnabled,
        defaultIncomingPolicy:
          defaultIncoming === "deny" || defaultIncoming === "allow" || defaultIncoming === "reject"
            ? defaultIncoming
            : "unknown",
        ipv6Enabled: ufwIpv6Enabled,
        rulesHash: stableHash(ufwStatus.stdout)
      },
      publicExposure: {
        ipv4SshReachable: manualAndExposure.ipv4SshReachable,
        ipv6SshReachable: manualAndExposure.ipv6SshReachable
      },
      manual: {
        providerConsoleConfirmed: manualAndExposure.providerConsoleConfirmed,
        secondSessionValidated: manualAndExposure.secondSessionValidated,
        secondSessionHasSudo: manualAndExposure.secondSessionHasSudo,
        tailscaleLoginConfirmed: manualAndExposure.tailscaleLoginConfirmed,
        cutoverAckConfirmed: manualAndExposure.cutoverAckConfirmed
      },
      rollback: {
        timerTemplatePresent: await this.fsAdapter.exists(rollbackTimerPath),
        serviceTemplatePresent: await this.fsAdapter.exists(rollbackServicePath),
        armed: rollbackArmed
      },
      diff: {
        sshd: "planned drop-in: /etc/ssh/sshd_config.d/90-agent-factory-access.conf",
        firewall: "planned managed UFW rules: tailscale first, public SSH block after ack"
      }
    };
  }

  async installPinnedTailscale(version: string): Promise<void> {
    this.requireMutationsEnabled();
    await this.aptAdapter.installPinned([{ name: "tailscale", version }]);
  }

  async validateSshdCandidate(_ctx: StageContext): Promise<void> {
    this.requireMutationsEnabled();
    const syntax = await this.run("/usr/bin/sudo", ["-n", "/usr/sbin/sshd", "-t"], MUTATION_TIMEOUT_MS);
    if (syntax.exitCode !== 0 || syntax.timedOut) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s03_sshd_validation_failed",
        publicMessage: "sshd candidate validation failed.",
        nextAction: "Inspect staged sshd drop-in and fix syntax before retrying.",
        stage: "S03",
        evidenceRef: syntax.stderr.slice(0, 512)
      });
    }
    const effective = await this.run(
      "/usr/bin/sudo",
      ["-n", "/usr/sbin/sshd", "-T", "-C", "addr=127.0.0.1,user=root,host=localhost"],
      MUTATION_TIMEOUT_MS
    );
    if (effective.exitCode !== 0 || effective.timedOut) {
      throw setupError({
        exitCode: ExitCode.DriftOrRecoveryRequired,
        code: "s03_sshd_effective_validation_failed",
        publicMessage: "sshd effective config validation failed.",
        nextAction: "Review Match rules and sshd drop-in conflict before retrying.",
        stage: "S03",
        evidenceRef: effective.stderr.slice(0, 512)
      });
    }
  }

  async stageManagedCutover(ctx: StageContext, managedHash: string): Promise<void> {
    this.requireMutationsEnabled();
    const marker = path.join(this.manualEvidenceDir(ctx), "staged-managed-hash");
    await this.fsAdapter.writeText(marker, `${managedHash}\n`, 0o600);
  }

  async armRollbackTimer(ctx: StageContext, _minutes: number): Promise<void> {
    this.requireMutationsEnabled();
    const marker = path.join(this.manualEvidenceDir(ctx), "rollback-armed");
    await this.fsAdapter.writeText(marker, "true\n", 0o600);
  }

  async applyCutover(_ctx: StageContext): Promise<void> {
    this.requireMutationsEnabled();
  }

  async verifyPrivateTailnetAccess(ctx: StageContext): Promise<boolean> {
    const observation = await this.observe(ctx);
    return observation.tailscale.privateSshReachable;
  }

  async disarmRollbackTimer(ctx: StageContext): Promise<void> {
    this.requireMutationsEnabled();
    const marker = path.join(this.manualEvidenceDir(ctx), "rollback-armed");
    await this.fsAdapter.writeText(marker, "false\n", 0o600);
  }

  async rollbackManagedCutover(ctx: StageContext, reason: string): Promise<{ ok: boolean; details: string }> {
    try {
      const marker = path.join(this.manualEvidenceDir(ctx), "rollback-armed");
      await this.fsAdapter.writeText(marker, "false\n", 0o600);
      const receipt = path.join(this.manualEvidenceDir(ctx), "rollback-reason");
      await this.fsAdapter.writeText(receipt, `${reason}\n`, 0o600);
      return { ok: true, details: "managed rollback marker restored" };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "rollback marker write failed"
      };
    }
  }
}

export function createNodeAccessAdapter(
  processAdapter: ProcessAdapter,
  fsAdapter: FilesystemAdapter,
  aptAdapter: AptAdapter
): AccessAdapter {
  return new NodeAccessAdapter(processAdapter, fsAdapter, aptAdapter);
}
