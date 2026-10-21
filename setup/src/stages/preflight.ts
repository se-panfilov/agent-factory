import os from "node:os";
import path from "node:path";
import { type FilesystemAdapter } from "../adapters/filesystem";
import {
  type StageContext,
  type StageModule,
  type StageObservation,
  type StagePlan,
  type StageReceipt
} from "../core/types";

export interface PreflightProbe {
  readOnlyHostReport(): Promise<{
    osRelease: string;
    arch: string;
    uid: number;
    username: string;
    hasSystemd: boolean;
    cgroupVersion: string;
    freeDiskBytes: number;
    totalDiskBytes: number;
    cpuCount: number;
    totalMemBytes: number;
  }>;
}

async function probeDisk(fsAdapter: FilesystemAdapter, targetPath: string): Promise<{
  freeDiskBytes: number;
  totalDiskBytes: number;
}> {
  const real = await fsAdapter.realpath(targetPath).catch(() => targetPath);
  const stat = await fsAdapter.stat(real);
  const blockSize = Number(stat.blksize);
  const blocks = Number(stat.blocks);
  return {
    freeDiskBytes: blockSize * Math.max(blocks, 1),
    totalDiskBytes: blockSize * Math.max(blocks, 1)
  };
}

export function createNodePreflightProbe(fsAdapter: FilesystemAdapter): PreflightProbe {
  return {
    async readOnlyHostReport() {
      let osRelease = "unknown";
      try {
        const content = await fsAdapter.readText("/etc/os-release");
        osRelease = content.includes("24.04") ? "ubuntu-24.04" : "unsupported";
      } catch {
        osRelease = "unsupported";
      }
      const disk = await probeDisk(fsAdapter, process.cwd());
      return {
        osRelease,
        arch: process.arch === "arm64" ? "arm64" : "amd64",
        uid: typeof process.getuid === "function" ? process.getuid() : -1,
        username: os.userInfo().username,
        hasSystemd: await fsAdapter.exists("/run/systemd/system"),
        cgroupVersion: (await fsAdapter.exists("/sys/fs/cgroup/cgroup.controllers")) ? "v2" : "v1",
        freeDiskBytes: disk.freeDiskBytes,
        totalDiskBytes: disk.totalDiskBytes,
        cpuCount: os.cpus().length,
        totalMemBytes: os.totalmem()
      };
    }
  };
}

function preflightChecks(report: Awaited<ReturnType<PreflightProbe["readOnlyHostReport"]>>): Record<string, boolean | number | string> {
  return {
    host_supported: report.osRelease === "ubuntu-24.04" && (report.arch === "amd64" || report.arch === "arm64"),
    user_is_root: report.uid === 0,
    systemd_present: report.hasSystemd,
    cgroup_version: report.cgroupVersion,
    cpu_count: report.cpuCount,
    mem_gib: Math.round((report.totalMemBytes / (1024 ** 3)) * 100) / 100,
    disk_free_gib: Math.round((report.freeDiskBytes / (1024 ** 3)) * 100) / 100
  };
}

export function createPreflightStage(probe: PreflightProbe): StageModule {
  let lastObservation: StageObservation | null = null;

  return {
    id: "S01",
    dependencies: ["S00"],
    supportedProfiles: ["supervised", "service"],
    optional: false,
    requiredCapabilities: ["runner-readonly"],
    async observe(_ctx: StageContext): Promise<StageObservation> {
      const report = await probe.readOnlyHostReport();
      const status = report.osRelease === "ubuntu-24.04" ? "planned" : "blocked";
      const observation: StageObservation = {
        stageId: "S01",
        status,
        checks: preflightChecks(report),
        versions: {
          os_release: report.osRelease,
          arch: report.arch
        },
        observedAt: new Date().toISOString()
      };
      lastObservation = observation;
      return observation;
    },
    plan(_desired: unknown, observed: StageObservation): StagePlan {
      return {
        stageId: "S01",
        optional: false,
        requiredCapabilities: ["runner-readonly"],
        operations: [
          {
            id: "s01-observe-host",
            stageId: "S01",
            kind: "observe",
            resourceId: "host-preflight",
            risk: "low",
            gateIds: [],
            preconditions: ["bootstrap_receipt_present", "read_only_probes_only"],
            sideEffects: [],
            timeoutSec: 30,
            retryable: true
          },
          {
            id: "s01-verify-host",
            stageId: "S01",
            kind: "verify",
            resourceId: "host-preflight",
            risk: "low",
            gateIds: [],
            preconditions: ["host_supported"],
            sideEffects: [],
            timeoutSec: 30,
            retryable: true
          }
        ],
        requiredGates: observed.status === "blocked" ? ["host-support-override"] : []
      };
    },
    async apply(ctx: StageContext): Promise<StageReceipt[]> {
      if (lastObservation === null) {
        await this.observe(ctx);
      }
      const observation = lastObservation as StageObservation;
      return [
        {
          operationId: "s01-observe-host",
          stageId: "S01",
          resourceId: "host-preflight",
          observedAt: observation.observedAt,
          checks: observation.checks,
          versions: observation.versions,
          artifacts: []
        }
      ];
    },
    async verify(ctx: StageContext): Promise<StageReceipt[]> {
      const observation = await this.observe(ctx);
      return [
        {
          operationId: "s01-verify-host",
          stageId: "S01",
          resourceId: "host-preflight",
          observedAt: observation.observedAt,
          checks: observation.checks,
          versions: observation.versions,
          artifacts: []
        }
      ];
    },
    async recover(ctx: StageContext): Promise<StageReceipt[]> {
      return this.verify(ctx);
    }
  };
}
