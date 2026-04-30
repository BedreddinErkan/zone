"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planFullPatchWithLlm = planFullPatchWithLlm;
const zod_1 = require("zod");
const openaiClient_js_1 = require("./openaiClient.js");
const withSelfHealingRetry_js_1 = require("../core/withSelfHealingRetry.js");
const fullPatchPrompt_js_1 = require("../prompts/fullPatchPrompt.js");
const extractSymbolContext_js_1 = require("../ast/extractSymbolContext.js");
const executionPlan_js_1 = require("./executionPlan.js");
const developerPatchParse_js_1 = require("../core/developerPatchParse.js");
const patchConversion_js_1 = require("../core/patchConversion.js");
const fullContentSchema = zod_1.z.object({
    filePath: zod_1.z.string(),
    fullContent: zod_1.z.string(),
    summary: zod_1.z.string(),
    warnings: zod_1.z.array(zod_1.z.string()),
});
const LARGE_FILE_PATCH_THRESHOLD = 8000;
const FULL_CONTENT_MAX_LINE_COUNT = 150;
function isConstrainedLocalizedPatchTask(task) {
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
function selectFullPatchOutputMode(input) {
    if (input.outputMode) {
        return input.outputMode;
    }
    const fileLineCount = input.fileContent.split(/\r?\n/).length;
    if (fileLineCount > FULL_CONTENT_MAX_LINE_COUNT) {
        return "find_replace_patch";
    }
    const hasContextWindow = input.relatedContext.includes("// CONTEXT WINDOW:");
    const shouldPreferFullContent = hasContextWindow &&
        input.fileContent.length < LARGE_FILE_PATCH_THRESHOLD &&
        isConstrainedLocalizedPatchTask(input.task);
    if (shouldPreferFullContent) {
        return "full_content";
    }
    return input.fileContent.length < LARGE_FILE_PATCH_THRESHOLD
        ? "full_content"
        : "find_replace_patch";
}
function countChar(text, char) {
    if (!text)
        return 0;
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === char)
            n += 1;
    }
    return n;
}
function looksLikeTruncatedFullContent(fullContent) {
    const raw = typeof fullContent === "string" ? fullContent : "";
    const trimmed = raw.trimEnd();
    if (!trimmed)
        return { ok: false, reason: "empty_full_content" };
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
    const endsOk = trimmed.endsWith("}") ||
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
function isValidPatchResponse(text) {
    const t = text.trim();
    if (t === "NO_CHANGE_NEEDED")
        return true;
    return (t.includes("--- FILE:") &&
        t.includes("--- FIND ---") &&
        t.includes("--- REPLACE ---"));
}
function buildStrictPatchSystemInstruction() {
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
const APPLY_PATCH_TOOL_NAME = "apply_patch";
function buildApplyPatchTool() {
    return {
        type: "function",
        name: APPLY_PATCH_TOOL_NAME,
        strict: true,
        description: "Return a patch in --- FILE / --- FIND --- / --- REPLACE --- format OR exactly NO_CHANGE_NEEDED.",
        parameters: {
            type: "object",
            properties: {
                patch: {
                    type: "string",
                    description: "Patch in --- FILE / FIND / REPLACE format OR exactly NO_CHANGE_NEEDED",
                },
            },
            required: ["patch"],
            additionalProperties: false,
        },
    };
}
function buildApplyPatchToolChoice() {
    return {
        type: "function",
        name: APPLY_PATCH_TOOL_NAME,
    };
}
function extractPatchFromToolCall(response) {
    const outputItems = response?.output;
    if (!Array.isArray(outputItems) || outputItems.length === 0) {
        return null;
    }
    const toolCall = outputItems.find((item) => {
        const t = item;
        return (!!t &&
            t.type === "function_call" &&
            t.name === APPLY_PATCH_TOOL_NAME &&
            typeof t.arguments === "string");
    });
    if (!toolCall)
        return null;
    try {
        const parsed = JSON.parse(toolCall.arguments);
        return typeof parsed.patch === "string" ? parsed.patch : null;
    }
    catch {
        return null;
    }
}
function buildFindReplaceFormatRetryPrompt(feedback) {
    const needsHardPatchCorrection = feedback.issues.some((issue) => issue.code === "INVALID_PATCH_FORMAT" ||
        issue.code === "EMPTY_PATCH" ||
        issue.code === "NOOP_DETECTED");
    const hadEmptyPatch = feedback.issues.some((issue) => issue.code === "EMPTY_PATCH");
    const hadNoop = feedback.issues.some((issue) => issue.code === "NOOP_DETECTED");
    if (needsHardPatchCorrection) {
        console.log("[zone-patch-retry-attempt]", feedback.attempt);
        console.warn("[zone-patch-retry] invalid format, retrying...", {
            attempt: feedback.attempt,
        });
    }
    if (!needsHardPatchCorrection) {
        return (0, withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt)(feedback);
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
function buildFindReplaceStrictContract(filePath) {
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
function extractJson(rawText) {
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
function stripJsonFences(raw) {
    return raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
}
async function planFullPatchWithLlm(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)("high");
    let openAiTransportErrorDetails = null;
    let lastSuccessfulResponsesCreateResult = null;
    const funcNameMatch = input.task.match(/(?:in|the|fix|update|modify|refactor|change)\s+(?:the\s+)?(\w+)\s+(?:function|method)/i);
    const targetFuncName = funcNameMatch?.[1] ? String(funcNameMatch[1]).trim() : "";
    const symbolCtx = targetFuncName.length > 0
        ? (0, extractSymbolContext_js_1.extractSymbolContext)(input.fileContent, targetFuncName, input.filePath, 5)
        : null;
    const astTargetInstruction = symbolCtx && targetFuncName
        ? [
            `Target function: ${targetFuncName} (lines ${symbolCtx.targetFunction.startLine}-${symbolCtx.targetFunction.endLine})`,
            "Only modify this function. Do not touch other parts of the file.",
            "Return FIND/REPLACE that targets only lines within this function.",
            "Note: the provided context may include a literal '...' placeholder for omitted code. Do NOT use that placeholder in FIND/REPLACE.",
        ].join("\n")
        : "";
    const fileContentForPrompt = symbolCtx && targetFuncName
        ? `${symbolCtx.fileHeader}\n...\n${symbolCtx.targetFunction.content}`
        : input.fileContent;
    const relatedContextForPrompt = symbolCtx && targetFuncName
        ? `${input.relatedContext}\n\nAST TARGETING\n${astTargetInstruction}\n\nSURROUNDING CONTEXT (read-only)\n${symbolCtx.surroundingContext}`
        : input.relatedContext;
    if (symbolCtx && targetFuncName) {
        console.log("[zone-ast]", {
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
            }
            catch { }
        }
    }
    const contentForLineCount = (input.fullOriginalFileContent ?? input.fileContent) || "";
    const lineCount = contentForLineCount.split(/\r?\n/).length;
    const isSimpleTask = /comment|rename|add.*import|remove.*import|add.*log/i.test(input.task);
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
    const shouldClarifyRecentFunc = lastAddedFns.length > 0 &&
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
    const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({
        task: clarifiedTask,
        plannerSuggestedFile: input.plannerSuggestedFile,
        filePath: input.filePath,
        fileContent: fileContentForPrompt,
        repoSummary: input.repoSummary,
        relatedContext: relatedContextForPrompt,
        taskIntent: input.taskIntent,
        normalizedTaskIntent: input.normalizedTaskIntent,
        outputMode,
        executionPlanContext: (0, executionPlan_js_1.formatExecutionPlanForPrompt)(input.executionPlan),
    });
    if (outputMode === "find_replace_patch") {
        const strictHeader = [
            "IMPORTANT:",
            "DO NOT describe the change.",
            "DO NOT explain the change.",
            "ONLY output the patch.",
        ].join("\n");
        const findReplacePrompt = `${strictHeader}\n\n${prompt.trim()}\n\n${buildFindReplaceStrictContract(input.filePath)}`;
        const strictSystemInstruction = [
            buildStrictPatchSystemInstruction(),
            ...(astTargetInstruction ? ["", "AST TARGETING (hard constraint)", astTargetInstruction] : []),
        ].join("\n");
        const applyPatchTool = buildApplyPatchTool();
        const applyPatchToolChoice = buildApplyPatchToolChoice();
        let lastRawPatchResponse = "";
        let findReplaceAttemptIndex = 0;
        let lastEmptyModelDetailsLine = null;
        const resolveEmptyModelDetailsLine = () => lastEmptyModelDetailsLine ??
            (0, openaiClient_js_1.buildEmptyModelResponseDetailsLine)({
                response: lastSuccessfulResponsesCreateResult,
                extraction: { ok: false, reason: "no_nonempty_raw_recorded_in_execute" },
                linearReasonWhenExtractionOk: "no_raw_output",
            });
        const retryResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            maxAttempts: 3,
            prompt: findReplacePrompt,
            execute: async (currentPrompt) => {
                findReplaceAttemptIndex += 1;
                const maxOutputTokens = [2000, 4096, 8192][Math.min(findReplaceAttemptIndex - 1, 2)] ?? 8192;
                console.log("[zone-patch-request] sending strict patch system instruction", JSON.stringify({
                    filePath: input.filePath,
                    max_output_tokens: maxOutputTokens,
                    temperature: 0,
                    attempt: findReplaceAttemptIndex,
                }));
                const responseInput = [
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
                console.log("[zone-openai-call-start]", JSON.stringify({
                    filePath: input.filePath,
                    attempt: findReplaceAttemptIndex,
                    model,
                    max_output_tokens: maxOutputTokens,
                }));
                let response;
                try {
                    // Streaming (best-effort): prefer streaming tool-call arguments; fallback to non-streaming.
                    const streamFn = client.responses.stream;
                    if (typeof streamFn === "function") {
                        console.log("[zone-stream-start]", { filePath: input.filePath });
                        const controller = new AbortController();
                        const timeout = setTimeout(() => {
                            try {
                                controller.abort();
                            }
                            catch { }
                        }, 120_000);
                        const runner = client.responses.stream({
                            model,
                            temperature: 0,
                            max_output_tokens: maxOutputTokens,
                            tools: [applyPatchTool],
                            tool_choice: applyPatchToolChoice,
                            input: responseInput,
                        });
                        let argsSnapshot = "";
                        let lastPatchLen = 0;
                        let sawAnyToolArgsEvent = false;
                        const tryExtractPatchFromArgs = (raw) => {
                            const key = `"patch"`;
                            const k = raw.indexOf(key);
                            if (k < 0)
                                return null;
                            const colon = raw.indexOf(":", k + key.length);
                            if (colon < 0)
                                return null;
                            const firstQuote = raw.indexOf('"', colon + 1);
                            if (firstQuote < 0)
                                return null;
                            // parse JSON string value with escapes
                            let i = firstQuote + 1;
                            let out = "";
                            while (i < raw.length) {
                                const ch = raw[i];
                                if (ch === "\\") {
                                    const nxt = raw[i + 1];
                                    if (nxt == null)
                                        return null;
                                    // handle common escapes
                                    if (nxt === "n")
                                        out += "\n";
                                    else if (nxt === "r")
                                        out += "\r";
                                    else if (nxt === "t")
                                        out += "\t";
                                    else if (nxt === '"')
                                        out += '"';
                                    else if (nxt === "\\")
                                        out += "\\";
                                    else
                                        out += nxt;
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
                            for await (const event of runner) {
                                if (controller.signal.aborted)
                                    break;
                                if (!event || typeof event !== "object")
                                    continue;
                                // Primary: tool-call arguments streaming
                                if (event.type === "response.function_call_arguments.delta") {
                                    sawAnyToolArgsEvent = true;
                                    const snap = typeof event.snapshot === "string" ? event.snapshot : "";
                                    if (snap && snap !== argsSnapshot) {
                                        argsSnapshot = snap;
                                        const patchText = tryExtractPatchFromArgs(argsSnapshot);
                                        if (typeof patchText === "string" && patchText.length >= lastPatchLen) {
                                            const delta = patchText.slice(lastPatchLen);
                                            if (delta) {
                                                console.log("[zone-stream-delta]", { delta: delta.slice(0, 30) });
                                                input.onProgress?.({
                                                    type: "patch_stream_delta",
                                                    filePath: input.filePath,
                                                    delta,
                                                });
                                                lastPatchLen = patchText.length;
                                            }
                                        }
                                    }
                                    continue;
                                }
                                // Secondary: output_text streaming (if tool-call isn't used by the model)
                                if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                                    console.log("[zone-stream-delta]", { delta: String(event.delta).slice(0, 30) });
                                    input.onProgress?.({
                                        type: "patch_stream_delta",
                                        filePath: input.filePath,
                                        delta: event.delta,
                                    });
                                }
                            }
                        }
                        finally {
                            try {
                                clearTimeout(timeout);
                            }
                            catch { }
                        }
                        response = await runner.finalResponse();
                        // If the SDK doesn't emit function_call_arguments.delta events (common in some tool-call modes),
                        // fall back to emitting the FINAL tool arguments as a single "delta" so the UI shows something.
                        if (typeof input.onProgress === "function" && lastPatchLen === 0) {
                            const toolPatch = extractPatchFromToolCall(response);
                            if (typeof toolPatch === "string" && toolPatch.length > 0) {
                                const buildPatchSnippet = (raw) => {
                                    const t = String(raw || "").replace(/\r\n/g, "\n");
                                    const findIdx = t.lastIndexOf("\n--- FIND ---");
                                    const repIdx = t.lastIndexOf("\n--- REPLACE ---");
                                    if (repIdx < 0)
                                        return t;
                                    const findStart = findIdx >= 0 ? findIdx + "\n--- FIND ---".length : -1;
                                    const repStart = repIdx + "\n--- REPLACE ---".length;
                                    const findBlock = findStart >= 0 && findStart < repIdx
                                        ? t.slice(findStart, repIdx).replace(/^\s*\n/, "").replace(/\s*$/, "")
                                        : "";
                                    let replaceBlock = t.slice(repStart).replace(/^\s*\n/, "");
                                    // Cap output aggressively: show only changed region.
                                    const findLines = findBlock ? findBlock.split("\n") : [];
                                    const replaceLines = replaceBlock ? replaceBlock.split("\n") : [];
                                    const before = findLines.slice(Math.max(0, findLines.length - 2));
                                    const after = findLines.slice(0, Math.min(2, findLines.length));
                                    const maxReplaceLines = 60;
                                    const replaceCapped = replaceLines.length > maxReplaceLines
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
                                console.log("[zone-stream-delta]", {
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
                                }
                                catch { }
                            }
                        }
                    }
                    else {
                        response = await client.responses.create({
                            model,
                            temperature: 0,
                            max_output_tokens: maxOutputTokens,
                            tools: [applyPatchTool],
                            tool_choice: applyPatchToolChoice,
                            input: responseInput,
                        });
                    }
                }
                catch (err) {
                    const elapsedMs = Date.now() - callStartedAt;
                    const p = (0, openaiClient_js_1.formatOpenAiThrownErrorPayload)(err);
                    openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
                    console.log("[zone-openai-call-error]", JSON.stringify({
                        filePath: input.filePath,
                        attempt: findReplaceAttemptIndex,
                        elapsedMs,
                        name: p.name,
                        message: p.message,
                        status: p.status,
                        code: p.code,
                        type: p.type,
                    }));
                    console.log("[zone-stream-fallback]", { error: err instanceof Error ? err.message : String(err) });
                    // Fallback to non-streaming on any streaming failure.
                    response = await client.responses.create({
                        model,
                        temperature: 0,
                        max_output_tokens: maxOutputTokens,
                        tools: [applyPatchTool],
                        tool_choice: applyPatchToolChoice,
                        input: responseInput,
                    });
                }
                const elapsedMs = Date.now() - callStartedAt;
                openAiTransportErrorDetails = null;
                lastSuccessfulResponsesCreateResult = response;
                console.log("[zone-openai-call-success]", JSON.stringify({
                    filePath: input.filePath,
                    attempt: findReplaceAttemptIndex,
                    elapsedMs,
                    responseKeys: response && typeof response === "object"
                        ? Object.keys(response)
                        : [],
                }));
                (0, openaiClient_js_1.logOpenAiResponseDebug)(response, {
                    filePath: input.filePath,
                    attempt: findReplaceAttemptIndex,
                });
                const extraction = (0, openaiClient_js_1.extractResponsesApiOutputText)(response);
                const toolPatch = extractPatchFromToolCall(response);
                const fromTool = toolPatch != null ? String(toolPatch).trim() : "";
                const fromExtract = extraction.ok ? extraction.text.trim() : "";
                const rawForAttempt = fromTool || fromExtract;
                console.log("[zone-gpt-raw]", rawForAttempt.slice(0, 500));
                console.log("[zone-patch-raw-response-debug]", JSON.stringify({
                    filePath: input.filePath,
                    attempt: findReplaceAttemptIndex,
                    rawLength: rawForAttempt.length,
                    rawPreview: rawForAttempt.slice(0, 240),
                }));
                if (rawForAttempt.length > 0) {
                    lastRawPatchResponse = rawForAttempt;
                }
                else {
                    const detailsLine = (0, openaiClient_js_1.buildEmptyModelResponseDetailsLine)({
                        response,
                        extraction,
                        linearReasonWhenExtractionOk: "tool_and_extractable_text_empty",
                    });
                    lastEmptyModelDetailsLine = detailsLine;
                    let emptyLog;
                    try {
                        emptyLog = {
                            attempt: findReplaceAttemptIndex,
                            ...JSON.parse(detailsLine),
                        };
                    }
                    catch {
                        emptyLog = {
                            attempt: findReplaceAttemptIndex,
                            detailsLine,
                        };
                    }
                    console.log("[zone-full-patch-empty-response]", JSON.stringify(emptyLog));
                }
                if (fromTool) {
                    console.log("[zone-patch-tool] tool call received");
                    console.log("[zone-patch-tool] patch length:", fromTool.length);
                    return fromTool;
                }
                if (fromExtract) {
                    console.warn("[zone-patch-tool] No structured tool patch; using extracted response text for validation");
                    return fromExtract;
                }
                console.error("[zone-patch-tool] No structured patch returned");
                return "";
            },
            validate: (raw) => {
                const issues = [];
                const parsed = (0, developerPatchParse_js_1.parseDeveloperPatchText)(raw);
                const patchCount = parsed && !parsed.noChangeNeeded
                    ? (parsed.createContent !== undefined ? 1 : parsed.edits.length)
                    : 0;
                console.log("[zone-parse-result]", {
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
                    console.log("[zone-noop-detected]", JSON.stringify({
                        filePath: input.filePath,
                        attempt: findReplaceAttemptIndex,
                        rawPreview: raw.slice(0, 120),
                    }));
                    if (findReplaceAttemptIndex < 2) {
                        console.log("[zone-noop-retry]", JSON.stringify({ filePath: input.filePath, attempt: findReplaceAttemptIndex }));
                        issues.push({
                            code: "NOOP_DETECTED",
                            message: "Model returned NO_CHANGE_NEEDED, but a patch is required. Retry with forced patch instructions.",
                            severity: "error",
                        });
                        return issues;
                    }
                    console.log("[zone-noop-final]", JSON.stringify({ filePath: input.filePath, attempt: findReplaceAttemptIndex }));
                    // After a forced retry, accept NO_CHANGE_NEEDED so the caller can treat it as no-op.
                    return issues;
                }
                if (!isValidPatchResponse(raw)) {
                    issues.push({
                        code: "INVALID_PATCH_FORMAT",
                        message: "[invalid_patch_format] Model did not return a valid patch structure",
                        severity: "error",
                    });
                    return issues;
                }
                if (!parsed) {
                    issues.push({
                        code: "INVALID_PATCH_FORMAT",
                        message: "Patch text could not be parsed into structured FIND/REPLACE edits.",
                        severity: "error",
                    });
                    return issues;
                }
                return issues;
            },
            buildFeedbackPrompt: buildFindReplaceFormatRetryPrompt,
        });
        const originalForRecovery = input.fullOriginalFileContent ?? input.fileContent;
        if (!retryResult.ok) {
            console.error("[zone-patch] model failed to produce valid patch after retries");
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
            const rawAttempt = lastRawPatchResponse ||
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
            const recovered = (0, patchConversion_js_1.tryRecoverDeveloperPatchFromModelOutput)({
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
            const recovered = (0, patchConversion_js_1.tryRecoverDeveloperPatchFromModelOutput)({
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
    let maxOutputTokensFull;
    if (originalLineCount > 200)
        maxOutputTokensFull = 6000;
    else if (originalLineCount > 100)
        maxOutputTokensFull = 4000;
    const retryResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
        maxAttempts: 3,
        prompt,
        execute: async (currentPrompt) => {
            fullContentAttemptIndex += 1;
            const callStartedAt = Date.now();
            console.log("[zone-openai-call-start]", JSON.stringify({
                filePath: input.filePath,
                attempt: fullContentAttemptIndex,
                model,
                max_output_tokens: maxOutputTokensFull ?? null,
            }));
            let response;
            let promptWithAntiTruncation = fullContentAttemptIndex >= 2
                ? [
                    currentPrompt,
                    "",
                    "CRITICAL: You MUST include the COMPLETE file content. Do not truncate.",
                    `The file has ${originalLineCount} lines.`,
                    "Your response must have approximately the same number of lines.",
                ].join("\n")
                : currentPrompt;
            try {
                // Streaming (best-effort) for full_content_json mode: stream output_text deltas directly.
                const streamFn = client.responses.stream;
                if (typeof streamFn === "function") {
                    console.log("[zone-stream-start]", { filePath: input.filePath });
                    const controller = new AbortController();
                    const timeout = setTimeout(() => {
                        try {
                            controller.abort();
                        }
                        catch { }
                    }, 120_000);
                    const runner = client.responses.stream({
                        model,
                        input: promptWithAntiTruncation,
                        ...(maxOutputTokensFull != null
                            ? { max_output_tokens: maxOutputTokensFull }
                            : {}),
                    });
                    let rawAccum = "";
                    let lastFullContentLen = 0;
                    const tryExtractJsonStringValuePartial = (raw, key) => {
                        const k = raw.indexOf(`"${key}"`);
                        if (k < 0)
                            return "";
                        const colon = raw.indexOf(":", k + key.length + 2);
                        if (colon < 0)
                            return "";
                        const firstQuote = raw.indexOf('"', colon + 1);
                        if (firstQuote < 0)
                            return "";
                        let i = firstQuote + 1;
                        let out = "";
                        while (i < raw.length) {
                            const ch = raw[i];
                            if (ch === "\\") {
                                const nxt = raw[i + 1];
                                if (nxt == null)
                                    return out;
                                if (nxt === "n")
                                    out += "\n";
                                else if (nxt === "r")
                                    out += "\r";
                                else if (nxt === "t")
                                    out += "\t";
                                else if (nxt === '"')
                                    out += '"';
                                else if (nxt === "\\")
                                    out += "\\";
                                else
                                    out += nxt;
                                i += 2;
                                continue;
                            }
                            if (ch === '"')
                                return out;
                            out += ch;
                            i += 1;
                        }
                        return out;
                    };
                    try {
                        for await (const event of runner) {
                            if (controller.signal.aborted)
                                break;
                            if (!event || typeof event !== "object")
                                continue;
                            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                                rawAccum += event.delta;
                                console.log("[zone-stream-delta]", { delta: String(event.delta).slice(0, 30) });
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
                                }
                                catch { }
                            }
                        }
                    }
                    finally {
                        try {
                            clearTimeout(timeout);
                        }
                        catch { }
                    }
                    response = await runner.finalResponse();
                    // Some SDK versions may omit output_text on finalResponse(); keep our accumulated text.
                    response.output_text = rawAccum;
                }
                else {
                    response = await client.responses.create({
                        model,
                        input: promptWithAntiTruncation,
                        ...(maxOutputTokensFull != null
                            ? { max_output_tokens: maxOutputTokensFull }
                            : {}),
                    });
                }
            }
            catch (err) {
                const elapsedMs = Date.now() - callStartedAt;
                const p = (0, openaiClient_js_1.formatOpenAiThrownErrorPayload)(err);
                openAiTransportErrorDetails = JSON.stringify({ ...p, elapsedMs });
                console.log("[zone-openai-call-error]", JSON.stringify({
                    filePath: input.filePath,
                    attempt: fullContentAttemptIndex,
                    elapsedMs,
                    name: p.name,
                    message: p.message,
                    status: p.status,
                    code: p.code,
                    type: p.type,
                }));
                console.log("[zone-stream-fallback]", {
                    error: err instanceof Error ? err.message : String(err),
                });
                // Fallback to non-streaming on any streaming failure.
                response = await client.responses.create({
                    model,
                    input: promptWithAntiTruncation,
                    ...(maxOutputTokensFull != null
                        ? { max_output_tokens: maxOutputTokensFull }
                        : {}),
                });
            }
            const elapsedMs = Date.now() - callStartedAt;
            openAiTransportErrorDetails = null;
            lastSuccessfulResponsesCreateResult = response;
            console.log("[zone-openai-call-success]", JSON.stringify({
                filePath: input.filePath,
                attempt: fullContentAttemptIndex,
                elapsedMs,
                responseKeys: response && typeof response === "object"
                    ? Object.keys(response)
                    : [],
            }));
            (0, openaiClient_js_1.logOpenAiResponseDebug)(response, {
                filePath: input.filePath,
                attempt: fullContentAttemptIndex,
                mode: "full_content_json",
            });
            const extraction = (0, openaiClient_js_1.extractResponsesApiOutputText)(response);
            const r = response;
            const rawText = extraction.ok
                ? extraction.text
                : (r.output_text ?? "");
            console.log("[zone-full-content-debug]", rawText?.slice(0, 500));
            const jsonText = extractJson(rawText);
            return JSON.parse(stripJsonFences(jsonText));
        },
        validate: (result) => {
            const issues = [];
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
            else {
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
        buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
    });
    if (!retryResult.ok) {
        if (openAiTransportErrorDetails !== null) {
            throw new Error(`planFullPatchWithLlm: openai_call_error after ${retryResult.attempts} attempt(s): ${openAiTransportErrorDetails}`);
        }
        throw new Error(`planFullPatchWithLlm failed after ${retryResult.attempts} attempt(s): ${retryResult.reason}`);
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
//# sourceMappingURL=planFullPatch.js.map