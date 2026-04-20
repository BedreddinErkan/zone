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

function sanitizeTemplateLiterals(raw: string): string {
  // Replace `...` template literals used as JSON values with "..."
  return raw.replace(/`([^`]*)`/g, (_, inner) => {
    // Escape any double quotes inside
    const escaped = inner.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `"${escaped}"`;
  });
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

function sanitizeSingleQuotedKeys(raw: string): string {
  return raw.replace(/'([^']+)'(\s*:)/g, "\"$1\"$2");
}

function extractAndRepairJson(raw: string): string {
  // Step 1: Extract JSON boundaries
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("No JSON found");
  let json = raw.slice(first, last + 1);

  // Step 2: Replace template literals with quoted strings
  json = json.replace(/`([^`]*)`/g, (_, inner) =>
    '"' + inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\n/g, "\\n").replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") + '"'
  );

  // Step 3: Fix unescaped control characters inside string values
  // Parse character by character to find string boundaries
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      result += ch;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
      if (ch === "\u0000") continue;
    }
    result += ch;
  }
  return result;
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
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractAndRepairJson(stripJsonFences(rawText)));
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
