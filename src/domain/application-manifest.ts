export const MANIFEST_COMMAND_KEYS_M0 = [
  "runner_run",
  "runner_status",
  "runner_stop",
  "verify_fake",
] as const;

export type ManifestCommandKeyM0 = (typeof MANIFEST_COMMAND_KEYS_M0)[number];

export interface ApplicationManifestM0 {
  schema_version: number;
  application_version: string;
  source_commit: string;
  content_hashes: Record<string, string>;
  node_range: string;
  capabilities: string[];
  commands: Record<ManifestCommandKeyM0, string[]>;
  config_schema_version: number;
  migrations_from: number;
  migrations_to: number;
  security_evidence_refs: string[];
}
