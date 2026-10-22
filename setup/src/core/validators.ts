import { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import configSchema from "../../schemas/config.schema.json";
import stateSchema from "../../schemas/state.schema.json";
import planSchema from "../../schemas/plan.schema.json";
import installerReleaseSchema from "../../schemas/installer-release.schema.json";
import applicationManifestSchema from "../../schemas/application-manifest.schema.json";

export type ContractSchemaName =
  | "config"
  | "state"
  | "plan"
  | "installer-release"
  | "application-manifest";

export interface ValidationResult {
  ok: boolean;
  schema: ContractSchemaName;
  errors: string[];
}

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  allowUnionTypes: false,
  removeAdditional: false
});

const schemaValidators: Record<ContractSchemaName, ValidateFunction> = {
  config: ajv.compile(configSchema),
  state: ajv.compile(stateSchema),
  plan: ajv.compile(planSchema),
  "installer-release": ajv.compile(installerReleaseSchema),
  "application-manifest": ajv.compile(applicationManifestSchema)
};

const PATH_FIELDS_IN_CONFIG = [
  "/paths/setup_state_dir",
  "/paths/setup_cache_dir",
  "/paths/setup_bin_dir",
  "/paths/setup_node_dir",
  "/paths/application_dir",
  "/paths/application_state_dir",
  "/paths/application_auth_dir",
  "/paths/application_work_dir",
  "/release/archive_path",
  "/version_lock_path",
  "/operations/backup_path"
] as const;

function toErrorMessage(error: ErrorObject): string {
  const path = error.instancePath.length > 0 ? error.instancePath : "/";
  return `${path}: ${error.message ?? "validation error"}`;
}

function isUnsafePath(pathValue: string): boolean {
  if (!pathValue.startsWith("/")) {
    return true;
  }

  const segments = pathValue.split("/").filter((segment) => segment.length > 0);
  return segments.some((segment) => segment === "." || segment === "..");
}

function getByJsonPointer(document: unknown, pointer: string): unknown {
  const segments = pointer.split("/").slice(1);
  let current: unknown = document;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateConfigSemanticRules(data: unknown): string[] {
  const semanticErrors: string[] = [];

  for (const field of PATH_FIELDS_IN_CONFIG) {
    const value = getByJsonPointer(data, field);
    if (typeof value === "string" && isUnsafePath(value)) {
      semanticErrors.push(`${field}: path must be absolute and must not contain '.' or '..'`);
    }
  }

  const releaseSha = getByJsonPointer(data, "/release/sha256");
  if (typeof releaseSha !== "string" || releaseSha.length !== 64) {
    semanticErrors.push("/release/sha256: sha256 must contain exactly 64 lowercase hex chars");
  }

  return semanticErrors;
}

export function validateContractSchema(
  schema: ContractSchemaName,
  data: unknown
): ValidationResult {
  const validator = schemaValidators[schema];
  const valid = validator(data);

  const validationErrors = valid
    ? []
    : (validator.errors ?? []).map((error) => toErrorMessage(error));

  const semanticErrors =
    schema === "config" ? validateConfigSemanticRules(data) : [];

  return {
    ok: validationErrors.length === 0 && semanticErrors.length === 0,
    schema,
    errors: [...validationErrors, ...semanticErrors]
  };
}

export function validateAllContracts(input: {
  config: unknown;
  state: unknown;
  plan: unknown;
  installerRelease: unknown;
  applicationManifest: unknown;
}): ValidationResult[] {
  return [
    validateContractSchema("config", input.config),
    validateContractSchema("state", input.state),
    validateContractSchema("plan", input.plan),
    validateContractSchema("installer-release", input.installerRelease),
    validateContractSchema("application-manifest", input.applicationManifest)
  ];
}
