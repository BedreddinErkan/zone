"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planFullPatchWithLlm = planFullPatchWithLlm;
const zod_1 = require("zod");
const openaiClient_js_1 = require("./openaiClient.js");
const withSelfHealingRetry_js_1 = require("../core/withSelfHealingRetry.js");
const fullPatchPrompt_js_1 = require("../prompts/fullPatchPrompt.js");
const fullContentSchema = zod_1.z.object({
    filePath: zod_1.z.string(),
    fullContent: zod_1.z.string(),
    summary: zod_1.z.string(),
    warnings: zod_1.z.array(zod_1.z.string()),
});
const LARGE_FILE_PATCH_THRESHOLD = 8000;
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
    const client = (0, openaiClient_js_1.createOpenAIClient)(input.userOpenAiKey);
    const model = (0, openaiClient_js_1.getModelName)("high");
    const outputMode = input.normalizedTaskIntent === "micro_edit" ||
        input.fileContent.length > LARGE_FILE_PATCH_THRESHOLD
        ? "find_replace_patch"
        : "full_content";
    const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({
        task: input.task,
        filePath: input.filePath,
        fileContent: input.fileContent,
        repoSummary: input.repoSummary,
        relatedContext: input.relatedContext,
        taskIntent: input.taskIntent,
        normalizedTaskIntent: input.normalizedTaskIntent,
        outputMode,
    });
    if (outputMode === "find_replace_patch") {
        const response = await client.responses.create({ model, input: prompt });
        const rawText = response.output_text ?? "";
        return {
            mode: "patch",
            filePath: input.filePath,
            patchText: rawText.trim(),
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