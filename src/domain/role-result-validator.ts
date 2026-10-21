import { Ajv, type ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Role } from "./types.js";

const ajv = new Ajv({ strict: true, allErrors: true });

const validators = new Map<Role, ValidateFunction>();

function schemaPathFor(role: Role): string {
  return resolve(process.cwd(), "schemas", `${role}.json`);
}

function getValidator(role: Role): ValidateFunction {
  const cached = validators.get(role);
  if (cached) {
    return cached;
  }

  const schema = JSON.parse(readFileSync(schemaPathFor(role), "utf8")) as object;
  const validator = ajv.compile(schema);
  validators.set(role, validator);
  return validator;
}

export interface ValidationResult {
  ok: boolean;
  payload?: Record<string, unknown>;
}

export function validateRoleResult(
  role: Role,
  taskId: string,
  inputSha: string,
  rawResult: string | undefined
): ValidationResult {
  if (!rawResult) {
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResult);
  } catch {
    return { ok: false };
  }

  const validator = getValidator(role);
  if (!validator(payload)) {
    return { ok: false };
  }

  const objectPayload = payload as Record<string, unknown>;
  if (objectPayload.task_id !== taskId || objectPayload.input_sha !== inputSha) {
    return { ok: false };
  }

  return { ok: true, payload: objectPayload };
}
