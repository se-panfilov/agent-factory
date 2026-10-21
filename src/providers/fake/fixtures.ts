import type { Role, ProviderRun } from "../../domain/types.js";

export type FakeFixtureCase =
  | "success"
  | "invalid_json"
  | "missing_result"
  | "wrong_sha"
  | "provider_error";

const ZERO_SHA = "0".repeat(40);

function successResult(role: Role, taskId: string, inputSha: string): Record<string, unknown> {
  const base = {
    schema_version: 1,
    role,
    task_id: taskId,
    input_sha: inputSha,
    summary: "fixture-success",
    blockers: [],
  };

  switch (role) {
    case "scout":
      return { ...base, findings: [], proposals: [] };
    case "planner":
      return { ...base, steps: [], paths: [], risks: [], proposals: [] };
    case "implementer":
      return {
        ...base,
        changed_paths: [],
        checks_claimed: [],
        unverified: [],
        deviations: [],
      };
    case "reviewer":
      return {
        ...base,
        candidate_sha: inputSha,
        verdict: "accept",
        findings: [],
        checks_needed: [],
      };
  }
}

export function buildFixtureRun(
  role: Role,
  taskId: string,
  inputSha: string,
  fixtureCase: FakeFixtureCase
): ProviderRun {
  const successPayload = successResult(role, taskId, inputSha);

  switch (fixtureCase) {
    case "success":
      return {
        role,
        taskId,
        inputSha,
        exitCode: 0,
        events: [{ type: "message", role: "assistant", content: "thinking" }, { type: "turn.completed" }],
        resultText: JSON.stringify(successPayload),
      };
    case "invalid_json":
      return {
        role,
        taskId,
        inputSha,
        exitCode: 0,
        events: [{ type: "turn.completed" }],
        resultText: "[",
      };
    case "missing_result":
      return {
        role,
        taskId,
        inputSha,
        exitCode: 0,
        events: [{ type: "turn.completed" }],
      };
    case "wrong_sha":
      return {
        role,
        taskId,
        inputSha,
        exitCode: 0,
        events: [{ type: "turn.completed" }],
        resultText: JSON.stringify({ ...successPayload, input_sha: ZERO_SHA }),
      };
    case "provider_error":
      return {
        role,
        taskId,
        inputSha,
        exitCode: 1,
        events: [{ type: "turn.failed", detail: "provider failed fixture" }],
      };
  }
}
