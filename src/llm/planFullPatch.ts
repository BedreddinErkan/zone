import { z } from "zod";
import {
  buildEmptyModelResponseDetailsLine,
  createOpenAIClient,
  extractResponsesApiOutputText,
  formatOpenAiThrownErrorPayload,
  formatResponsesTextExtractionFailure,
  getModelName,
  logOpenAiResponseDebug,
} from "./openaiClient.js";
import {
  withSelfHealingRetry,
  buildDefaultFeedbackPrompt,
  type RetryFeedback,
} from "../core/withSelfHealingRetry.js";
import type { ResponseInput } from "openai/resources/responses/responses";
import type {
  Tool,
  ToolChoiceFunction,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import {
  buildFullPatchPrompt,
  type FullPatchOutputMode,
} from "../prompts/fullPatchPrompt.js";
import {
  formatExecutionPlanForPrompt,
  type ExecutionPlan,
} from "./executionPlan.js";
import { parseDeveloperPatchText } from "../core/developerPatchParse.js";
import { tryRecoverDeveloperPatchFromModelOutput } from "../core/patchConversion.js";

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
      /** True when patch text was recovered from non-strict model output (safe single-hunk rules). */
      patchRecovered?: boolean;
    }
  | {
      mode: "invalid_patch_format";
      filePath: string;
      summary: string;
      warnings: string[];
      /** Length of the last non-empty raw model output used for recovery (0 if none). */
      lastNonEmptyRawLength?: number;
    }
  | {
      mode: "empty_model_response";
      filePath: string;
      summary: string;
      warnings: string[];
      normalizedFailureReason: "empty_model_response";
      /** JSON: extractionReason, responseStatus, contentTypes, outputLength, outputTextLength */
      emptyModelDetails: string;
    }
  | {
      mode: "openai_call_error";
      filePath: string;
      summary: string;
      warnings: string[];
      normalizedFailureReason: "openai_call_error";
      /** JSON from formatOpenAiThrownErrorPayload + elapsedMs */
      openAiCallDetails: string;
    };

function isValidPatchResponse(text: string): boolean {
  const t = text.trim();
  if (t === "NO_CHANGE_NEEDED") return true;
  return (
    t.includes("--- FILE:") &&
    t.includes("--- FIND ---") &&
    t.includes("--- REPLACE ---")
  );
}

function buildStrictPatchSystemInstruction(): string {
  return [
    "You are a code patch generator.",
    "",
    "You MUST output ONLY a valid patch.",
    "",
    "Allowed outputs:",
    "1) A valid patch using:",
    "--- FILE:",
    "--- FIND ---",
    "--- REPLACE ---",
    "",
    "2) OR exactly:",
    "NO_CHANGE_NEEDED",
    "",
    "You are FORBIDDEN from:",
    "- explanations",
    "- natural language",
    "- descriptions",
    "- markdown",
    "- comments",
    "",
    "If you output anything else, the response is INVALID.",
  ].join("\n");
}

const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;

function buildApplyPatchTool(): Tool {
  return {
    type: "function",
    name: APPLY_PATCH_TOOL_NAME,
    strict: true,
    description:
      "Return a patch in --- FILE / --- FIND --- / --- REPLACE --- format OR exactly NO_CHANGE_NEEDED.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Patch in --- FILE / FIND / REPLACE format OR exactly NO_CHANGE_NEEDED",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    } as Record<string, unknown>,
  };
}

function buildApplyPatchToolChoice(): ToolChoiceFunction {
  return {
    type: "function",
    name: APPLY_PATCH_TOOL_NAME,
  };
}

function extractPatchFromToolCall(response: unknown): string | null {
  const outputItems = (response as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(outputItems) || outputItems.length === 0) {
    return null;
  }

  const toolCall = outputItems.find((item) => {
    const t = item as Partial<ResponseFunctionToolCall> | null;
    return (
      !!t &&
      t.type === "function_call" &&
      t.name === APPLY_PATCH_TOOL_NAME &&
      typeof t.arguments === "string"
    );
  }) as ResponseFunctionToolCall | undefined;

  if (!toolCall) return null;

  try {
    const parsed = JSON.parse(toolCall.arguments) as { patch?: unknown };
    return typeof parsed.patch === "string" ? parsed.patch : null;
  } catch {
    return null;
  }
}

function buildFindReplaceFormatRetryPrompt(feedback: RetryFeedback): string {
  const needsHardPatchCorrection = feedback.issues.some(
    (issue) =>
      issue.code === "INVALID_PATCH_FORMAT" || issue.code === "EMPTY_PATCH"
  );
  const hadEmptyPatch = feedback.issues.some(
    (issue) => issue.code === "EMPTY_PATCH"
  );

  if (needsHardPatchCorrection) {
    console.log("[zone-patch-retry-attempt]", feedback.attempt);
    console.warn("[zone-patch-retry] invalid format, retrying...", {
      attempt: feedback.attempt,
    });
  }

  if (!needsHardPatchCorrection) {
    return buildDefaultFeedbackPrompt(feedback);
  }

  const hardCorrection = [
    ...(hadEmptyPatch
      ? [
          "Your previous response contained NO usable patch text (empty output or missing tool payload).",
          "",
          "Return only a find/replace patch. No explanation.",
          "",
        ]
      : []),
    "Your previous response was INVALID.",
    "",
    "You MUST return ONLY a patch.",
    "",
    "VALID FORMAT (EXAMPLE)",
    "",
    "--- FILE: client/src/pages/app/PatientsPage.jsx ---",
    "--- FIND ---",
    "const handleSubmit = (e) => {",
    "  e.preventDefault();",
    "  submitForm();",
    "}",
    "--- REPLACE ---",
    "const handleSubmit = (e) => {",
    "  e.preventDefault();",
    "",
    "  if (!fullName || fullName.trim() === \"\") {",
    "    setError(\"Full name is required\");",
    "    return;",
    "  }",
    "",
    "  if (email && !email.includes(\"@\")) {",
    "    setError(\"Invalid email format\");",
    "    return;",
    "  }",
    "",
    "  submitForm();",
    "}",
    "",
    "RULES",
    "",
    "- DO NOT explain anything",
    "- DO NOT describe changes",
    "- DO NOT write plain text",
    "- DO NOT use markdown (no ```)",
    "",
    "ONLY OUTPUT:",
    "",
    "- A valid patch",
    "OR",
    "- NO_CHANGE_NEEDED",
    "",
    "Fix your response now.",
  ].join("\n");

  return `${hardCorrection}\n\n${feedback.originalPrompt}`;
}

function buildFindReplaceStrictContract(filePath: string): string {
  return [
    "You are a code patch generator.",
    "",
    "You MUST return ONLY a patch in the following format:",
    "",
    `--- FILE: ${filePath} ---`,
    "--- FIND ---",
    "code",
    "--- REPLACE ---",
    "code",
    "",
    "CRITICAL REQUIREMENT:",
    "- The FIND block MUST match EXACT code from the file.",
    "- DO NOT invent or approximate code.",
    "- DO NOT summarize code.",
    "- COPY the exact lines from the file.",
    "- If the FIND block does not exist exactly, the patch is INVALID.",
    "",
    "FIND SELECTION STRATEGY:",
    "- You MUST locate the existing submit handler in the file.",
    "- Identify the function that handles form submission (e.g. handleSubmit).",
    "- COPY EXACT lines from that function.",
    "- Use those lines as the FIND block.",
    "",
    "DO NOT:",
    "- summarize code",
    "- rewrite code",
    "- approximate code",
    "",
    "The FIND block MUST exist EXACTLY in the file.",
    "",
    "PATCH RULES:",
    "- Modify ONLY the existing submit handler.",
    "- DO NOT rewrite the component.",
    "- DO NOT add new components.",
    "- DO NOT restructure JSX.",
    "- ONLY insert validation inside existing logic.",
    "",
    "IMPORTANT:",
    "- If a valid target file exists (it does in this case), you MUST produce a patch.",
    "- DO NOT return NO_CHANGE_NEEDED.",
    "",
    "PATCH STRATEGY:",
    "- Keep FIND block small (only the submit handler).",
    "- Insert validation logic inside it.",
    "- Do NOT rewrite the entire function.",
    "- Do NOT modify unrelated JSX.",
    "",
    "IMPORTANT:",
    "- If you cannot find the exact code to modify:",
    "  - DO NOT return NO_CHANGE_NEEDED",
    "  - Instead return EXACTLY: INVALID_PATCH_FORMAT",
    "",
    "If you cannot generate a valid patch, return EXACTLY:",
    "",
    "NO_CHANGE_NEEDED",
    "",
    "DO NOT return explanations.",
    "DO NOT return plain text.",
    "DO NOT describe changes.",
    "ONLY return a patch.",
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
  /** Full on-disk file used for safe recovery (substring must match once). Defaults to fileContent when omitted. */
  fullOriginalFileContent?: string;
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
  let openAiTransportErrorDetails: string | null = null;
  let lastSuccessfulResponsesCreateResult: unknown = null;
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
    const strictHeader = [
      "IMPORTANT:",
      "DO NOT describe the change.",
      "DO NOT explain the change.",
      "ONLY output the patch.",
    ].join("\n");
    const findReplacePrompt = `${strictHeader}\n\n${prompt.trim()}\n\n${buildFindReplaceStrictContract(
      input.filePath
    )}`;
    const strictSystemInstruction = buildStrictPatchSystemInstruction();
    const applyPatchTool = buildApplyPatchTool();
    const applyPatchToolChoice = buildApplyPatchToolChoice();

    let lastRawPatchResponse = "";
    let findReplaceAttemptIndex = 0;
    let lastEmptyModelDetailsLine: string | null = null;

    const resolveEmptyModelDetailsLine = (): string =>
      lastEmptyModelDetailsLine ??
      buildEmptyModelResponseDetailsLine({
        response: lastSuccessfulResponsesCreateResult,
        extraction: { ok: false, reason: "no_nonempty_raw_recorded_in_execute" },
        linearReasonWhenExtractionOk: "no_raw_output",
      });

    const retryResult = await withSelfHealingRetry({
      maxAttempts: 3,
      prompt: findReplacePrompt,
      execute: async (currentPrompt: string) => {
        findReplaceAttemptIndex += 1;
        const maxOutputTokens =
          [2000, 4096, 8192][Math.min(findReplaceAttemptIndex - 1, 2)] ?? 8192;
        console.log(
          "[zone-patch-request] sending strict patch system instruction",
          JSON.stringify({
            filePath: input.filePath,
            max_output_tokens: maxOutputTokens,
            temperature: 0,
            attempt: findReplaceAttemptIndex,
          })
        );

        const responseInput: ResponseInput = [
          {
            role: "system",
            type: "message",
            content: strictSystemInstruction,
          },
          {
            role: "user",
            type: "message",
            content: currentPrompt,
          },
        ];

        const callStartedAt = Date.now();
        console.log(
          "[zone-openai-call-start]",
          JSON.stringify({
            filePath: input.filePath,
            attempt: findReplaceAttemptIndex,
            model,
            max_output_tokens: maxOutputTokens,
          })
        );

        let response: unknown;
        try {
          response = await client.responses.create({
            model,
            temperature: 0,
            max_output_tokens: maxOutputTokens,
            tools: [applyPatchTool],
            tool_choice: applyPatchToolChoice,
            input: responseInput,
          });
        } catch (err) {
          const elapsedMs = Date.now() - callStartedAt;
          const p = formatOpenAiThrownErrorPayload(err);
          openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
          console.log(
            "[zone-openai-call-error]",
            JSON.stringify({
              filePath: input.filePath,
              attempt: findReplaceAttemptIndex,
              elapsedMs,
              name: p.name,
              message: p.message,
              status: p.status,
              code: p.code,
              type: p.type,
            })
          );
          throw err;
        }

        const elapsedMs = Date.now() - callStartedAt;
        openAiTransportErrorDetails = null;
        lastSuccessfulResponsesCreateResult = response;
        console.log(
          "[zone-openai-call-success]",
          JSON.stringify({
            filePath: input.filePath,
            attempt: findReplaceAttemptIndex,
            elapsedMs,
            responseKeys:
              response && typeof response === "object"
                ? Object.keys(response as object)
                : [],
          })
        );

        logOpenAiResponseDebug(response, {
          filePath: input.filePath,
          attempt: findReplaceAttemptIndex,
        });

        const extraction = extractResponsesApiOutputText(response);
        const toolPatch = extractPatchFromToolCall(response);
        const fromTool = toolPatch != null ? String(toolPatch).trim() : "";
        const fromExtract = extraction.ok ? extraction.text.trim() : "";
        const rawForAttempt = fromTool || fromExtract;

        console.log(
          "[zone-patch-raw-response-debug]",
          JSON.stringify({
            filePath: input.filePath,
            attempt: findReplaceAttemptIndex,
            rawLength: rawForAttempt.length,
            rawPreview: rawForAttempt.slice(0, 240),
          })
        );

        if (rawForAttempt.length > 0) {
          lastRawPatchResponse = rawForAttempt;
        } else {
          const detailsLine = buildEmptyModelResponseDetailsLine({
            response,
            extraction,
            linearReasonWhenExtractionOk: "tool_and_extractable_text_empty",
          });
          lastEmptyModelDetailsLine = detailsLine;
          let emptyLog: Record<string, unknown>;
          try {
            emptyLog = {
              attempt: findReplaceAttemptIndex,
              ...JSON.parse(detailsLine),
            };
          } catch {
            emptyLog = {
              attempt: findReplaceAttemptIndex,
              detailsLine,
            };
          }
          console.log(
            "[zone-full-patch-empty-response]",
            JSON.stringify(emptyLog)
          );
        }

        if (fromTool) {
          console.log("[zone-patch-tool] tool call received");
          console.log("[zone-patch-tool] patch length:", fromTool.length);
          return fromTool;
        }

        if (fromExtract) {
          console.warn(
            "[zone-patch-tool] No structured tool patch; using extracted response text for validation"
          );
          return fromExtract;
        }

        console.error("[zone-patch-tool] No structured patch returned");
        return "";
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
        if (raw.trim() === "NO_CHANGE_NEEDED") {
          return issues;
        }
        if (!isValidPatchResponse(raw)) {
          issues.push({
            code: "INVALID_PATCH_FORMAT",
            message:
              "[invalid_patch_format] Model did not return a valid patch structure",
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
      buildFeedbackPrompt: buildFindReplaceFormatRetryPrompt,
    });

    const originalForRecovery =
      input.fullOriginalFileContent ?? input.fileContent;

    if (!retryResult.ok) {
      console.error(
        "[zone-patch] model failed to produce valid patch after retries"
      );
      if (openAiTransportErrorDetails !== null) {
        return {
          mode: "openai_call_error",
          filePath: input.filePath,
          summary: "OpenAI API call failed during large-file patch generation.",
          warnings: [`[openai_call_error] ${openAiTransportErrorDetails}`],
          normalizedFailureReason: "openai_call_error",
          openAiCallDetails: openAiTransportErrorDetails,
        };
      }
      const rawAttempt =
        lastRawPatchResponse ||
        (typeof retryResult.lastValue === "string" ? retryResult.lastValue : "");
      if (rawAttempt.length === 0) {
        const emptyDetails = resolveEmptyModelDetailsLine();
        return {
          mode: "empty_model_response",
          filePath: input.filePath,
          summary: "Large-file patch: model returned no usable output text.",
          warnings: [`[empty_model_response] ${emptyDetails}`],
          normalizedFailureReason: "empty_model_response",
          emptyModelDetails: emptyDetails,
        };
      }
      const recovered = tryRecoverDeveloperPatchFromModelOutput({
        requestedFilePath: input.filePath,
        originalFileContent: originalForRecovery,
        rawModelText: rawAttempt,
      });
      if (recovered.ok) {
        return {
          mode: "patch",
          filePath: input.filePath,
          patchText: recovered.strictPatchText,
          summary: "Large-file targeted patch generated (recovered from non-strict model output).",
          warnings: [],
          patchRecovered: true,
        };
      }
      return {
        mode: "invalid_patch_format",
        filePath: input.filePath,
        summary: "Large-file patch format validation failed.",
        warnings: ["[invalid_patch_format] Model failed after retries"],
        lastNonEmptyRawLength: rawAttempt.length,
      };
    }

    const rawText = retryResult.value;
    console.log("[zone-patch-debug] raw model output:", rawText.slice(0, 500));
    console.log("[zone-patch-debug-full]", rawText.slice(0, 500));
    if (!isValidPatchResponse(rawText)) {
      const recoveredRaw = (lastRawPatchResponse || rawText).trim();
      if (recoveredRaw.length === 0) {
        const emptyDetails = resolveEmptyModelDetailsLine();
        return {
          mode: "empty_model_response",
          filePath: input.filePath,
          summary: "Large-file patch: model returned no usable output text.",
          warnings: [`[empty_model_response] ${emptyDetails}`],
          normalizedFailureReason: "empty_model_response",
          emptyModelDetails: emptyDetails,
        };
      }
      const recovered = tryRecoverDeveloperPatchFromModelOutput({
        requestedFilePath: input.filePath,
        originalFileContent: originalForRecovery,
        rawModelText: lastRawPatchResponse || rawText,
      });
      if (recovered.ok) {
        return {
          mode: "patch",
          filePath: input.filePath,
          patchText: recovered.strictPatchText,
          summary: "Large-file targeted patch generated (recovered from non-strict model output).",
          warnings: [],
          patchRecovered: true,
        };
      }
      const rawForRecoveryMeta = lastRawPatchResponse || rawText;
      return {
        mode: "invalid_patch_format",
        filePath: input.filePath,
        summary: "Large-file patch missing required structure.",
        warnings: ["[invalid_patch_format] Model failed after retries"],
        lastNonEmptyRawLength: rawForRecoveryMeta.length,
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

  let fullContentAttemptIndex = 0;
  const retryResult = await withSelfHealingRetry({
    maxAttempts: 3,
    prompt,
    execute: async (currentPrompt: string) => {
      fullContentAttemptIndex += 1;
      const callStartedAt = Date.now();
      console.log(
        "[zone-openai-call-start]",
        JSON.stringify({
          filePath: input.filePath,
          attempt: fullContentAttemptIndex,
          model,
          max_output_tokens: null,
        })
      );
      let response: unknown;
      try {
        response = await client.responses.create({
          model,
          input: currentPrompt,
        });
      } catch (err) {
        const elapsedMs = Date.now() - callStartedAt;
        const p = formatOpenAiThrownErrorPayload(err);
        openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
        console.log(
          "[zone-openai-call-error]",
          JSON.stringify({
            filePath: input.filePath,
            attempt: fullContentAttemptIndex,
            elapsedMs,
            name: p.name,
            message: p.message,
            status: p.status,
            code: p.code,
            type: p.type,
          })
        );
        throw err;
      }
      const elapsedMs = Date.now() - callStartedAt;
      openAiTransportErrorDetails = null;
      lastSuccessfulResponsesCreateResult = response;
      console.log(
        "[zone-openai-call-success]",
        JSON.stringify({
          filePath: input.filePath,
          attempt: fullContentAttemptIndex,
          elapsedMs,
          responseKeys:
            response && typeof response === "object"
              ? Object.keys(response as object)
              : [],
        })
      );
      logOpenAiResponseDebug(response, {
        filePath: input.filePath,
        attempt: fullContentAttemptIndex,
        mode: "full_content_json",
      });
      const extraction = extractResponsesApiOutputText(response);
      const r = response as { output_text?: string };
      const rawText = extraction.ok
        ? extraction.text
        : (r.output_text ?? "");
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
    if (openAiTransportErrorDetails !== null) {
      throw new Error(
        `planFullPatchWithLlm: openai_call_error after ${retryResult.attempts} attempt(s): ${openAiTransportErrorDetails}`
      );
    }
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
