"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planPatchPreviewWithLlm = planPatchPreviewWithLlm;
const prompts_js_1 = require("./prompts.js");
const openaiClient_js_1 = require("./openaiClient.js");
const schemas_js_1 = require("./schemas.js");
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
async function planPatchPreviewWithLlm(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)();
    const prompt = (0, prompts_js_1.buildPatchPlanningPrompt)(input);
    const response = await client.responses.create({
        model,
        input: prompt
    });
    const rawText = response.output_text || "";
    const jsonText = extractJson(rawText);
    const parsed = JSON.parse(jsonText);
    const validated = schemas_js_1.llmPatchPlanSchema.parse(parsed);
    return {
        summary: validated.summary,
        patches: validated.patches,
        warnings: validated.warnings
    };
}
//# sourceMappingURL=planPatchPreview.js.map