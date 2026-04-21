import { createOpenAIClient, getModelName } from "./openaiClient.js";

export const PROMPT_REFINEMENT_FALLBACK =
  "Describe the exact file, function, and behavior you want changed.";

type PromptRefinementPlan = {
  objective?: string;
  steps?: Array<{ title?: string }>;
  scopeSummary?: string;
};

function cleanRefinedPrompt(value: string): string {
  const firstLine = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  return (firstLine ?? "")
    .replace(/^[-*]\s*/, "")
    .replace(/^refined prompt:\s*/i, "")
    .trim();
}

export async function refinePrompt(input: {
  task: string;
  role?: string;
  plan?: PromptRefinementPlan;
  relevantFiles?: string[];
  reason?: string;
  userOpenAiKey?: string;
}): Promise<string> {
  const client = createOpenAIClient(input.userOpenAiKey);
  const model = getModelName();
  const role = input.role || "developer";
  const relevantFiles = (input.relevantFiles ?? []).slice(0, 8).join(", ") || "unknown";
  const planSteps =
    input.plan?.steps
      ?.map((step) => step.title)
      .filter(Boolean)
      .slice(0, 4)
      .join("; ") || "none";

  const prompt = `
Rewrite the user's task into one clearer, more specific prompt.

Original task:
${input.task}

Role: ${role}
Reason: ${input.reason || "unspecified"}
Relevant files: ${relevantFiles}
Plan objective: ${input.plan?.objective || "none"}
Plan steps: ${planSteps}
Scope: ${input.plan?.scopeSummary || "unknown"}

Rules:
- Preserve the user's intent.
- Do not expand the task.
- Prefer naming a file, function, or behavior when possible.
- Return exactly one practical prompt.
- Use one sentence, or two short sentences max.
- No explanation, preamble, bullets, or markdown.
`.trim();

  const response = await client.responses.create({
    model,
    input: prompt,
  });

  const refined = cleanRefinedPrompt(response.output_text || "");
  return refined || PROMPT_REFINEMENT_FALLBACK;
}
