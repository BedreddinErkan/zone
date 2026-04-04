"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planFullPatchWithLlm = planFullPatchWithLlm;
const zod_1 = require("zod");
const openaiClient_js_1 = require("./openaiClient.js");
const fullPatchPrompt_js_1 = require("../prompts/fullPatchPrompt.js");
const fullContentSchema = zod_1.z.object({
    filePath: zod_1.z.string(),
    fullContent: zod_1.z.string(),
    summary: zod_1.z.string(),
    warnings: zod_1.z.array(zod_1.z.string()),
});
const LARGE_FILE_PATCH_THRESHOLD = 8000;
function extractJson(rawText) {
    const trimmed = rawText.trim();
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
async function planFullPatchWithLlm(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)();
    const outputMode = input.fileContent.length > LARGE_FILE_PATCH_THRESHOLD
        ? "find_replace_patch"
        : "full_content";
    const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({
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
    const parsed = JSON.parse(jsonText);
    const validated = fullContentSchema.parse(parsed);
    return {
        mode: "full_content",
        filePath: validated.filePath,
        fullContent: validated.fullContent,
        summary: validated.summary,
        warnings: validated.warnings,
    };
}
//# sourceMappingURL=planFullPatch.js.map