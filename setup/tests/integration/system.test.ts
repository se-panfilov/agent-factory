import test from "node:test";
import assert from "node:assert/strict";
import { type AptAdapter, type AptPackagePin, type AptSystemObservation } from "../../src/adapters/apt";
import { createSystemStage } from "../../src/stages/system";
import { ExitCode, type SetupConfig, type StageContext } from "../../src/core/types";

class FakeAptAdapter implements AptAdapter {
  constructor(private observation: AptSystemObservation) {}

  refreshed = 0;
  simulated: AptPackagePin[][] = [];
  installed: AptPackagePin[][] = [];

  async observe(packageNames: string[]): Promise<AptSystemObservation> {
    const selected = this.observation.packages.filter((item) => packageNames.includes(item.name));
    return {
      ...this.observation,
      packages: selected.map((item) => ({ ...item }))
    };
  }

  async refreshMetadata(): Promise<void> {
    this.refreshed += 1;
    this.observation = {
      ...this.observation,
      metadataFresh: true
    };
  }

  async simulateInstall(pins: AptPackagePin[]): Promise<void> {
    this.simulated.push(pins);
  }

  async installPinned(pins: AptPackagePin[]): Promise<void> {
    this.installed.push(pins);
    const byName = new Map(pins.map((pin) => [pin.name, pin.version] as const));
    this.observation = {
      ...this.observation,
      packages: this.observation.packages.map((item) => ({
        ...item,
        installedVersion: byName.get(item.name) ?? item.installedVersion
      })),
      rebootRequired: false
    };
  }

  setCandidates(candidates: Record<string, string>): void {
    this.observation = {
      ...this.observation,
      packages: this.observation.packages.map((item) => ({
        ...item,
        candidateVersion: candidates[item.name] ?? item.candidateVersion
      }))
    };
  }
}

function ctx(profile: "supervised" | "service"): StageContext {
  return {
    installationId: "0f71966d-ef6f-4976-97cb-eb34cb139204",
    contractVersion: "1.0.0",
    profile,
    desiredHash: "d".repeat(64),
    planHash: "p".repeat(64),
    config: {} as SetupConfig
  };
}

function baseObservation(): AptSystemObservation {
  return {
    metadataFresh: false,
    metadataUpdatedAt: "2026-10-21T20:00:00.000Z",
    sudoAvailable: true,
    dpkgAuditClean: true,
    dpkgAuditOutput: "",
    rebootRequired: false,
    packages: [
      { name: "git", installedVersion: null, candidateVersion: "1:2.43.0-1ubuntu7.3" },
      { name: "curl", installedVersion: null, candidateVersion: "8.5.0-2ubuntu10.6" },
      { name: "ca-certificates", installedVersion: null, candidateVersion: "20240203" },
      { name: "build-essential", installedVersion: null, candidateVersion: "12.10ubuntu1" },
      { name: "tmux", installedVersion: null, candidateVersion: "3.4-1ubuntu0.1" }
    ]
  };
}

test("S02 plans pinned package install and applies via apt adapter", async () => {
  const apt = new FakeAptAdapter(baseObservation());
  const stage = createSystemStage(apt);

  const observation = await stage.observe(ctx("supervised"));
  const plan = stage.plan({ profile: "supervised" }, observation);
  assert.equal(plan.stageId, "S02");
  assert.equal(plan.requiredGates.includes("s02-sudo-apt-install"), true);
  assert.equal(plan.operations.length, 3);

  const receipts = await stage.apply(ctx("supervised"), plan);
  assert.equal(receipts.length, 1);
  assert.equal(apt.refreshed, 1);
  assert.equal(apt.simulated.length, 1);
  assert.equal(apt.installed.length, 1);

  const verified = await stage.verify(ctx("supervised"));
  assert.equal(verified.length, 1);
  assert.equal(verified[0]?.checks.installed_matches_plan, true);
});

test("S02 refuses apply when package candidates changed after planning", async () => {
  const apt = new FakeAptAdapter(baseObservation());
  const stage = createSystemStage(apt);
  const observation = await stage.observe(ctx("supervised"));
  const plan = stage.plan({ profile: "supervised" }, observation);

  apt.setCandidates({
    git: "1:2.43.0-1ubuntu7.99"
  });

  await assert.rejects(
    async () => stage.apply(ctx("supervised"), plan),
    (error) => {
      return (
        error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "s02_package_set_changed"
        && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
      );
    }
  );
});

test("S02 refuses automatic dpkg repair and returns manual next action", async () => {
  const apt = new FakeAptAdapter({
    ...baseObservation(),
    dpkgAuditClean: false,
    dpkgAuditOutput: "dpkg was interrupted, you must manually run 'sudo dpkg --configure -a'"
  });
  const stage = createSystemStage(apt);
  const observation = await stage.observe(ctx("supervised"));
  const plan = stage.plan({ profile: "supervised" }, observation);

  await assert.rejects(
    async () => stage.apply(ctx("supervised"), plan),
    (error) => {
      return (
        error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "s02_dpkg_audit_failed"
        && (error as { exitCode?: number }).exitCode === ExitCode.ManualActionRequired
      );
    }
  );
});
