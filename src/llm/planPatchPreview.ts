import { createOpenAIClient, getModelName } from "./openaiClient.js";
import { llmPatchPlanSchema } from "./schemas.js";
import type { LlmPatchPlan } from "../types/agent.js";
import type { TaskIntent } from "../core/taskIntentParser.js";
import { buildPatchPreviewPrompt } from "../prompts/patchPreviewPrompt.js";

function extractJson(rawText: string): string {
  const trimmed = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error(`No JSON object found in model response. Raw response: ${rawText}`);
}

export async function planPatchPreviewWithLlm(input: {
  task: string;
  intent: TaskIntent;
  projectSummary: string;
  projectNotes: string[];
  suggestedFiles: { path: string; action: string; reason: string }[];
  fileContexts: { path: string; content: string }[];
  schemaAwareSummary?: string[];
}): Promise<LlmPatchPlan> {
  const client = createOpenAIClient();
  const model = getModelName();

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
    schemaAwareSummary
  });

  const response = await client.responses.create({
    model,
    input: prompt
  });

  const rawText = response.output_text || "";
  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(jsonText);
  const validated = llmPatchPlanSchema.parse(parsed);

  return {
    summary: validated.summary,
    patches: validated.patches,
    warnings: validated.warnings
  };
}
