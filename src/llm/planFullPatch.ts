import { z } from "zod";
import { createOpenAIClient, getModelName } from "./openaiClient.js";
import { buildDeveloperPrompt } from "../prompts/developerPrompt.js";

const fullPatchSchema = z.object({
  filePath: z.string(),
  patchText: z.string(),
  summary: z.string(),
  warnings: z.array(z.string()),
});

export interface FullPatchResult {
  filePath: string;
  patchText: string;
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
  repoPath?: string;
  taskIntent?: string;
  relevantFiles?: Array<{ path: string; content?: string }>;
  existingTargetFiles?: string[];
}): Promise<FullPatchResult> {
  const client = createOpenAIClient();
  const model = getModelName();

  const prompt = buildDeveloperPrompt({
    task: input.task,
    repoPath: input.repoPath ?? "(current workspace)",
    relevantFiles: Array.isArray(input.relevantFiles) ? input.relevantFiles : [],
    taskIntent: input.taskIntent ?? "general",
    existingTargetFiles: Array.isArray(input.existingTargetFiles)
      ? input.existingTargetFiles
      : [input.filePath],
    targetFilePath: input.filePath,
    targetFileContent: input.fileContent,
    repoSummary: input.repoSummary,
    relatedContext: input.relatedContext,
  });

  const response = await client.responses.create({ model, input: prompt });

  const rawText = response.output_text ?? "";
  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(jsonText) as unknown;
  const validated = fullPatchSchema.parse(parsed);

  return {
    filePath: validated.filePath,
    patchText: validated.patchText,
    summary: validated.summary,
    warnings: validated.warnings,
  };
}
