import { createOpenAIClient, getModelName } from "./openaiClient.js";
import { llmFeaturePlanSchema } from "./schemas.js";
import type { LlmFeaturePlan } from "../types/agent.js";
import type { TaskIntent } from "../core/taskIntentParser.js";
import { buildPlanFeaturePrompt } from "../prompts/planFeaturePrompt.js";

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

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function planFeatureWithLlm(input: {
  task: string;
  intent: TaskIntent;
  projectSummary: string;
  projectNotes: string[];
  relevantFiles: { path: string; category: string }[];
  existingFilesSummary: string;
  schemaAwareSummary?: string[];
  userOpenAiKey?: string;
}): Promise<LlmFeaturePlan> {
  const client = createOpenAIClient(input.userOpenAiKey);
  const model = getModelName("high");

  const relevantFilesSummary = input.relevantFiles
    .map((file) => `- ${file.path} [${file.category}]`)
    .join("\n");

  const repoSummary = [input.projectSummary, ...input.projectNotes]
    .filter(Boolean)
    .join("\n");

const schemaAwareSummary = (input.schemaAwareSummary ?? [])
  .filter(Boolean)
  .map((line) => `- ${line}`)
  .join("\n");
  const prompt = buildPlanFeaturePrompt({
    task: input.task,
    intent: input.intent,
    repoSummary,
    relevantFilesSummary,
    existingFilesSummary: input.existingFilesSummary,
    schemaAwareSummary
  });

  const response = await client.responses.create({
    model,
    input: prompt
  });

  console.log("\n=== RAW MODEL OUTPUT ===");
  console.log(response.output_text);

  const rawText = response.output_text || "";
  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(stripJsonFences(jsonText));

  const validated = llmFeaturePlanSchema.parse(parsed);

  return {
    implementationSummary: validated.implementationSummary,
    steps: validated.steps,
    suggestedFiles: validated.suggestedFiles,
    risks: validated.risks
  };
}
