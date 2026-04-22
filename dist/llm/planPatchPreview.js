"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planPatchPreviewWithLlm = planPatchPreviewWithLlm;
const openaiClient_js_1 = require("./openaiClient.js");
const schemas_js_1 = require("./schemas.js");
const patchPreviewPrompt_js_1 = require("../prompts/patchPreviewPrompt.js");
const executionPlan_js_1 = require("./executionPlan.js");
function stripJsonFences(raw) {
    return raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
}
function extractAndRepairJson(raw) {
    const cleaned = stripJsonFences(raw);
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
        throw new Error("No JSON found");
    }
    return cleaned.slice(first, last + 1);
}
async function planPatchPreviewWithLlm(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)();
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
    const prompt = (0, patchPreviewPrompt_js_1.buildPatchPreviewPrompt)({
        task: input.task,
        intent: input.intent,
        filePath: input.suggestedFiles.map((f) => f.path).join(", ") || "(no target file)",
        fileContent: combinedContext,
        repoSummary,
        relatedContext,
        schemaAwareSummary,
        executionPlanContext: (0, executionPlan_js_1.formatExecutionPlanForPrompt)(input.executionPlan),
    });
    const response = await client.responses.create({
        model,
        input: prompt,
        text: { format: { type: "json_object" } }
    });
    const rawText = response.output_text || "";
    let parsed;
    try {
        parsed = JSON.parse(extractAndRepairJson(rawText));
    }
    catch (error) {
        const preview = rawText.slice(0, 50);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse patch preview JSON: ${message}. Raw preview: ${preview}`);
    }
    const validated = schemas_js_1.llmPatchPlanSchema.parse(parsed);
    return {
        summary: validated.summary,
        patches: validated.patches,
        warnings: validated.warnings
    };
}
//# sourceMappingURL=planPatchPreview.js.map