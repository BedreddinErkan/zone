import { z } from "zod";
import { debugLog, errorLog } from "../utils/logger.js";
import {
  buildEmptyModelResponseDetailsLine,
  extractResponsesApiOutputText,
  formatOpenAiThrownErrorPayload,
  getModelName,
  logOpenAiResponseDebug,
} from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import {
  withSelfHealingRetry,
  buildDefaultFeedbackPrompt,
  type RetryFeedback,
} from "../core/withSelfHealingRetry.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import {
  buildFullPatchPrompt,
  type FullPatchOutputMode,
} from "../prompts/fullPatchPrompt.js";
import { extractSymbolContext } from "../ast/extractSymbolContext.js";
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
const FULL_CONTENT_MAX_LINE_COUNT = 150;

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

  const fileLineCount = input.fileContent.split(/\r?\n/).length;
  if (fileLineCount > FULL_CONTENT_MAX_LINE_COUNT) {
    return "find_replace_patch";
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

function countChar(text: string, char: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === char) n += 1;
  }
  return n;
}

function looksLikeTruncatedFullContent(fullContent: string): {
  ok: boolean;
  reason?: string;
  braceDelta?: number;
  endingPreview?: string;
} {
  const raw = typeof fullContent === "string" ? fullContent : "";
  const trimmed = raw.trimEnd();
  if (!trimmed) return { ok: false, reason: "empty_full_content" };

  const openBraces = countChar(trimmed, "{");
  const closeBraces = countChar(trimmed, "}");
  const braceDelta = Math.abs(openBraces - closeBraces);
  if (braceDelta > 3) {
    return {
      ok: false,
      reason: "brace_imbalance",
      braceDelta,
      endingPreview: trimmed.slice(-20),
    };
  }

  // Heuristic: rewritten full file should end on a statement / block close.
  const endsOk =
    trimmed.endsWith("}") ||
    trimmed.endsWith("};") ||
    trimmed.endsWith("})") ||
    trimmed.endsWith("});") ||
    trimmed.endsWith("})]") ||
    /\}\s*\)\s*;?\s*$/.test(trimmed);

  if (!endsOk) {
    return {
      ok: false,
      reason: "suspicious_eof",
      endingPreview: trimmed.slice(-20),
    };
  }

  return { ok: true };
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
    "CRITICAL RULES:",
    "- REPLACE must contain EVERY line from FIND, plus your additions/changes.",
    "- You may ONLY omit a line from REPLACE if the task explicitly asks to DELETE that line.",
    "- If you are ADDING lines, FIND should be 1-3 lines (the anchor), REPLACE = FIND + new lines.",
    "- NEVER shrink REPLACE compared to FIND unless deletion is explicitly requested.",
    "- If unsure, make FIND smaller rather than risk omitting lines.",
    "",
    "If you output anything else, the response is INVALID.",
  ].join("\n");
}

const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;

function buildApplyPatchTool(): ChatCompletionTool {
  return {
    type: "function",
    function: {
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
    },
  };
}

function buildApplyPatchToolChoice(): ChatCompletionToolChoiceOption {
  return {
    type: "function",
    function: { name: APPLY_PATCH_TOOL_NAME },
  };
}

interface ChatToolCallShape {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function extractPatchFromToolCall(response: unknown): string | null {
  const choices = (response as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } } | null)
    ?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const toolCall = toolCalls.find((item) => {
    const t = item as ChatToolCallShape | null;
    return (
      !!t &&
      t.type === "function" &&
      t.function?.name === APPLY_PATCH_TOOL_NAME &&
      typeof t.function?.arguments === "string"
    );
  }) as ChatToolCallShape | undefined;

  if (!toolCall || typeof toolCall.function?.arguments !== "string") return null;

  try {
    const parsed = JSON.parse(toolCall.function.arguments) as { patch?: unknown };
    return typeof parsed.patch === "string" ? parsed.patch : null;
  } catch {
    return null;
  }
}

function buildFindReplaceFormatRetryPrompt(feedback: RetryFeedback): string {
  const needsHardPatchCorrection = feedback.issues.some(
    (issue) =>
      issue.code === "INVALID_PATCH_FORMAT" ||
      issue.code === "EMPTY_PATCH" ||
      issue.code === "NOOP_DETECTED"
  );
  const hadEmptyPatch = feedback.issues.some(
    (issue) => issue.code === "EMPTY_PATCH"
  );
  const hadNoop = feedback.issues.some((issue) => issue.code === "NOOP_DETECTED");

  if (needsHardPatchCorrection) {
    debugLog("[zone-patch-retry-attempt]", feedback.attempt);
    console.warn("[zone-patch-retry] invalid format, retrying...", {
      attempt: feedback.attempt,
    });
  }

  if (!needsHardPatchCorrection) {
    return buildDefaultFeedbackPrompt(feedback);
  }

  const hardCorrection = [
    ...(hadNoop
      ? [
          "Your previous response contained NO_CHANGE_NEEDED.",
          "",
          "DO NOT return NO_CHANGE_NEEDED.",
          "There IS a bug in this file.",
          "You MUST produce a minimal patch.",
          "",
          "FORCED PATCH STRATEGY:",
          "- Remove ANY suspicious or stray characters",
          "- Fix JSX structure if needed",
          "- Prefer the smallest possible change",
          "- You must output a patch",
          "",
        ]
      : []),
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
    "- The FIND block must contain only real, unique code — never comments, docstrings, or example/usage annotations.",
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
    "- If the target location is ambiguous, pick a unique surrounding code line as anchor instead (e.g., a function signature or unique call site).",
    "",
    "DO NOT:",
    "- summarize code",
    "- rewrite code",
    "- approximate code",
    "",
    "The FIND block MUST exist EXACTLY in the file.",
    "",
    "PATCH RULES:",
    "",
    "WARNING:",
    "If your REPLACE block has FEWER lines than your FIND block, you are DELETING code.",
    "Only do this if the task explicitly asks for deletion.",
    "For additions (comments, new functions, imports):",
    "  FIND = small anchor (1-3 lines)",
    "  REPLACE = same anchor + new lines inserted",
    "",
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
  lastAddedFunctions?: string[];
  plannerSuggestedFile?: string;
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
  onProgress?: (event:
    | { type: "patch_stream_delta"; filePath: string; delta: string; fallback?: boolean }
    | { type: "patch_stream_target"; filePath: string; targetSymbol: string }
  ) => void;
}): Promise<FullPatchResult> {
  const client = createLLMClient();
  const ctx = getRequestContext();
  const model = getModelName("high", client.provider, ctx?.modelOverride);
  let openAiTransportErrorDetails: string | null = null;
  let lastSuccessfulResponsesCreateResult: unknown = null;

  const funcNameMatch = input.task.match(
    /(?:in|the|fix|update|modify|refactor|change)\s+(?:the\s+)?(\w+)\s+(?:function|method)/i
  );
  const targetFuncName = funcNameMatch?.[1] ? String(funcNameMatch[1]).trim() : "";
  const symbolCtx =
    targetFuncName.length > 0
      ? extractSymbolContext(input.fileContent, targetFuncName, input.filePath, 5)
      : null;
  const astTargetInstruction =
    symbolCtx && targetFuncName
      ? [
          `Target function: ${targetFuncName} (lines ${symbolCtx.targetFunction.startLine}-${symbolCtx.targetFunction.endLine})`,
          "Only modify this function. Do not touch other parts of the file.",
          "Return FIND/REPLACE that targets only lines within this function.",
          "Note: the provided context may include a literal '...' placeholder for omitted code. Do NOT use that placeholder in FIND/REPLACE.",
        ].join("\n")
      : "";
  const fileContentForPrompt =
    symbolCtx && targetFuncName
      ? `${symbolCtx.fileHeader}\n...\n${symbolCtx.targetFunction.content}`
      : input.fileContent;
  const relatedContextForPrompt =
    symbolCtx && targetFuncName
      ? `${input.relatedContext}\n\nAST TARGETING\n${astTargetInstruction}\n\nSURROUNDING CONTEXT (read-only)\n${symbolCtx.surroundingContext}`
      : input.relatedContext;

  if (symbolCtx && targetFuncName) {
    debugLog("[zone-ast]", {
      file: input.filePath,
      targetFunc: targetFuncName,
      lines: `${symbolCtx.targetFunction.startLine}-${symbolCtx.targetFunction.endLine}`,
      contextSize: symbolCtx.targetFunction.content.length,
    });
  }

  // Best-effort: surface a target symbol to the UI (used for streaming header).
  if (typeof input.onProgress === "function") {
    const sym = targetFuncName || "";
    if (sym) {
      try {
        input.onProgress({
          type: "patch_stream_target",
          filePath: input.filePath,
          targetSymbol: sym,
        });
      } catch {}
    }
  }

  const contentForLineCount =
    (input.fullOriginalFileContent ?? input.fileContent) || "";
  const lineCount = contentForLineCount.split(/\r?\n/).length;
  const isSimpleTask = /comment|rename|add.*import|remove.*import|add.*log/i.test(
    input.task
  );

  let outputMode = selectFullPatchOutputMode({
    outputMode: input.outputMode,
    task: input.task,
    fileContent: fileContentForPrompt,
    relatedContext: relatedContextForPrompt,
  });

  if (symbolCtx && targetFuncName) {
    // Prefer surgical patches when we have a concrete symbol range.
    outputMode = "find_replace_patch";
  }

  if (lineCount > 150 && isSimpleTask) {
    outputMode = "find_replace_patch";
  }
  const lastAddedFns = Array.isArray(input.lastAddedFunctions)
    ? input.lastAddedFunctions
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => String(x).trim())
        .slice(0, 5)
    : [];
  const rawTask = String(input.task || "");
  const normalizedTask = rawTask.toLowerCase();
  const shouldClarifyRecentFunc =
    lastAddedFns.length > 0 &&
    [
      "function you just added",
      "the function you just added",
      "just added",
      "previous function",
      "the previous function",
      "the function i just added",
      "function i just added",
    ].some((phrase) => normalizedTask.includes(phrase));
  const clarifiedTask = shouldClarifyRecentFunc
    ? [
        "CONTEXT: The user is referring to the recently added function(s):",
        ...lastAddedFns.map((n) => `- ${n}`),
        "",
        `When the task says "the function you just added", it means: ${lastAddedFns[0]}`,
        "",
        rawTask,
      ].join("\n")
    : rawTask;

  const prompt = buildFullPatchPrompt({
    task: clarifiedTask,
    plannerSuggestedFile: input.plannerSuggestedFile,
    filePath: input.filePath,
    fileContent: fileContentForPrompt,
    repoSummary: input.repoSummary,
    relatedContext: relatedContextForPrompt,
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
    const strictSystemInstruction = [
      buildStrictPatchSystemInstruction(),
      ...(astTargetInstruction ? ["", "AST TARGETING (hard constraint)", astTargetInstruction] : []),
    ].join("\n");
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
        debugLog(
          "[zone-patch-request] sending strict patch system instruction",
          JSON.stringify({
            filePath: input.filePath,
            max_output_tokens: maxOutputTokens,
            temperature: 0,
            attempt: findReplaceAttemptIndex,
          })
        );

        const responseInput: ChatCompletionMessageParam[] = [
          {
            role: "system",
            content: strictSystemInstruction,
          },
          {
            role: "user",
            content: currentPrompt,
          },
        ];

        const callStartedAt = Date.now();
        debugLog(
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
          // Streaming primary: chat completions tool-call argument deltas.
          debugLog("[zone-stream-start]", { filePath: input.filePath });
          const controller = new AbortController();
          const timeout = setTimeout(() => {
            try { controller.abort(); } catch {}
          }, 120_000);
          const stream = await client.createChatCompletionStream({
            model,
            temperature: 0,
            max_tokens: maxOutputTokens,
            tools: [applyPatchTool],
            tool_choice: applyPatchToolChoice,
            messages: responseInput,
            stream: true,
          });

          let argsAccum = "";
          let toolCallId = "";
          let toolCallName = "";
          let textAccum = "";
          let lastPatchLen = 0;
          let sawAnyToolArgsEvent = false;
          const tryExtractPatchFromArgs = (raw: string): string | null => {
            const key = `"patch"`;
            const k = raw.indexOf(key);
            if (k < 0) return null;
            const colon = raw.indexOf(":", k + key.length);
            if (colon < 0) return null;
            const firstQuote = raw.indexOf('"', colon + 1);
            if (firstQuote < 0) return null;
            // parse JSON string value with escapes
            let i = firstQuote + 1;
            let out = "";
            while (i < raw.length) {
              const ch = raw[i];
              if (ch === "\\") {
                const nxt = raw[i + 1];
                if (nxt == null) return null;
                // handle common escapes
                if (nxt === "n") out += "\n";
                else if (nxt === "r") out += "\r";
                else if (nxt === "t") out += "\t";
                else if (nxt === '"') out += '"';
                else if (nxt === "\\") out += "\\";
                else out += nxt;
                i += 2;
                continue;
              }
              if (ch === '"') {
                return out;
              }
              out += ch;
              i += 1;
            }
            return null;
          };

          try {
            for await (const chunk of stream) {
              if (controller.signal.aborted) break;
              if (!chunk || typeof chunk !== "object") continue;
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;
              // Primary: tool-call arguments streaming
              const tcArr = (delta as { tool_calls?: unknown[] }).tool_calls;
              if (Array.isArray(tcArr) && tcArr.length > 0) {
                for (const tc of tcArr) {
                  const tcObj = tc as {
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  } | null;
                  if (!tcObj) continue;
                  if (typeof tcObj.id === "string" && tcObj.id) toolCallId = tcObj.id;
                  if (typeof tcObj.function?.name === "string" && tcObj.function.name) {
                    toolCallName = tcObj.function.name;
                  }
                  const argFrag = tcObj.function?.arguments;
                  if (typeof argFrag === "string" && argFrag.length > 0) {
                    sawAnyToolArgsEvent = true;
                    argsAccum += argFrag;
                    const patchText = tryExtractPatchFromArgs(argsAccum);
                    if (typeof patchText === "string" && patchText.length >= lastPatchLen) {
                      const deltaPiece = patchText.slice(lastPatchLen);
                      if (deltaPiece) {
                        debugLog("[zone-stream-delta]", { delta: deltaPiece.slice(0, 30) });
                        input.onProgress?.({
                          type: "patch_stream_delta",
                          filePath: input.filePath,
                          delta: deltaPiece,
                        });
                        lastPatchLen = patchText.length;
                      }
                    }
                  }
                }
                continue;
              }
              // Secondary: text content streaming (if tool-call isn't used by the model)
              const contentFrag = (delta as { content?: string }).content;
              if (typeof contentFrag === "string" && contentFrag.length > 0) {
                textAccum += contentFrag;
                debugLog("[zone-stream-delta]", { delta: contentFrag.slice(0, 30) });
                input.onProgress?.({
                  type: "patch_stream_delta",
                  filePath: input.filePath,
                  delta: contentFrag,
                });
              }
            }
          } finally {
            try { clearTimeout(timeout); } catch {}
          }

          // Synthesize a chat-completion-shaped response from accumulated stream state
          // so downstream extractors (extractPatchFromToolCall / extractResponsesApiOutputText)
          // see the same shape as a non-streaming result.
          response = {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: textAccum || null,
                  tool_calls: argsAccum
                    ? [
                        {
                          id: toolCallId || "stream",
                          type: "function",
                          function: {
                            name: toolCallName || APPLY_PATCH_TOOL_NAME,
                            arguments: argsAccum,
                          },
                        },
                      ]
                    : undefined,
                },
              },
            ],
          };

          // If the SDK didn't emit tool_call argument deltas (some providers/modes),
          // fall back to emitting the FINAL tool arguments as a single "delta" so the UI shows something.
          if (typeof input.onProgress === "function" && lastPatchLen === 0) {
            const toolPatch = extractPatchFromToolCall(response);
            if (typeof toolPatch === "string" && toolPatch.length > 0) {
                const buildPatchSnippet = (raw: string): string => {
                  const t = String(raw || "").replace(/\r\n/g, "\n");
                  const findIdx = t.lastIndexOf("\n--- FIND ---");
                  const repIdx = t.lastIndexOf("\n--- REPLACE ---");
                  if (repIdx < 0) return t;
                  const findStart = findIdx >= 0 ? findIdx + "\n--- FIND ---".length : -1;
                  const repStart = repIdx + "\n--- REPLACE ---".length;
                  const findBlock =
                    findStart >= 0 && findStart < repIdx
                      ? t.slice(findStart, repIdx).replace(/^\s*\n/, "").replace(/\s*$/, "")
                      : "";
                  let replaceBlock = t.slice(repStart).replace(/^\s*\n/, "");
                  // Cap output aggressively: show only changed region.
                  const findLines = findBlock ? findBlock.split("\n") : [];
                  const replaceLines = replaceBlock ? replaceBlock.split("\n") : [];
                  const before = findLines.slice(Math.max(0, findLines.length - 2));
                  const after = findLines.slice(0, Math.min(2, findLines.length));
                  const maxReplaceLines = 60;
                  const replaceCapped =
                    replaceLines.length > maxReplaceLines
                      ? [...replaceLines.slice(0, maxReplaceLines), "… (truncated)"]
                      : replaceLines;
                  // Rebuild a mini patch blob so FE can parse FIND/REPLACE.
                  const fileLine = t.split("\n").find((l) => l.startsWith("--- FILE:")) ?? "--- FILE: (unknown) ---";
                  return [
                    fileLine,
                    "--- FIND ---",
                    ...before,
                    ...(findLines.length > 4 ? ["…"] : []),
                    ...after,
                    "--- REPLACE ---",
                    ...replaceCapped,
                    "",
                  ].join("\n");
                };
                const snippet = buildPatchSnippet(toolPatch);
                debugLog("[zone-stream-delta]", {
                  filePath: input.filePath,
                  deltaLength: snippet.length,
                  preview: snippet.slice(0, 50),
                  fallback: true,
                  sawAnyToolArgsEvent,
                });
                try {
                  input.onProgress({
                    type: "patch_stream_delta",
                    filePath: input.filePath,
                    delta: snippet,
                    fallback: true,
                  });
                  lastPatchLen = snippet.length;
                } catch {}
              }
            }
        } catch (err) {
          const elapsedMs = Date.now() - callStartedAt;
          const p = formatOpenAiThrownErrorPayload(err);
          openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
          errorLog(
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
          debugLog("[zone-stream-fallback]", { error: err instanceof Error ? err.message : String(err) });
          // Fallback to non-streaming on any streaming failure.
          response = await client.createChatCompletion({
            model,
            temperature: 0,
            max_tokens: maxOutputTokens,
            tools: [applyPatchTool],
            tool_choice: applyPatchToolChoice,
            messages: responseInput,
          });
        }

        const elapsedMs = Date.now() - callStartedAt;
        openAiTransportErrorDetails = null;
        lastSuccessfulResponsesCreateResult = response;
        debugLog(
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

        debugLog("[zone-gpt-raw]", rawForAttempt.slice(0, 500));

        debugLog(
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
          debugLog(
            "[zone-full-patch-empty-response]",
            JSON.stringify(emptyLog)
          );
        }

        if (fromTool) {
          debugLog("[zone-patch-tool] tool call received");
          debugLog("[zone-patch-tool] patch length:", fromTool.length);
          return fromTool;
        }

        if (fromExtract) {
          console.warn(
            "[zone-patch-tool] No structured tool patch; using extracted response text for validation"
          );
          return fromExtract;
        }

        errorLog("[zone-patch-tool] No structured patch returned");
        return "";
      },
      validate: (raw: string) => {
        const issues: Array<{
          code: string;
          message: string;
          severity: "error" | "warning";
        }> = [];
        const parsed = parseDeveloperPatchText(raw);
        const patchCount =
          parsed && !parsed.noChangeNeeded
            ? (parsed.createContent !== undefined ? 1 : parsed.edits.length)
            : 0;
        debugLog("[zone-parse-result]", {
          patchCount,
          rawSnippet: String(raw || "").slice(0, 200),
        });
        if (!raw.trim()) {
          issues.push({
            code: "EMPTY_PATCH",
            message: "Model returned empty output.",
            severity: "error",
          });
          return issues;
        }
        if (raw.includes("NO_CHANGE_NEEDED")) {
          debugLog(
            "[zone-noop-detected]",
            JSON.stringify({
              filePath: input.filePath,
              attempt: findReplaceAttemptIndex,
              rawPreview: raw.slice(0, 120),
            })
          );
          if (findReplaceAttemptIndex < 2) {
            debugLog(
              "[zone-noop-retry]",
              JSON.stringify({ filePath: input.filePath, attempt: findReplaceAttemptIndex })
            );
            issues.push({
              code: "NOOP_DETECTED",
              message:
                "Model returned NO_CHANGE_NEEDED, but a patch is required. Retry with forced patch instructions.",
              severity: "error",
            });
            return issues;
          }
          debugLog(
            "[zone-noop-final]",
            JSON.stringify({ filePath: input.filePath, attempt: findReplaceAttemptIndex })
          );
          // After a forced retry, accept NO_CHANGE_NEEDED so the caller can treat it as no-op.
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
        if (!parsed) {
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
      errorLog(
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
        task: input.task,
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
    debugLog("[zone-patch-debug] raw model output:", rawText.slice(0, 500));
    debugLog("[zone-patch-debug-full]", rawText.slice(0, 500));
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
        task: input.task,
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
  const originalLineCount = lineCount;
  let maxOutputTokensFull: number | undefined;
  if (originalLineCount > 200) maxOutputTokensFull = 6000;
  else if (originalLineCount > 100) maxOutputTokensFull = 4000;

  const retryResult = await withSelfHealingRetry({
    maxAttempts: 3,
    prompt,
    execute: async (currentPrompt: string) => {
      fullContentAttemptIndex += 1;
      const callStartedAt = Date.now();
      debugLog(
        "[zone-openai-call-start]",
        JSON.stringify({
          filePath: input.filePath,
          attempt: fullContentAttemptIndex,
          model,
          max_output_tokens: maxOutputTokensFull ?? null,
        })
      );
      let response: unknown;
      let promptWithAntiTruncation =
        fullContentAttemptIndex >= 2
          ? [
              currentPrompt,
              "",
              "CRITICAL: You MUST include the COMPLETE file content. Do not truncate.",
              `The file has ${originalLineCount} lines.`,
              "Your response must have approximately the same number of lines.",
            ].join("\n")
          : currentPrompt;
      try {
        // Streaming primary for full_content_json mode: stream content deltas directly.
        debugLog("[zone-stream-start]", { filePath: input.filePath });
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          try { controller.abort(); } catch {}
        }, 120_000);
        const stream = await client.createChatCompletionStream({
          model,
          messages: [{ role: "user", content: promptWithAntiTruncation }],
          stream: true,
          ...(maxOutputTokensFull != null
            ? { max_tokens: maxOutputTokensFull }
            : {}),
        });
        let rawAccum = "";
        let lastFullContentLen = 0;
        const tryExtractJsonStringValuePartial = (raw: string, key: string): string => {
          const k = raw.indexOf(`"${key}"`);
          if (k < 0) return "";
          const colon = raw.indexOf(":", k + key.length + 2);
          if (colon < 0) return "";
          const firstQuote = raw.indexOf('"', colon + 1);
          if (firstQuote < 0) return "";
          let i = firstQuote + 1;
          let out = "";
          while (i < raw.length) {
            const ch = raw[i];
            if (ch === "\\") {
              const nxt = raw[i + 1];
              if (nxt == null) return out;
              if (nxt === "n") out += "\n";
              else if (nxt === "r") out += "\r";
              else if (nxt === "t") out += "\t";
              else if (nxt === '"') out += '"';
              else if (nxt === "\\") out += "\\";
              else out += nxt;
              i += 2;
              continue;
            }
            if (ch === '"') return out;
            out += ch;
            i += 1;
          }
          return out;
        };
        try {
          for await (const chunk of stream) {
            if (controller.signal.aborted) break;
            if (!chunk || typeof chunk !== "object") continue;
            const contentFrag = chunk.choices?.[0]?.delta?.content;
            if (typeof contentFrag === "string" && contentFrag.length > 0) {
              rawAccum += contentFrag;
              debugLog("[zone-stream-delta]", { delta: contentFrag.slice(0, 30) });
              try {
                // Emit only fullContent deltas (skip JSON wrapper) to avoid raw JSON in UI.
                const fullContentSnap = tryExtractJsonStringValuePartial(rawAccum, "fullContent");
                if (fullContentSnap.length >= lastFullContentLen) {
                  const d = fullContentSnap.slice(lastFullContentLen);
                  if (d) {
                    input.onProgress?.({
                      type: "patch_stream_delta",
                      filePath: input.filePath,
                      delta: d,
                    });
                    lastFullContentLen = fullContentSnap.length;
                  }
                }
              } catch {}
            }
          }
        } finally {
          try { clearTimeout(timeout); } catch {}
        }
        // Synthesize a chat-completion-shaped response from accumulated stream content
        // so downstream code can read choices[0].message.content uniformly.
        response = {
          choices: [
            {
              message: {
                role: "assistant",
                content: rawAccum,
              },
            },
          ],
        };
      } catch (err) {
        const elapsedMs = Date.now() - callStartedAt;
        const p = formatOpenAiThrownErrorPayload(err);
        openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
        errorLog(
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
        debugLog("[zone-stream-fallback]", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fallback to non-streaming on any streaming failure.
        response = await client.createChatCompletion({
          model,
          messages: [{ role: "user", content: promptWithAntiTruncation }],
          ...(maxOutputTokensFull != null
            ? { max_tokens: maxOutputTokensFull }
            : {}),
        });
      }
      const elapsedMs = Date.now() - callStartedAt;
      openAiTransportErrorDetails = null;
      lastSuccessfulResponsesCreateResult = response;
      debugLog(
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
      debugLog("[zone-full-content-debug]", rawText?.slice(0, 500));
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
      } else {
        const truncationCheck = looksLikeTruncatedFullContent(validated.fullContent);
        if (!truncationCheck.ok) {
          issues.push({
            code: "TRUNCATED_FULL_CONTENT",
            message: `fullContent looks truncated (${truncationCheck.reason ?? "unknown"}).`,
            severity: "error",
          });
        }
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
