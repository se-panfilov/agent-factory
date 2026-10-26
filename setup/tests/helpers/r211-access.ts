// Actual engine/S03; all external effects are disk-backed fake facts, never host commands.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { requestCancel } from "../../src/core/lock";
import { NodeFilesystemAdapter, type FilesystemAdapter } from "../../src/adapters/filesystem";
import { createAccessStage, type AccessAdapter, type AccessRuntimeObservation } from "../../src/stages/access";
import { r14Fixture, r14Noop, r14Process } from "./r14-engine";
import { baseObservation } from "./r15-access-adapter";
import { type StageModule, type SetupConfig } from "../../src/core/types";

export const phases = ["install", "stage", "arm", "cutover", "tailnet", "disarm"] as const;
export type Phase = typeof phases[number];
export type Facts = { observation: AccessRuntimeObservation; counts: Record<Phase | "rollback", number> };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const target = { contentHash: hash("managed content"), sshConfigHash: hash("managed ssh"), firewallRulesHash: hash("managed firewall") };
export async function readFacts(root: string): Promise<Facts> { return JSON.parse(await fs.readFile(path.join(root, "facts.json"), "utf8")) as Facts; }
export async function writeFacts(root: string, facts: Facts) { await fs.writeFile(path.join(root, "facts.json"), JSON.stringify(facts)); }
export async function accessFixture() {
  const x = await r14Fixture("S03"), observation = baseObservation();
  observation.publicExposure = { ipv4SshReachable: true, ipv6SshReachable: true };
  await writeFacts(x.root, { observation, counts: { install: 0, stage: 0, arm: 0, cutover: 0, tailnet: 0, disarm: 0, rollback: 0 } });
  return x;
}
export function accessEngine(root: string, config: SetupConfig, options: {
  pause?: Phase; now?: () => Date; fs?: FilesystemAdapter; afterEffect?: (phase: Phase) => Promise<void>;
  unsafeCutover?: "ownership" | "content"; stagePolicy?: (stage: StageModule) => void;
} = {}) {
  const f = options.fs ?? new NodeFilesystemAdapter();
  let cancelled = false;
  const effect = async (phase: Phase, change?: (facts: Facts) => void) => {
    const facts = await readFacts(root); facts.counts[phase]++; change?.(facts); await writeFacts(root, facts);
    await options.afterEffect?.(phase);
    if (options.pause === phase && !cancelled) { cancelled = true; await requestCancel(f, config); }
  };
  const adapter: AccessAdapter = {
    observe: async () => (await readFacts(root)).observation,
    installPinnedTailscale: async version => effect("install", facts => { facts.observation.tailscale.installedVersion = version; }),
    stageManagedCutover: async () => effect("stage"), validateSshdCandidate: async () => {},
    // Deliberately use a different key order; proof semantics cannot depend on adapter serialization.
    stagedContentProof: async () => ({ firewallRulesHash: target.firewallRulesHash, sshConfigHash: target.sshConfigHash, contentHash: target.contentHash }),
    armRollbackTimer: async () => effect("arm", facts => { facts.observation.rollback.armed = true; }),
    applyCutover: async () => effect("cutover", facts => {
      const o = facts.observation;
      o.securityInputs.contentHash = options.unsafeCutover === "content" ? hash("foreign") : target.contentHash;
      o.ssh.configHash = target.sshConfigHash; o.firewall.rulesHash = target.firewallRulesHash;
      o.publicExposure = { ipv4SshReachable: false, ipv6SshReachable: false };
      if (options.unsafeCutover === "ownership") o.securityInputs.ownershipHash = "foreign ownership";
    }),
    verifyPrivateTailnetAccess: async () => { await effect("tailnet"); return true; },
    disarmRollbackTimer: async () => effect("disarm", facts => { facts.observation.rollback.armed = false; }),
    rollbackManagedCutover: async () => {
      const facts = await readFacts(root); facts.counts.rollback++; facts.observation.rollback.armed = false; await writeFacts(root, facts);
      return { ok: true, details: "fake rollback" };
    }
  };
  const proc = { ...r14Process, isPidAlive: (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } } };
  const stage = createAccessStage(adapter);
  options.stagePolicy?.(stage);
  return new SetupEngine({ fsAdapter: f, processAdapter: proc, clock: { now: options.now ?? (() => new Date("2026-10-26T10:00:00.000Z")) } },
    createRegistry([r14Noop("S02"), stage]));
}
