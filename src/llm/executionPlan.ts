import { z } from "zod";
import { createOpenAIClient, getModelName } from "./openaiClient.js";

export type ExecutionPlan = {
  objective: string;
  steps: {
    title: string;
    description: string;
    filesLikely: string[];
  }[];
  riskHints: string[];
  scopeSummary: string;
};

const executionPlanSchema = z.object({
  objective: z.string(),
  steps: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        filesLikely: z.array(z.string()),
      })
    )
    .min(1)
    .max(6),
  riskHints: z.array(z.string()),
  scopeSummary: z.string(),
});

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractJson(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object found in execution plan response.");
  }
  return cleaned.slice(first, last + 1);
}

export function formatExecutionPlanForPrompt(plan?: ExecutionPlan | null): string {
  if (!plan) {
    return "";
  }

  const steps = plan.steps
    .map((step, index) => {
      const files = step.filesLikely.length > 0 ? step.filesLikely.join(", ") : "unknown";
      return `${index + 1}. ${step.title}: ${step.description} (files: ${files})`;
    })
    .join("\n");

  return [
    `Objective: ${plan.objective}`,
    "Steps:",
    steps,
    `Scope: ${plan.scopeSummary}`,
  ].join("\n");
}

export async function generateExecutionPlan(input: {
  task: string;
  repoSummary: string;
  relevantFiles: string[];
  userOpenAiKey?: string;
}): Promise<ExecutionPlan> {
  const client = createOpenAIClient(input.userOpenAiKey);
  const model = getModelName();
  const relevantFiles = input.relevantFiles.slice(0, 8).join("\n") || "(none)";

  const prompt = `
Create a concise execution plan for a code patch.

TASK
${input.task}

REPO SUMMARY
${input.repoSummary}

RELEVANT FILES
${relevantFiles}

Rules:
- Break the task into 3-6 implementation steps.
- Estimate affected files by path/name when possible.
- Identify risks briefly.
- Keep scopeSummary under 160 characters.
- Return JSON only.

JSON shape:
{
  "objective": "string",
  "steps": [
    {
      "title": "string",
      "description": "string",
      "filesLikely": ["string"]
    }
  ],
  "riskHints": ["string"],
  "scopeSummary": "string"
}
`.trim();

  const response = await client.responses.create({
    model,
    input: prompt,
    text: { format: { type: "json_object" } },
  });

  const parsed = JSON.parse(extractJson(response.output_text || ""));
  const plan = executionPlanSchema.parse(parsed);

  return {
    objective: plan.objective,
    steps: plan.steps,
    riskHints: plan.riskHints,
    scopeSummary: plan.scopeSummary,
  };
}
