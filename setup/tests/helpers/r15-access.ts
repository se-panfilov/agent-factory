import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeFilesystemAdapter } from "../../src/adapters/filesystem";
export async function accessInventory(main = "Include /etc/ssh/sshd_config.d/*.conf\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "af-r15-ssh-")), delegate = new NodeFilesystemAdapter();
  const mapped = (p: string) => path.join(root, p.replace(/^\/+/, ""));
  const reads: Array<{path: string; limit: number}> = [], directories: string[] = [], owners = new Map<string, number>();
  let mutations = 0;
  async function write(p: string, body: string) { await fs.mkdir(path.dirname(mapped(p)), { recursive: true, mode: 0o700 }); await fs.writeFile(mapped(p), body, { mode: 0o600 }); }
  await fs.mkdir(mapped("/etc/ssh/sshd_config.d"), { recursive: true, mode: 0o700 }); await write("/etc/ssh/sshd_config", main);
  const adapter = new Proxy(delegate, { get(target, key, receiver) {
    if (key === "lstat") return async (p: string) => Object.assign(await target.lstat(mapped(p)), { uid: owners.get(p) ?? 0, gid: 0 });
    if (key === "readTextBounded") return async (p: string, limit: number) => { reads.push({path:p,limit}); return target.readTextBounded(mapped(p), limit); };
    if (key === "readdir") return async (p: string) => { directories.push(p); return target.readdir(mapped(p)); };
    if (["writeText","appendText","mkdir","rename","remove","fsyncFile","fsyncDir","ensureParentDir"].includes(String(key))) return async () => { mutations++; throw Error("Collector mutation forbidden"); };
    const value: unknown = Reflect.get(target, key, receiver); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { root, adapter, mapped, reads, directories, owners, write, mutations: () => mutations };
}
