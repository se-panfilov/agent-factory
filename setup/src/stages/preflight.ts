import os from "node:os";
import path from "node:path";
import { statfs } from "node:fs/promises";
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
    freeInodes: number;
    cpuCount: number;
    totalMemBytes: number;
  }>;
}

async function probeDisk(fsAdapter: FilesystemAdapter, targetPath: string): Promise<{
  freeDiskBytes: number;
  totalDiskBytes: number;
  freeInodes: number;
}> {
  const real = await fsAdapter.realpath(targetPath).catch(() => targetPath);
  const stats = await statfs(real);
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bavail);
  return {
    freeDiskBytes: blockSize * Math.max(freeBlocks, 0),
    totalDiskBytes: blockSize * Math.max(blocks, 1),
    freeInodes: Number(stats.ffree)
  };
}

export function createNodePreflightProbe(fsAdapter: FilesystemAdapter): PreflightProbe {
  return {
    async readOnlyHostReport() {
      let osRelease = "unknown";
      try {
        const content = await fsAdapter.readText("/etc/os-release");
        const lines = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const map = new Map<string, string>();
        for (const line of lines) {
          const eq = line.indexOf("=");
          if (eq <= 0) {
            continue;
          }
          const key = line.slice(0, eq);
          const value = line.slice(eq + 1).replace(/^"/, "").replace(/"$/, "");
          map.set(key, value);
        }
        const id = map.get("ID");
        const version = map.get("VERSION_ID");
        osRelease = id === "ubuntu" && version === "24.04" ? "ubuntu-24.04" : "unsupported";
      } catch {
        osRelease = "unsupported";
      }
      const disk = await probeDisk(fsAdapter, process.cwd());
      const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "unsupported";
      return {
        osRelease,
        arch,
        uid: typeof process.getuid === "function" ? process.getuid() : -1,
        username: os.userInfo().username,
        hasSystemd: await fsAdapter.exists("/run/systemd/system"),
        cgroupVersion: (await fsAdapter.exists("/sys/fs/cgroup/cgroup.controllers")) ? "v2" : "v1",
        freeDiskBytes: disk.freeDiskBytes,
        totalDiskBytes: disk.totalDiskBytes,
        freeInodes: disk.freeInodes,
        cpuCount: os.cpus().length,
        totalMemBytes: os.totalmem()
      };
    }
  };
}

function preflightChecks(
  report: Awaited<ReturnType<PreflightProbe["readOnlyHostReport"]>>,
  expectedUser: string
): Record<string, boolean | number | string> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  const supportedHost = report.osRelease === "ubuntu-24.04" && (report.arch === "amd64" || report.arch === "arm64");
  const expectedUserOk = report.username === expectedUser;
  const nonRoot = report.uid !== 0;
  const resourcesOk = report.cpuCount > 0 && report.totalMemBytes > 0 && report.freeDiskBytes > 0 && report.freeInodes > 0;
  const nodeVersionOk = Number.isFinite(nodeMajor) && nodeMajor === 24;
  return {
    host_supported: supportedHost,
    expected_user_match: expectedUserOk,
    node_major_supported: nodeVersionOk,
    user_is_root: report.uid === 0,
    systemd_present: report.hasSystemd,
    cgroup_version: report.cgroupVersion,
    cpu_count: report.cpuCount,
    mem_gib: Math.round((report.totalMemBytes / (1024 ** 3)) * 100) / 100,
    disk_free_gib: Math.round((report.freeDiskBytes / (1024 ** 3)) * 100) / 100,
    disk_free_inodes: report.freeInodes,
    preflight_supported: supportedHost && expectedUserOk && nonRoot && report.hasSystemd && resourcesOk && nodeVersionOk
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
    async observe(ctx: StageContext): Promise<StageObservation> {
      const report = await probe.readOnlyHostReport();
      const checks = preflightChecks(report, ctx.config.host.expected_user);
      const status = checks.preflight_supported === true ? "verified" : "blocked";
      const observation: StageObservation = {
        stageId: "S01",
        status,
        checks,
        versions: {
          os_release: report.osRelease,
          arch: report.arch,
          node_major: process.versions.node.split(".")[0] ?? "unknown"
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
        requiredGates: []
      };
    },
    async apply(ctx: StageContext, approvedPlan: StagePlan): Promise<StageReceipt[]> {
      if (lastObservation === null) {
        await this.observe(ctx);
      }
      const observation = lastObservation as StageObservation;
      return approvedPlan.operations
        .map((operation) => ({
          operationId: operation.id,
          stageId: "S01",
          resourceId: operation.resourceId,
          observedAt: observation.observedAt,
          checks: observation.checks,
          versions: observation.versions,
          artifacts: []
        }));
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
