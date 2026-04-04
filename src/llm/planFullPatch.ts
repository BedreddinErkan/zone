import { z } from "zod";
import { createOpenAIClient, getModelName } from "./openaiClient.js";
import {
  buildFullPatchPrompt,
  type FullPatchOutputMode,
} from "../prompts/fullPatchPrompt.js";

const fullContentSchema = z.object({
  filePath: z.string(),
  fullContent: z.string(),
  summary: z.string(),
  warnings: z.array(z.string()),
});

const LARGE_FILE_PATCH_THRESHOLD = 8000;

export type FullPatchResult =
  | {
      mode: "full_content";
      filePath: string;
      fullContent: string;
      summary: string;
      warnings: string[];
    }
  | {
      mode: "patch";
      filePath: string;
      patchText: string;
      summary: string;
      warnings: string[];
    };

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
  const outputMode: FullPatchOutputMode =
    input.fileContent.length > LARGE_FILE_PATCH_THRESHOLD
      ? "find_replace_patch"
      : "full_content";

  const prompt = buildFullPatchPrompt({
    task: input.task,
    filePath: input.filePath,
    fileContent: input.fileContent,
    repoSummary: input.repoSummary,
    relatedContext: input.relatedContext,
    outputMode,
  });

  const response = await client.responses.create({ model, input: prompt });
  const rawText = response.output_text ?? "";

  if (outputMode === "find_replace_patch") {
    return {
      mode: "patch",
      filePath: input.filePath,
      patchText: rawText.trim(),
      summary: "Large-file targeted patch generated.",
      warnings: [],
    };
  }

  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(jsonText) as unknown;
  const validated = fullContentSchema.parse(parsed);

  return {
    mode: "full_content",
    filePath: validated.filePath,
    fullContent: validated.fullContent,
    summary: validated.summary,
    warnings: validated.warnings,
  };
}
