import { constants as fsConstants } from "node:fs";
import {
  appendFile as appendFileRaw,
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface FilesystemAdapter {
  localLockSemantics?(dirPath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
  hashFile?(filePath: string, maxBytes: number, deadlineMs: number): Promise<string>;
  readTextBounded(filePath: string, maxBytes: number): Promise<{
    text: string;
    bytesRead: number;
    truncated: boolean;
  }>;
  writeText(filePath: string, content: string, mode?: number): Promise<void>;
  appendText(filePath: string, content: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  lstat(targetPath: string): ReturnType<typeof lstat>;
  stat(targetPath: string): ReturnType<typeof stat>;
  readdir(targetPath: string): Promise<string[]>;
  realpath(targetPath: string): Promise<string>;
  fsyncFile(filePath: string): Promise<void>;
  fsyncDir(dirPath: string): Promise<void>;
  ensureParentDir(filePath: string): Promise<void>;
}

export class NodeFilesystemAdapter implements FilesystemAdapter {
  async localLockSemantics(dirPath: string): Promise<boolean> {
    const info = await statfs(dirPath);
    // ext, tmpfs, overlay (local test containers), APFS/HFS (development only).
    return [0xef53, 0x01021994, 0x794c7630, 0x1a, 0x11].includes(Number(info.type));
  }

  async hashFile(filePath: string, maxBytes: number, deadlineMs: number): Promise<string> {
    const started = performance.now();
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw Error("unsupported/oversized artifact");
      const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
      let count = 0;
      for (;;) {
        if (performance.now() - started >= deadlineMs) throw Error("artifact hash deadline");
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
        if (count > maxBytes) throw Error("artifact grew beyond bound");
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || count !== before.size) throw Error("artifact changed during hashing");
      return hash.digest("hex");
    } finally { await handle.close(); }
  }

  async readText(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  async readTextBounded(filePath: string, maxBytes: number): Promise<{
    text: string;
    bytesRead: number;
    truncated: boolean;
  }> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`maxBytes must be a positive integer (received: ${maxBytes})`);
    }
    const handle = await open(filePath, "r");
    try {
      const limit = maxBytes + 1;
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      while (bytesRead < limit) {
        const remaining = limit - bytesRead;
        const chunkSize = Math.min(64 * 1024, remaining);
        const buffer = Buffer.allocUnsafe(chunkSize);
        const read = await handle.read(buffer, 0, chunkSize, null);
        if (read.bytesRead === 0) {
          break;
        }
        chunks.push(buffer.subarray(0, read.bytesRead));
        bytesRead += read.bytesRead;
      }
      const truncated = bytesRead > maxBytes;
      const payloadLength = truncated ? maxBytes : bytesRead;
      const data = Buffer.concat(chunks, payloadLength);
      return {
        text: data.toString("utf8"),
        bytesRead,
        truncated
      };
    } finally {
      await handle.close();
    }
  }

  async writeText(filePath: string, content: string, mode = 0o600): Promise<void> {
    await this.ensureParentDir(filePath);
    await writeFile(filePath, content, { mode, encoding: "utf8" });
  }

  async appendText(filePath: string, content: string): Promise<void> {
    await this.ensureParentDir(filePath);
    await appendFileRaw(filePath, content, "utf8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await mkdir(dirPath, {
      recursive: options?.recursive ?? false,
      mode: options?.mode
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath);
  }

  async remove(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await rm(targetPath, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false
    });
  }

  lstat(targetPath: string): ReturnType<typeof lstat> {
    return lstat(targetPath);
  }

  stat(targetPath: string): ReturnType<typeof stat> {
    return stat(targetPath);
  }

  async readdir(targetPath: string): Promise<string[]> {
    return readdir(targetPath);
  }

  async realpath(targetPath: string): Promise<string> {
    return realpath(targetPath, "utf8");
  }

  async fsyncFile(filePath: string): Promise<void> {
    const handle = await open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async fsyncDir(dirPath: string): Promise<void> {
    const handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async ensureParentDir(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }
}
