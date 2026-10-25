import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeApplicationReleaseAdapter } from "../../src/adapters/git";
import { NodeProcessAdapter, type CommandOptions, type CommandResult, type ProcessAdapter } from "../../src/adapters/process";
import { createApplicationStage } from "../../src/stages/application";
import { SetupEngine } from "../../src/core/engine";
import { createRegistry } from "../../src/core/plan";
import { validateContractSchema } from "../../src/core/validators";
import { r14Fixture, r14Noop, r14Clock, r14Process } from "./r14-engine";
import { FakeApplicationAdapter, makeCheckout, makeRelease } from "./r15-application";

export const digest = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
export const reviewedBody = 'process.stdout.write(JSON.stringify({marker:"REVIEWED_ENTRY",entry:process.argv[1],args:process.argv.slice(2)})+"\\n");\n';
export const success = (): CommandResult => ({exitCode: 0, stdout: "help", stderr: "", timedOut: false, durationMs: 0});
export interface Invocation { binary: string; args: string[]; cwd: string; result: CommandResult }

/** Archive/extraction are synthetic; hashes, argv preparation and optional process execution are production methods. */
export async function commandFixture(entry = "runner.cjs", options: { real?: boolean; downstream?: boolean; direct?: boolean } = {}) {
  const x = await r14Fixture(options.downstream ? "S06" : "S05");
  const a = new FakeApplicationAdapter(makeCheckout(x.config), makeRelease(x.config));
  const pinned = path.join(x.config.paths.setup_node_dir, "bin", "node");
  await fs.mkdir(path.dirname(pinned), {recursive: true});
  await fs.symlink(process.execPath, pinned);
  const body = options.direct ? `#!${process.execPath}\n${reviewedBody}` : reviewedBody;
  const files: Record<string, string> = {[entry]: body};
  a.release.manifest!.content_hashes = {[entry]: digest(body)};
  const argv = options.direct ? [entry] : ["node", entry];
  a.release.manifest!.commands = {runner_verify: [...argv], runner_stop: [...argv]};
  const invocations: Invocation[] = [];
  let downstream = 0, executableCalls = 0;
  let onCommand: ((cmd: CommandOptions) => Promise<CommandResult>) | undefined;
  const actual = new NodeProcessAdapter();
  const proc: ProcessAdapter = {...r14Process, uid: () => process.getuid?.() ?? 1000,
    runCommand: async cmd => {
      if (cmd.binary === "/usr/bin/sha256sum") return {...success(), stdout: digest(await fs.readFile(cmd.args[0]!)) + "  fixture\n"};
      executableCalls++;
      // Never execute manifest options/foreign binaries in a negative fixture.
      const result = onCommand ? await onCommand(cmd) : options.real ? await actual.runCommand({...cmd, timeoutMs: 3000, maxOutputBytes: 16384}) : success();
      invocations.push({binary: cmd.binary, args: [...cmd.args], cwd: process.cwd(), result});
      return result;
    }};
  const node = new NodeApplicationReleaseAdapter(proc, x.f);
  a.verifyContentHashes = node.verifyContentHashes.bind(node);
  a.probeCommands = node.probeCommands.bind(node);
  async function writeFiles(root: string) {
    await fs.mkdir(root, {recursive: true, mode: 0o700});
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      await fs.writeFile(target, text, {mode: text.startsWith("#!") ? 0o700 : 0o600});
    }
  }
  a.extractArchive = async (_config, target) => {a.extractCalls++; await writeFiles(path.join(target, "release"));};
  a.materializeRelease = async () => {a.materializeCalls++; await writeFiles(x.config.paths.application_dir); a.checkout.exists = true; a.checkout.deployedSourceCommit = x.config.release.source_commit;};
  const dependent = r14Noop("S06"); dependent.dependencies = ["S05"];
  dependent.plan = () => ({stageId: "S06", optional: false, requiredCapabilities: [], requiredGates: [], operations: [{id:"r16-dependent",stageId:"S06",kind:"mutate",resourceId:"r16-downstream",risk:"low",gateIds:[],preconditions:[],sideEffects:["fixture trap"],timeoutSec:1,retryable:false}]});
  dependent.apply = async () => {downstream++; throw Error("Forbidden downstream effect");};
  const makeEngine = () => new SetupEngine({fsAdapter:x.f,processAdapter:r14Process,clock:r14Clock}, createRegistry([r14Noop("S04"),createApplicationStage(a),...(options.downstream ? [dependent] : [])]));
  return {x, a, node, pinned, files, body, invocations, makeEngine, stage: () => createApplicationStage(a),
    schema: () => validateContractSchema("application-manifest", a.release.manifest),
    materialize: async () => a.materializeRelease("synthetic", x.config.paths.application_dir),
    probe: () => node.probeCommands(x.config.paths.application_dir, a.release.manifest!, x.config),
    onCommand: (callback: (cmd: CommandOptions) => Promise<CommandResult>) => {onCommand = callback;},
    downstream: () => downstream, calls: () => executableCalls};
}
