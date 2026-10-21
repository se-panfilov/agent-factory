import test from "node:test";
import assert from "node:assert/strict";
import { assessProviderRun } from "../src/domain/run-assessor.js";
import { FakeProvider } from "../src/providers/fake/fake-provider.js";
import { ROLES, type Role } from "../src/domain/types.js";

const provider = new FakeProvider();
const TASK_ID = "factory-pr-00";
const INPUT_SHA = "0123456789abcdef0123456789abcdef01234567";

for (const role of ROLES) {
  test(`${role}: success fixture is accepted`, () => {
    const run = provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "success",
    });
    assert.deepEqual(assessProviderRun(run), { phase: "needs_review", reason: null });
  });

  test(`${role}: invalid JSON fixture is rejected`, () => {
    const run = provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "invalid_json",
    });
    assert.deepEqual(assessProviderRun(run), {
      phase: "blocked",
      reason: "invalid_result",
    });
  });

  test(`${role}: missing result is rejected even with exit 0`, () => {
    const run = provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "missing_result",
    });
    assert.equal(run.exitCode, 0);
    assert.deepEqual(assessProviderRun(run), {
      phase: "blocked",
      reason: "invalid_result",
    });
  });

  test(`${role}: wrong SHA fixture is rejected`, () => {
    const run = provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "wrong_sha",
    });
    assert.deepEqual(assessProviderRun(run), {
      phase: "blocked",
      reason: "invalid_result",
    });
  });

  test(`${role}: provider error fixture is rejected`, () => {
    const run = provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "provider_error",
    });
    assert.deepEqual(assessProviderRun(run), {
      phase: "blocked",
      reason: "provider_protocol_error",
    });
  });
}

test("extra JSON fields are rejected by schema additionalProperties=false", () => {
  const run = provider.run({
    role: "scout",
    taskId: TASK_ID,
    inputSha: INPUT_SHA,
    fixtureCase: "success",
  });

  const payload = JSON.parse(run.resultText ?? "{}") as Record<string, unknown>;
  payload.extra_field = "forbidden";

  const result = assessProviderRun({ ...run, resultText: JSON.stringify(payload) });
  assert.deepEqual(result, { phase: "blocked", reason: "invalid_result" });
});

test("unknown provider event is never accepted as success", () => {
  const run = provider.run({
    role: "planner",
    taskId: TASK_ID,
    inputSha: INPUT_SHA,
    fixtureCase: "success",
  });

  const result = assessProviderRun({
    ...run,
    events: [...run.events, { type: "turn.unknown" }],
  });

  assert.deepEqual(result, { phase: "blocked", reason: "unknown_provider_event" });
});

test("assistant messages do not mutate state outcome", () => {
  const role: Role = "implementer";
  const withMessages = assessProviderRun(
    provider.run({
      role,
      taskId: TASK_ID,
      inputSha: INPUT_SHA,
      fixtureCase: "success",
    })
  );
  const withoutMessages = assessProviderRun({
    role,
    taskId: TASK_ID,
    inputSha: INPUT_SHA,
    exitCode: 0,
    events: [{ type: "turn.completed" }],
    resultText: (() => {
      const resultText = provider.run({
        role,
        taskId: TASK_ID,
        inputSha: INPUT_SHA,
        fixtureCase: "success",
      }).resultText;
      if (!resultText) {
        throw new Error("success fixture must contain resultText");
      }
      return resultText;
    })(),
  });

  assert.deepEqual(withMessages, withoutMessages);
  assert.deepEqual(withMessages, { phase: "needs_review", reason: null });
});
