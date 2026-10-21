import { ExitCode, type StageId } from "./types";

export interface SetupErrorOptions {
  exitCode: ExitCode;
  code: string;
  publicMessage: string;
  nextAction: string;
  stage?: StageId | null;
  operationId?: string;
  retryable?: boolean;
  evidenceRef?: string;
}

export class SetupError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly stage: StageId | null;
  readonly operationId: string;
  readonly retryable: boolean;
  readonly nextAction: string;
  readonly evidenceRef: string;

  constructor(options: SetupErrorOptions) {
    super(options.publicMessage);
    this.name = "SetupError";
    this.exitCode = options.exitCode;
    this.code = options.code;
    this.stage = options.stage ?? null;
    this.operationId = options.operationId ?? "n/a";
    this.retryable = options.retryable ?? false;
    this.nextAction = options.nextAction;
    this.evidenceRef = options.evidenceRef ?? "state/events.jsonl";
  }
}

export function setupError(options: SetupErrorOptions): SetupError {
  return new SetupError(options);
}

export function toSetupError(error: unknown): SetupError {
  if (error instanceof SetupError) {
    return error;
  }
  if (error instanceof Error) {
    return setupError({
      exitCode: ExitCode.OperationOrVerificationFailed,
      code: "unexpected_error",
      publicMessage: error.message,
      nextAction: "Inspect setup logs and retry with a fresh plan.",
      evidenceRef: "state/events.jsonl"
    });
  }
  return setupError({
    exitCode: ExitCode.OperationOrVerificationFailed,
    code: "unknown_error",
    publicMessage: "Unknown error",
    nextAction: "Inspect setup logs and retry with a fresh plan.",
    evidenceRef: "state/events.jsonl"
  });
}
