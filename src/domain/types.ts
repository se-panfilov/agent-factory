export const ROLES = ["scout", "planner", "implementer", "reviewer"] as const;

export type Role = (typeof ROLES)[number];

export type ProviderEvent =
  | { type: "turn.completed" }
  | { type: "turn.failed"; detail?: string }
  | { type: "error"; detail: string }
  | { type: "message"; role: "assistant" | "tool" | "system"; content: string }
  | { type: string; detail?: string };

export interface ProviderRun {
  role: Role;
  taskId: string;
  inputSha: string;
  exitCode: number;
  events: ProviderEvent[];
  resultText?: string;
}

export type RunPhase = "needs_review" | "blocked";

export interface RunAssessment {
  phase: RunPhase;
  reason: string | null;
}
