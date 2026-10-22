#!/usr/bin/env node
import process from "node:process";
import { SetupEngine, type CommandOptions } from "./core/engine";
import { ExitCode, STAGE_IDS, type StageId } from "./core/types";

interface ParsedCommand {
  command: string;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", options: {} };
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    return { command: "version", options: {} };
  }
  if (argv[0] === "gate") {
    return parseArgs([`gate-${argv[1] ?? ""}`, ...argv.slice(2)]);
  }
  if (argv[0] === "auth") {
    return parseArgs([`auth-${argv[1] ?? ""}`, ...argv.slice(2)]);
  }
  if (argv[0] === "backup") {
    return parseArgs([`backup-${argv[1] ?? ""}`, ...argv.slice(2)]);
  }
  if (argv[0] === "inference") {
    return parseArgs([`inference-${argv[1] ?? ""}`, ...argv.slice(2)]);
  }

  const [command, ...rest] = argv;
  if (command === undefined) {
    return { command: "help", options: {} };
  }
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function printHelp(): void {
  process.stderr.write(
    [
      "Usage:",
      "  factory-setup init --profile supervised|service --config PATH",
      "  factory-setup preflight --config PATH [--json]",
      "  factory-setup plan --config PATH [--stage ID] [--json]",
      "  factory-setup apply --config PATH --plan PATH [--non-interactive]",
      "  factory-setup status --config PATH [--refresh] [--json]",
      "  factory-setup resume --config PATH [--non-interactive]",
      "  factory-setup verify --config PATH [--stage ID] [--json]",
      "  factory-setup gate list --config PATH",
      "  factory-setup gate approve --config PATH --id ID --plan-hash HASH",
      "  factory-setup auth login --config PATH",
      "  factory-setup auth status --config PATH",
      "  factory-setup smoke --config PATH --provider fake|live --fixture toy",
      "  factory-setup inference disable --config PATH",
      "  factory-setup cancel --config PATH [--emergency]",
      "  factory-setup recover --config PATH [--lock-only]"
      ,
      "  factory-setup backup create --config PATH",
      "  factory-setup backup verify --config PATH [--backup-id ID]",
      "  factory-setup restore --config PATH --backup-id ID --plan PATH"
    ].join("\n") + "\n"
  );
}

function asStageId(input: string | undefined): StageId | undefined {
  if (input === undefined) {
    return undefined;
  }
  return STAGE_IDS.includes(input as StageId) ? (input as StageId) : undefined;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    printHelp();
    process.exit(ExitCode.Success);
  }
  if (parsed.command === "version") {
    process.stdout.write("0.0.1\n");
    process.exit(ExitCode.Success);
  }

  const configPathValue = parsed.options.config;
  if (typeof configPathValue !== "string") {
    process.stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        command: parsed.command,
        installation_id: "unknown",
        desired_hash: "unknown",
        plan_hash: null,
        overall_status: "failed",
        stages: [],
        manual_actions: ["Provide --config PATH."],
        error: {
          code: "config_required",
          stage: null,
          operation_id: "n/a",
          retryable: false,
          public_message: "Missing --config PATH.",
          next_action: "Pass --config PATH to this command.",
          evidence_ref: "argv"
        }
      })}\n`
    );
    process.exit(ExitCode.CliOrSchemaError);
  }

  const runOptions: CommandOptions = {
    configPath: configPathValue
  };
  if (typeof parsed.options.plan === "string") {
    runOptions.planPath = parsed.options.plan;
  }
  if (typeof parsed.options.stage === "string") {
    const stageId = asStageId(parsed.options.stage);
    if (stageId !== undefined) {
      runOptions.stageId = stageId;
    }
  }
  if (typeof parsed.options.profile === "string") {
    runOptions.profile = parsed.options.profile === "service" ? "service" : "supervised";
  }
  if (typeof parsed.options.id === "string") {
    runOptions.gateId = parsed.options.id;
  }
  if (typeof parsed.options["plan-hash"] === "string") {
    runOptions.planHash = parsed.options["plan-hash"];
  }
  if (parsed.options["non-interactive"] === true) {
    runOptions.nonInteractive = true;
  }
  if (parsed.options.refresh === true) {
    runOptions.refresh = true;
  }
  if (parsed.options["lock-only"] === true) {
    runOptions.lockOnly = true;
  }
  if (typeof parsed.options.provider === "string" && (parsed.options.provider === "live" || parsed.options.provider === "fake")) {
    runOptions.provider = parsed.options.provider;
  }
  if (typeof parsed.options.fixture === "string" && parsed.options.fixture === "toy") {
    runOptions.fixture = parsed.options.fixture;
  }
  if (typeof parsed.options["backup-id"] === "string") {
    runOptions.backupId = parsed.options["backup-id"];
  }
  if (parsed.options.emergency === true) {
    runOptions.emergency = true;
  }

  const engine = new SetupEngine();
  const { envelope, exitCode } = await engine.run(parsed.command, runOptions);

  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exit(exitCode);
}

void main();
