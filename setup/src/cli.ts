#!/usr/bin/env node
import process from "node:process";
import { SetupEngine, type CommandOptions } from "./core/engine";
import { ExitCode, STAGE_IDS, type StageId } from "./core/types";
import packageJson from "../package.json";

interface ParsedCommand {
  command: string;
  options: Record<string, string | boolean>;
}

interface CommandSpec {
  booleanOptions: Set<string>;
  valueOptions: Set<string>;
}

const COMMAND_SPECS: Record<string, CommandSpec> = {
  init: { booleanOptions: new Set(), valueOptions: new Set(["config", "profile"]) },
  preflight: { booleanOptions: new Set(["json"]), valueOptions: new Set(["config"]) },
  plan: { booleanOptions: new Set(["json"]), valueOptions: new Set(["config", "stage"]) },
  apply: { booleanOptions: new Set(["non-interactive"]), valueOptions: new Set(["config", "plan"]) },
  status: { booleanOptions: new Set(["refresh", "json"]), valueOptions: new Set(["config"]) },
  resume: { booleanOptions: new Set(["non-interactive"]), valueOptions: new Set(["config", "stage"]) },
  verify: { booleanOptions: new Set(["json"]), valueOptions: new Set(["config", "stage"]) },
  "gate-list": { booleanOptions: new Set(), valueOptions: new Set(["config"]) },
  "gate-approve": { booleanOptions: new Set(), valueOptions: new Set(["config", "id", "plan-hash"]) },
  "auth-login": { booleanOptions: new Set(), valueOptions: new Set(["config"]) },
  "auth-status": { booleanOptions: new Set(), valueOptions: new Set(["config"]) },
  smoke: { booleanOptions: new Set(), valueOptions: new Set(["config", "provider", "fixture"]) },
  "inference-disable": { booleanOptions: new Set(), valueOptions: new Set(["config"]) },
  "inference-probe": { booleanOptions: new Set(), valueOptions: new Set(["config", "checks"]) },
  cancel: { booleanOptions: new Set(["emergency"]), valueOptions: new Set(["config"]) },
  recover: { booleanOptions: new Set(["lock-only"]), valueOptions: new Set(["config"]) },
  "backup-create": { booleanOptions: new Set(), valueOptions: new Set(["config"]) },
  "backup-verify": { booleanOptions: new Set(), valueOptions: new Set(["config", "backup-id"]) },
  restore: { booleanOptions: new Set(), valueOptions: new Set(["config", "backup-id", "plan"]) },
  "update-plan": { booleanOptions: new Set(), valueOptions: new Set(["config", "release"]) },
  "update-apply": { booleanOptions: new Set(), valueOptions: new Set(["config", "plan"]) }
};

class CliParseError extends Error {
  constructor(readonly messagePublic: string) {
    super(messagePublic);
    this.name = "CliParseError";
  }
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
  if (argv[0] === "update") {
    return parseArgs([`update-${argv[1] ?? ""}`, ...argv.slice(2)]);
  }

  const [command, ...rest] = argv;
  if (command === undefined) {
    return { command: "help", options: {} };
  }
  if (!(command in COMMAND_SPECS)) {
    throw new CliParseError(`Unknown command '${command}'.`);
  }

  const spec = COMMAND_SPECS[command];
  if (spec === undefined) {
    throw new CliParseError(`Unknown command '${command}'.`);
  }

  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new CliParseError(`Unexpected positional argument '${token}'.`);
    }
    const key = token.slice(2);
    if (key.length === 0) {
      throw new CliParseError("Invalid empty option.");
    }
    if (!(spec.booleanOptions.has(key) || spec.valueOptions.has(key))) {
      throw new CliParseError(`Unknown option '--${key}' for '${command}'.`);
    }
    if (Object.hasOwn(options, key)) {
      throw new CliParseError(`Duplicate option '--${key}'.`);
    }
    const next = rest[index + 1];
    if (spec.booleanOptions.has(key)) {
      if (next !== undefined && !next.startsWith("--")) {
        throw new CliParseError(`Option '--${key}' does not accept a value.`);
      }
      options[key] = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      throw new CliParseError(`Missing value for '--${key}'.`);
    }
    options[key] = next;
    index += 1;
  }

  if (command === "init") {
    const profile = options.profile;
    if (profile !== "supervised" && profile !== "service") {
      throw new CliParseError("init requires --profile supervised|service.");
    }
  }
  if (typeof options.stage === "string" && asStageId(options.stage) === undefined) {
    throw new CliParseError(`Unknown stage '${options.stage}'.`);
  }
  if (command === "smoke") {
    if (options.provider !== "fake" && options.provider !== "live") {
      throw new CliParseError("smoke requires --provider fake|live.");
    }
    if (options.fixture !== "toy") {
      throw new CliParseError("smoke requires --fixture toy.");
    }
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
      "  factory-setup inference probe --config PATH --checks basic,structured,tools",
      "  factory-setup cancel --config PATH [--emergency]",
      "  factory-setup recover --config PATH [--lock-only]"
      ,
      "  factory-setup backup create --config PATH",
      "  factory-setup backup verify --config PATH [--backup-id ID]",
      "  factory-setup restore --config PATH --backup-id ID --plan PATH",
      "  factory-setup update plan --config PATH --release PATH",
      "  factory-setup update apply --config PATH --plan PATH"
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
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof CliParseError ? error.messagePublic : "Invalid CLI arguments.";
    process.stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        command: "parse",
        installation_id: "unknown",
        desired_hash: "unknown",
        plan_hash: null,
        overall_status: "failed",
        stages: [],
        manual_actions: ["Run factory-setup --help and retry with valid flags."],
        error: {
          code: "cli_parse_error",
          stage: null,
          operation_id: "n/a",
          retryable: false,
          public_message: message,
          next_action: "Correct command arguments and rerun.",
          evidence_ref: "argv"
        }
      })}\n`
    );
    process.exit(ExitCode.CliOrSchemaError);
    return;
  }
  if (parsed.command === "help") {
    printHelp();
    process.exit(ExitCode.Success);
  }
  if (parsed.command === "version") {
    process.stdout.write(`${packageJson.version}\n`);
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

  try {
    const engine = new SetupEngine({ installerVersion: packageJson.version });
    const { envelope, exitCode } = await engine.run(parsed.command, runOptions);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exit(exitCode);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        command: parsed.command,
        installation_id: "unknown",
        desired_hash: "unknown",
        plan_hash: runOptions.planHash ?? null,
        overall_status: "failed",
        stages: [],
        manual_actions: ["Inspect local logs and rerun command with --json output."],
        error: {
          code: "cli_unhandled_error",
          stage: null,
          operation_id: "n/a",
          retryable: false,
          public_message: "Unhandled CLI error.",
          next_action: "Inspect setup state and retry.",
          evidence_ref: "cli"
        }
      })}\n`
    );
    process.exit(ExitCode.OperationOrVerificationFailed);
  }
}

void main();
