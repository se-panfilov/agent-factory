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
  writeFile
} from "node:fs/promises";
import path from "node:path";

export interface FilesystemAdapter {
  readText(filePath: string): Promise<string>;
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
  async readText(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
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
