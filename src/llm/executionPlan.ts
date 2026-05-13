import { z } from "zod";
import { getModelName } from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import type { LLMProvider } from "./types.js";

export type ExecutionPlan = {
  objective: string;
  steps: {
    title: string;
    description: string;
    filesLikely: string[];
    /** Phase Q.3: hint that this step is independent / parallelizable enough
     *  to be dispatched as a Task subagent. Informational only — agent still
     *  decides at runtime whether to actually spawn. */
    subagentEligible?: boolean;
    /** Phase Q.3: which subagent kind suits the step. "worker" = isolated
     *  multi-file edits; "explore" = read-only investigation. */
    subagentType?: "explore" | "worker";
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
        subagentEligible: z.boolean().optional(),
        subagentType: z.enum(["explore", "worker"]).optional(),
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
  userApiKey?: string;
  provider?: LLMProvider;
  previousPlan?: ExecutionPlan;
  userFeedback?: string;
}): Promise<ExecutionPlan> {
  const client = createLLMClient({
    apiKey: input.userApiKey,
    provider: input.provider,
  });
  const ctx = getRequestContext();
  const model = getModelName("standard", client.provider, ctx?.modelOverride);
  const relevantFiles = input.relevantFiles.slice(0, 8).join("\n") || "(none)";

  // When the user has reviewed a previous plan and provided feedback, prepend
  // that context so the LLM treats it as the primary revision directive.
  const feedbackSection =
    input.previousPlan && input.userFeedback
      ? `The user reviewed a previous plan and provided this feedback:\n` +
        `"${input.userFeedback}"\n\n` +
        `Previous plan:\n${JSON.stringify(input.previousPlan, null, 2)}\n\n` +
        `Generate a revised plan that addresses the feedback. Preserve what ` +
        `worked in the previous plan; change only what the feedback requests. ` +
        `Keep the same JSON shape (objective, steps, riskHints, scopeSummary).\n\n`
      : "";

  const prompt = `
${feedbackSection}Create a concise execution plan for a code patch.

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

Subagent eligibility (Phase Q.3 / Q.6):
For each step, decide whether it could run as a Task subagent. Mark a step
\`subagentEligible: true\` when it satisfies one of these patterns:
- \`subagentType: "worker"\` — independent multi-file edits, ≥3 files all
  receiving similar transformations (rename across files, repeated find-
  replace, codemods, prop renames). NOT for a single-file edit, even if complex.
- \`subagentType: "explore"\` — pure read-only investigation that doesn't
  depend on parent context ("list every caller of X", "map files matching
  pattern Y", "find all imports of Z"). NOT for trivial lookups the agent can
  do in one read.

Concrete examples — apply these directly:
EXAMPLE A — fanout (mark with worker):
  { "title": "Rename detectFramework to identifyFramework across 5 files",
    "description": "Apply the same identifier change to every site listed below.",
    "filesLikely": ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    "subagentEligible": true, "subagentType": "worker" }
EXAMPLE B — exploration (mark with explore):
  { "title": "Map every caller of helperX",
    "description": "Read all matching files and produce a usage table.",
    "filesLikely": ["src/**/*.ts"],
    "subagentEligible": true, "subagentType": "explore" }
EXAMPLE C — trivial (omit annotation):
  { "title": "Add JSDoc to function Y",
    "description": "One short doc comment above the existing function.",
    "filesLikely": ["src/y.ts"] }

Rules of thumb:
- filesLikely has ≥3 entries AND the description mentions the same change
  applied to each → worker. Mark it.
- filesLikely is one file OR the description describes orchestration work
  that needs shared state → omit.
- When in doubt about a clearly multi-file fanout, MARK it. The agent
  still decides at runtime whether to dispatch — a marked step that the
  agent declines is free; an unmarked fanout step gets no chance.

JSON shape:
{
  "objective": "string",
  "steps": [
    {
      "title": "string",
      "description": "string",
      "filesLikely": ["string"],
      "subagentEligible": true | false,
      "subagentType": "worker" | "explore"
    }
  ],
  "riskHints": ["string"],
  "scopeSummary": "string"
}
`.trim();

  const response = await client.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(
    extractJson(response.choices[0]?.message?.content ?? "")
  );
  const plan = executionPlanSchema.parse(parsed);

  // Phase Q.6: relaxed normalization. If the LLM signals delegatable intent
  // via either field, fill in the missing one rather than silently dropping
  // the annotation:
  //   eligible:true + no type       → infer subagentType="worker" (most common)
  //   no eligible + type:"worker"   → infer subagentEligible=true
  //   no eligible + type:"explore"  → infer subagentEligible=true
  //   eligible:false                → drop both (explicit opt-out)
  const normalizedSteps = plan.steps.map((step) => {
    const explicitEligibleFalse = step.subagentEligible === false;
    const rawType = step.subagentType;
    const typeIsValid = rawType === "worker" || rawType === "explore";
    const eligibleSignal = step.subagentEligible === true || typeIsValid;

    if (!explicitEligibleFalse && eligibleSignal) {
      const inferredType: "worker" | "explore" = typeIsValid ? rawType : "worker";
      return {
        title: step.title,
        description: step.description,
        filesLikely: step.filesLikely,
        subagentEligible: true,
        subagentType: inferredType,
      };
    }
    return {
      title: step.title,
      description: step.description,
      filesLikely: step.filesLikely,
    };
  });

  return {
    objective: plan.objective,
    steps: normalizedSteps,
    riskHints: plan.riskHints,
    scopeSummary: plan.scopeSummary,
  };
}
