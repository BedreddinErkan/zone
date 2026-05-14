export type ModelRole =
  | "planner"
  | "agent"
  | "worker"
  | "verifier"
  | "classifier"
  | "intent"
  | "investigator";

export type RoutingProvider = "anthropic" | "openai";

export interface RoleModelMapping {
  planner: string;
  agent: string;
  worker: string;
  verifier: string;
  classifier: string;
  intent: string;
  investigator: string;
}

// Anthropic recommended hybrid: Sonnet plans/agents, Haiku executes in parallel.
// Haiku 4.5 scores 73.3% on SWE-bench Verified at $1/$5 vs Sonnet's $3/$15.
// Investigator uses Sonnet by default for synthesis depth; Speed preset can
// override to Haiku, Quality preset to Opus.
const ANTHROPIC_DEFAULTS: RoleModelMapping = {
  planner: "claude-sonnet-4-6",
  agent: "claude-sonnet-4-6",
  worker: "claude-haiku-4-5",
  verifier: "claude-sonnet-4-6",
  classifier: "claude-haiku-4-5",
  intent: "claude-sonnet-4-6",
  investigator: "claude-sonnet-4-6",
};

const OPENAI_DEFAULTS: RoleModelMapping = {
  planner: "gpt-5.4",
  agent: "gpt-5.4",
  worker: "gpt-5.4-mini",
  verifier: "gpt-5.4",
  classifier: "gpt-5.4-mini",
  intent: "gpt-5.4",
  investigator: "gpt-5.4",
};

export function getModelForRole(
  role: ModelRole,
  provider: RoutingProvider,
  override?: Partial<RoleModelMapping>
): string {
  const defaults =
    provider === "anthropic" ? ANTHROPIC_DEFAULTS : OPENAI_DEFAULTS;
  return override?.[role] ?? defaults[role];
}
