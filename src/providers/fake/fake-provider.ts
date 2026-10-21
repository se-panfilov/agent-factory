import { buildFixtureRun, type FakeFixtureCase } from "./fixtures.js";
import type { ProviderRun, Role } from "../../domain/types.js";

export interface FakeProviderInput {
  role: Role;
  taskId: string;
  inputSha: string;
  fixtureCase: FakeFixtureCase;
}

export class FakeProvider {
  run(input: FakeProviderInput): ProviderRun {
    return buildFixtureRun(
      input.role,
      input.taskId,
      input.inputSha,
      input.fixtureCase
    );
  }
}
