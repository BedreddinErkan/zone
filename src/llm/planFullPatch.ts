import { z } from "zod";
import { createOpenAIClient, getModelName } from "./openaiClient.js";
import {
  withSelfHealingRetry,
  buildDefaultFeedbackPrompt,
} from "../core/withSelfHealingRetry.js";
import {
  buildFullPatchPrompt,
  type FullPatchOutputMode,
} from "../prompts/fullPatchPrompt.js";
import {
  formatExecutionPlanForPrompt,
  type ExecutionPlan,
} from "./executionPlan.js";
import { parseDeveloperPatchText } from "../core/developerPatchParse.js";

const fullContentSchema = z.object({
  filePath: z.string(),
  fullContent: z.string(),
  summary: z.string(),
  warnings: z.array(z.string()),
});

const LARGE_FILE_PATCH_THRESHOLD = 8000;

function isConstrainedLocalizedPatchTask(task: string): boolean {
  const normalizedTask = task.toLowerCase();
  return [
    /\bexisting form\b/,
    /\bexisting submit flow\b/,
    /\bexisting state\b/,
    /\breuse (?:the )?existing state\b/,
    /\breuse (?:the )?existing submit flow\b/,
    /\bdo not create (?:a )?new form\b/,
    /\bdo not introduce (?:a )?new api call\b/,
    /\bdo not add (?:a )?new api call\b/,
  ].some((pattern) => pattern.test(normalizedTask));
}

function selectFullPatchOutputMode(input: {
  outputMode?: FullPatchOutputMode;
  task: string;
  fileContent: string;
  relatedContext: string;
}): FullPatchOutputMode {
  if (input.outputMode) {
    return input.outputMode;
  }

  const hasContextWindow = input.relatedContext.includes("// CONTEXT WINDOW:");
  const shouldPreferFullContent =
    hasContextWindow &&
    input.fileContent.length < LARGE_FILE_PATCH_THRESHOLD &&
    isConstrainedLocalizedPatchTask(input.task);

  if (shouldPreferFullContent) {
    return "full_content";
  }

  return input.fileContent.length < LARGE_FILE_PATCH_THRESHOLD
    ? "full_content"
    : "find_replace_patch";
}

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
    }
  | {
      mode: "invalid_patch_format";
      filePath: string;
      summary: string;
      warnings: string[];
    };

function buildFindReplaceStrictContract(filePath: string): string {
  return [
    "OUTPUT CONTRACT (MANDATORY — entire reply = patch only, zero preamble/prose):",
    `1) First non-empty line MUST be: --- FILE: ${filePath}`,
    "2) Then immediately:",
    "--- FIND ---",
    "(verbatim excerpt from CURRENT FILE CONTENT — must match exactly)",
    "--- REPLACE ---",
    "(replacement for that excerpt only)",
    "3) Optionally wrap only the FIND/REPLACE section in a single ```diff ... ``` fence.",
    "4) Do NOT return JSON, the full file, or explanations outside the patch.",
    "5) If you cannot produce a valid patch, output only exactly: NO_VALID_PATCH",
  ].join("\n");
}

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

  throw new Error(
    `No JSON object found in model response. Raw response: ${rawText}`
  );
}

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function planFullPatchWithLlm(input: {
  task: string;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
  outputMode?: FullPatchOutputMode;
  repoPath?: string;
  taskIntent?: string;
  normalizedTaskIntent?: string;
  relevantFiles?: Array<{ path: string; content?: string }>;
  existingTargetFiles?: string[];
  executionPlan?: ExecutionPlan | null;
}): Promise<FullPatchResult> {
  const client = createOpenAIClient();
  const model = getModelName("high");
  const outputMode = selectFullPatchOutputMode({
    outputMode: input.outputMode,
    task: input.task,
    fileContent: input.fileContent,
    relatedContext: input.relatedContext,
  });
  const prompt = buildFullPatchPrompt({
    task: input.task,
    filePath: input.filePath,
    fileContent: input.fileContent,
    repoSummary: input.repoSummary,
    relatedContext: input.relatedContext,
    taskIntent: input.taskIntent,
    normalizedTaskIntent: input.normalizedTaskIntent,
    outputMode,
    executionPlanContext: formatExecutionPlanForPrompt(input.executionPlan),
  });

  if (outputMode === "find_replace_patch") {
    const findReplacePrompt = `${prompt.trim()}\n\n${buildFindReplaceStrictContract(
      input.filePath
    )}`;

    const retryResult = await withSelfHealingRetry({
      maxAttempts: 3,
      prompt: findReplacePrompt,
      execute: async (currentPrompt: string) => {
        const response = await client.responses.create({
          model,
          input: currentPrompt,
        });
        return (response.output_text ?? "").trim();
      },
      validate: (raw: string) => {
        const issues: Array<{
          code: string;
          message: string;
          severity: "error" | "warning";
        }> = [];
        if (!raw.trim()) {
          issues.push({
            code: "EMPTY_PATCH",
            message: "Model returned empty output.",
            severity: "error",
          });
          return issues;
        }
        const trimmed = raw.trim();
        if (trimmed === "NO_VALID_PATCH" || trimmed === "NO_CHANGE_NEEDED") {
          return issues;
        }
        if (!raw.includes("--- FILE:") || !raw.includes("--- FIND ---")) {
          issues.push({
            code: "INVALID_PATCH_FORMAT",
            message:
              "Response must include --- FILE: <path> and --- FIND --- / --- REPLACE --- blocks (or only NO_VALID_PATCH / NO_CHANGE_NEEDED).",
            severity: "error",
          });
          return issues;
        }
        if (!parseDeveloperPatchText(raw)) {
          issues.push({
            code: "INVALID_PATCH_FORMAT",
            message:
              "Patch text could not be parsed into structured FIND/REPLACE edits.",
            severity: "error",
          });
          return issues;
        }
        return issues;
      },
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    if (!retryResult.ok) {
      return {
        mode: "invalid_patch_format",
        filePath: input.filePath,
        summary: "Large-file patch format validation failed.",
        warnings: [
          `[invalid_patch_format] Model did not return a parseable patch after ${retryResult.attempts} attempt(s). ${retryResult.reason}`,
        ],
      };
    }

    const rawText = retryResult.value;
    if (rawText.trim() === "NO_VALID_PATCH") {
      return {
        mode: "invalid_patch_format",
        filePath: input.filePath,
        summary: "Model reported NO_VALID_PATCH.",
        warnings: [
          "[invalid_patch_format] Model returned NO_VALID_PATCH — no structured patch was produced.",
        ],
      };
    }

    return {
      mode: "patch",
      filePath: input.filePath,
      patchText: rawText,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    };
  }

  const retryResult = await withSelfHealingRetry({
    maxAttempts: 3,
    prompt,
    execute: async (currentPrompt: string) => {
      const response = await client.responses.create({
        model,
        input: currentPrompt,
      });
      const rawText = response.output_text ?? "";
      const jsonText = extractJson(rawText);
      return JSON.parse(stripJsonFences(jsonText)) as unknown;
    },
    validate: (result: unknown) => {
      const issues: Array<{
        code: string;
        message: string;
        severity: "error" | "warning";
      }> = [];

      const parseResult = fullContentSchema.safeParse(result);
      if (!parseResult.success) {
        parseResult.error.errors.forEach((err) => {
          issues.push({
            code: "SCHEMA_VALIDATION_FAILED",
            message: `${err.path.join(".")}: ${err.message}`,
            severity: "error",
          });
        });
        return issues;
      }

      const validated = parseResult.data;

      if (!validated.fullContent.trim()) {
        issues.push({
          code: "EMPTY_FULL_CONTENT",
          message: "fullContent field is empty.",
          severity: "error",
        });
      }

      if (!validated.filePath.trim()) {
        issues.push({
          code: "MISSING_FILE_PATH",
          message: "filePath field is empty.",
          severity: "error",
        });
      }

      return issues;
    },
    buildFeedbackPrompt: buildDefaultFeedbackPrompt,
  });

  if (!retryResult.ok) {
    throw new Error(
      `planFullPatchWithLlm failed after ${retryResult.attempts} attempt(s): ${retryResult.reason}`
    );
  }

  const validated = fullContentSchema.parse(retryResult.value);

  return {
    mode: "full_content",
    filePath: validated.filePath,
    fullContent: validated.fullContent,
    summary: validated.summary,
    warnings: validated.warnings,
  };
}
