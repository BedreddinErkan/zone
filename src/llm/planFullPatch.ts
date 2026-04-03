import { z } from "zod";
import { createOpenAIClient, getModelName } from "./openaiClient.js";
import { buildFullPatchPrompt } from "../prompts/fullPatchPrompt.js";

const fullPatchSchema = z.object({
  filePath: z.string(),
  fullContent: z.string(),
  summary: z.string(),
  warnings: z.array(z.string()),
});

export interface FullPatchResult {
  filePath: string;
  fullContent: string;
  summary: string;
  warnings: string[];
}

function extractJson(rawText: string): string {
  const trimmed = rawText.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error(
    `No JSON object found in model response. Raw response: ${rawText}`
  );
}

export async function planFullPatchWithLlm(input: {
  task: string;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
}): Promise<FullPatchResult> {
  const client = createOpenAIClient();
  const model = getModelName();

  const prompt = buildFullPatchPrompt(input);

  const response = await client.responses.create({ model, input: prompt });

  const rawText = response.output_text ?? "";
  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(jsonText) as unknown;
  const validated = fullPatchSchema.parse(parsed);

  return {
    filePath: validated.filePath,
    fullContent: validated.fullContent,
    summary: validated.summary,
    warnings: validated.warnings,
  };
}
