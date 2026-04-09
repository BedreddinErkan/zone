"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planFeatureWithLlm = planFeatureWithLlm;
const openaiClient_js_1 = require("./openaiClient.js");
const schemas_js_1 = require("./schemas.js");
const planFeaturePrompt_js_1 = require("../prompts/planFeaturePrompt.js");
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
async function planFeatureWithLlm(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)();
    const relevantFilesSummary = input.relevantFiles
        .map((file) => `- ${file.path} [${file.category}]`)
        .join("\n");
    const repoSummary = [input.projectSummary, ...input.projectNotes]
        .filter(Boolean)
        .join("\n");
    const schemaAwareSummary = (input.schemaAwareSummary ?? [])
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join("\n");
    const prompt = (0, planFeaturePrompt_js_1.buildPlanFeaturePrompt)({
        task: input.task,
        intent: input.intent,
        repoSummary,
        relevantFilesSummary,
        existingFilesSummary: input.existingFilesSummary,
        schemaAwareSummary
    });
    const response = await client.responses.create({
        model,
        input: prompt
    });
    console.log("\n=== RAW MODEL OUTPUT ===");
    console.log(response.output_text);
    const rawText = response.output_text || "";
    const jsonText = extractJson(rawText);
    const parsed = JSON.parse(stripJsonFences(jsonText));
    const validated = schemas_js_1.llmFeaturePlanSchema.parse(parsed);
    return {
        implementationSummary: validated.implementationSummary,
        steps: validated.steps,
        suggestedFiles: validated.suggestedFiles,
        risks: validated.risks
    };
}
//# sourceMappingURL=planFeature.js.map