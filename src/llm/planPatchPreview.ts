import { getModelName } from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import { llmPatchPlanSchema } from "./schemas.js";
import type { LlmPatchPlan } from "../types/agent.js";
import type { TaskIntent } from "../core/taskIntentParser.js";
import { buildPatchPreviewPrompt } from "../prompts/patchPreviewPrompt.js";
import {
  formatExecutionPlanForPrompt,
  type ExecutionPlan,
} from "./executionPlan.js";

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractAndRepairJson(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON found");
  }
  return cleaned.slice(first, last + 1);
}

export async function planPatchPreviewWithLlm(input: {
  task: string;
  intent: TaskIntent;
  projectSummary: string;
  projectNotes: string[];
  suggestedFiles: { path: string; action: string; reason: string }[];
  fileContexts: { path: string; content: string }[];
  schemaAwareSummary?: string[];
  executionPlan?: ExecutionPlan | null;
}): Promise<LlmPatchPlan> {
  const client = createLLMClient();
  const ctx = getRequestContext();
  const model = getModelName("standard", client.provider, ctx?.modelOverride);

  const combinedContext = input.fileContexts
    .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join("\n\n");

  const repoSummary = [input.projectSummary, ...input.projectNotes]
    .filter(Boolean)
    .join("\n");

  const relatedContext = input.suggestedFiles.length
    ? input.suggestedFiles
        .map((f) => `- ${f.path} | ${f.action} | ${f.reason}`)
        .join("\n")
    : "(no suggested files)";

  const schemaAwareSummary = (input.schemaAwareSummary ?? [])
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");

  const prompt = buildPatchPreviewPrompt({
    task: input.task,
    intent: input.intent,
    filePath: input.suggestedFiles.map((f) => f.path).join(", ") || "(no target file)",
    fileContent: combinedContext,
    repoSummary,
    relatedContext,
    schemaAwareSummary,
    executionPlanContext: formatExecutionPlanForPrompt(input.executionPlan),
  });

  const response = await client.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const rawText = response.choices[0]?.message?.content ?? "";
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractAndRepairJson(rawText));
  } catch (error) {
    const preview = rawText.slice(0, 50);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse patch preview JSON: ${message}. Raw preview: ${preview}`
    );
  }

  const validated = llmPatchPlanSchema.parse(parsed);

  return {
    summary: validated.summary,
    patches: validated.patches,
    warnings: validated.warnings
  };
}
