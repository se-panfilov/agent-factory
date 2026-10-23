import test from "node:test";
import assert from "node:assert/strict";
import { NodeAptAdapter, parseAptPolicy } from "../../src/adapters/apt";
import { type FilesystemAdapter } from "../../src/adapters/filesystem";
import { type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";

class FakeProcessAdapter implements ProcessAdapter {
  constructor(private readonly responses: CommandResult[]) {}

  private readonly calls: CommandOptions[] = [];
  getCalls(): CommandOptions[] {
    return this.calls;
  }

  async runCommand(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("no fake process response");
    }
    return next;
  }

  pid(): number {
    return 999;
  }
  uid(): number {
    return 1000;
  }
  username(): string {
    return "factory";
  }
  async bootId(): Promise<string> {
    return "boot-id";
  }
  async machineIdHash(): Promise<string> {
    return "a".repeat(64);
  }
  async processStartTicks(): Promise<number | null> {
    return 100;
  }
  isPidAlive(): boolean {
    return true;
  }
}

class FakeFilesystemAdapter implements FilesystemAdapter {
  constructor(private readonly rebootRequired: boolean, private readonly metadataDate: Date) {}
  async readText(_filePath: string): Promise<string> {
    throw new Error("not implemented");
  }
  async readTextBounded(_filePath: string, _maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
    throw new Error("not implemented");
  }
  async writeText(): Promise<void> {}
  async appendText(): Promise<void> {}
  async exists(filePath: string): Promise<boolean> {
    return filePath === "/var/run/reboot-required" ? this.rebootRequired : false;
  }
  async mkdir(): Promise<void> {}
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
  async lstat(): Promise<Awaited<ReturnType<typeof import("node:fs/promises").lstat>>> {
    throw new Error("not implemented");
  }
  async stat(filePath: string): Promise<Awaited<ReturnType<typeof import("node:fs/promises").stat>>> {
    if (filePath === "/var/lib/apt/periodic/update-success-stamp") {
      return { mtime: this.metadataDate } as Awaited<ReturnType<typeof import("node:fs/promises").stat>>;
    }
    throw new Error("not found");
  }
  async readdir(): Promise<string[]> {
    return [];
  }
  async realpath(targetPath: string): Promise<string> {
    return targetPath;
  }
  async fsyncFile(): Promise<void> {}
  async fsyncDir(): Promise<void> {}
  async ensureParentDir(): Promise<void> {}
}

test("parseAptPolicy returns package candidate versions", () => {
  const parsed = parseAptPolicy(
    [
      "git:",
      "  Installed: 1:2.43.0-1",
      "  Candidate: 1:2.43.0-1",
      "curl:",
      "  Installed: (none)",
      "  Candidate: 8.5.0-2ubuntu10.4"
    ].join("\n")
  );
  assert.equal(parsed.get("git"), "1:2.43.0-1");
  assert.equal(parsed.get("curl"), "8.5.0-2ubuntu10.4");
});

test("observe reads candidates, installed versions, and reboot marker with fakes", async () => {
  const process = new FakeProcessAdapter([
    { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 },
    {
      exitCode: 0,
      stdout: "git:\n  Candidate: 1:2.43.0-1\ncurl:\n  Candidate: 8.5.0-2ubuntu10.4\n",
      stderr: "",
      timedOut: false,
      durationMs: 1
    },
    {
      exitCode: 0,
      stdout: "git\t1:2.43.0-1\tinstall ok installed\ncurl\t8.5.0-2ubuntu10.4\tinstall ok installed\n",
      stderr: "",
      timedOut: false,
      durationMs: 1
    },
    { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
  ]);
  const fs = new FakeFilesystemAdapter(true, new Date("2026-10-21T10:00:00Z"));
  const adapter = new NodeAptAdapter(process, fs, () => new Date("2026-10-21T11:00:00Z"));

  const observed = await adapter.observe(["git", "curl"]);
  assert.equal(observed.metadataFresh, true);
  assert.equal(observed.rebootRequired, true);
  assert.equal(observed.sudoAvailable, true);
  assert.equal(observed.packages.length, 2);
  assert.equal(observed.packages[0]?.installedVersion, "1:2.43.0-1");
  assert.equal(observed.packages[1]?.candidateVersion, "8.5.0-2ubuntu10.4");
});

test("installPinned rejects unsafe pin version", async () => {
  const process = new FakeProcessAdapter([{ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }]);
  const fs = new FakeFilesystemAdapter(false, new Date("2026-10-21T10:00:00Z"));
  const adapter = new NodeAptAdapter(process, fs);
  await assert.rejects(
    async () => adapter.installPinned([{ name: "git", version: "1.2.3;rm -rf /" }]),
    (error) => error instanceof Error && error.message.includes("Unsafe package version pin")
  );
});
