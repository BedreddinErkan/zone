"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planFullPatchWithLlm = planFullPatchWithLlm;
const zod_1 = require("zod");
const openaiClient_js_1 = require("./openaiClient.js");
const withSelfHealingRetry_js_1 = require("../core/withSelfHealingRetry.js");
const fullPatchPrompt_js_1 = require("../prompts/fullPatchPrompt.js");
const executionPlan_js_1 = require("./executionPlan.js");
const developerPatchParse_js_1 = require("../core/developerPatchParse.js");
const fullContentSchema = zod_1.z.object({
    filePath: zod_1.z.string(),
    fullContent: zod_1.z.string(),
    summary: zod_1.z.string(),
    warnings: zod_1.z.array(zod_1.z.string()),
});
const LARGE_FILE_PATCH_THRESHOLD = 8000;
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
    const needsHardPatchCorrection = feedback.issues.some((issue) => issue.code === "INVALID_PATCH_FORMAT" || issue.code === "EMPTY_PATCH");
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
    const outputMode = selectFullPatchOutputMode({
        outputMode: input.outputMode,
        task: input.task,
        fileContent: input.fileContent,
        relatedContext: input.relatedContext,
    });
    const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({
        task: input.task,
        filePath: input.filePath,
        fileContent: input.fileContent,
        repoSummary: input.repoSummary,
        relatedContext: input.relatedContext,
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
        const strictSystemInstruction = buildStrictPatchSystemInstruction();
        const applyPatchTool = buildApplyPatchTool();
        const applyPatchToolChoice = buildApplyPatchToolChoice();
        const retryResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            maxAttempts: 3,
            prompt: findReplacePrompt,
            execute: async (currentPrompt) => {
                console.log("[zone-patch-request] sending strict patch system instruction", JSON.stringify({
                    filePath: input.filePath,
                    max_output_tokens: 2000,
                    temperature: 0,
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
                const response = await client.responses.create({
                    model,
                    temperature: 0,
                    max_output_tokens: 2000,
                    tools: [applyPatchTool],
                    tool_choice: applyPatchToolChoice,
                    input: responseInput,
                });
                const toolPatch = extractPatchFromToolCall(response);
                if (toolPatch) {
                    console.log("[zone-patch-tool] tool call received");
                    console.log("[zone-patch-tool] patch length:", toolPatch.length);
                    return toolPatch.trim();
                }
                console.error("[zone-patch-tool] No structured patch returned");
                return "";
            },
            validate: (raw) => {
                const issues = [];
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
                        message: "[invalid_patch_format] Model did not return a valid patch structure",
                        severity: "error",
                    });
                    return issues;
                }
                if (!(0, developerPatchParse_js_1.parseDeveloperPatchText)(raw)) {
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
        if (!retryResult.ok) {
            console.error("[zone-patch] model failed to produce valid patch after retries");
            return {
                mode: "invalid_patch_format",
                filePath: input.filePath,
                summary: "Large-file patch format validation failed.",
                warnings: ["[invalid_patch_format] Model failed after retries"],
            };
        }
        const rawText = retryResult.value;
        console.log("[zone-patch-debug] raw model output:", rawText.slice(0, 500));
        console.log("[zone-patch-debug-full]", rawText.slice(0, 500));
        if (!isValidPatchResponse(rawText)) {
            return {
                mode: "invalid_patch_format",
                filePath: input.filePath,
                summary: "Large-file patch missing required structure.",
                warnings: ["[invalid_patch_format] Model failed after retries"],
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
    const retryResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
        maxAttempts: 3,
        prompt,
        execute: async (currentPrompt) => {
            const response = await client.responses.create({
                model,
                input: currentPrompt,
            });
            const rawText = response.output_text ?? "";
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