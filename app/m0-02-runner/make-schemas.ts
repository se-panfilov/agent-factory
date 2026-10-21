import { mkdirSync, writeFileSync } from "node:fs";

const str = { type: "string" };
const arr = (items: object) => ({ type: "array", items });
const obj = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const finding = obj({ path: str, observation: str, evidence: str });
const proposal = obj({ title: str, reason: str, acceptance: arr(str) });

const common = {
  schema_version: { type: "integer", enum: [1] },
  task_id: str,
  input_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
  summary: str,
  blockers: arr(str),
};

const roles = {
  scout: { findings: arr(finding), proposals: arr(proposal) },
  planner: {
    steps: arr(obj({ id: str, action: str, checks: arr(str) })),
    paths: arr(str),
    risks: arr(str),
    proposals: arr(proposal),
  },
  implementer: {
    changed_paths: arr(str),
    checks_claimed: arr(str),
    unverified: arr(str),
    deviations: arr(str),
  },
  reviewer: {
    candidate_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    verdict: { type: "string", enum: ["accept", "changes_requested", "blocked"] },
    findings: arr(finding),
    checks_needed: arr(str),
  },
};

mkdirSync("schemas", { recursive: true });
for (const [role, properties] of Object.entries(roles)) {
  writeFileSync(
    `schemas/${role}.json`,
    JSON.stringify(
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        ...obj({ ...common, role: { type: "string", enum: [role] }, ...properties }),
      },
      null,
      2
    ) + "\n"
  );
}
