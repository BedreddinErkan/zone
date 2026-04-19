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

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function sanitizeInvalidJsonBackslashes(raw: string): string {
  return raw.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function sanitizeBackticksInJsonStrings(raw: string): string {
  // Replace backticks inside JSON string values with single quotes
  // Only replace backticks that appear inside quoted JSON strings
  return raw.replace(/"([^"]*)"/g, (match, inner) => {
    return '"' + inner.replace(/`/g, "'") + '"';
  });
}

export async function planPatchPreviewWithLlm(input: {
  task: string;
  intent: TaskIntent;
  projectSummary: string;
  projectNotes: string[];
  suggestedFiles: { path: string; action: string; reason: string }[];
  fileContexts: { path: string; content: string }[];
  schemaAwareSummary?: string[];
  userOpenAiKey?: string;
}): Promise<LlmPatchPlan> {
  const client = createOpenAIClient(input.userOpenAiKey);
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
  const normalizedJsonText = stripJsonFences(jsonText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalizedJsonText);
  } catch (initialError) {
    try {
      parsed = JSON.parse(sanitizeInvalidJsonBackslashes(normalizedJsonText));
    } catch {
      try {
        const sanitized = sanitizeBackticksInJsonStrings(
          sanitizeInvalidJsonBackslashes(normalizedJsonText)
        );
        parsed = JSON.parse(sanitized);
      } catch {
        const preview = rawText.slice(0, 50);
        const initialMessage =
          initialError instanceof Error ? initialError.message : String(initialError);
        throw new Error(
          `Failed to parse patch preview JSON: ${initialMessage}. Raw preview: ${preview}`
        );
      }
    }
  }

  const validated = llmPatchPlanSchema.parse(parsed);

  return {
    summary: validated.summary,
    patches: validated.patches,
    warnings: validated.warnings
  };
}
