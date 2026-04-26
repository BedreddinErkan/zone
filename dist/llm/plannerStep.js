"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plannerStep = plannerStep;
const zod_1 = require("zod");
const openaiClient_js_1 = require("./openaiClient.js");
const plannerOutputSchema = zod_1.z.object({
    filesToEdit: zod_1.z.array(zod_1.z.string()),
    changeDescription: zod_1.z.string(),
    strategy: zod_1.z.string(),
});
async function plannerStep(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const prompt = [
        "You are a code-change planner for a patch execution agent.",
        "You only see file paths (no file contents). Choose the minimal set of files to edit.",
        "",
        "Return ONLY valid JSON with this exact shape:",
        `{ "filesToEdit": string[], "changeDescription": string, "strategy": string }`,
        "",
        "Rules:",
        "- filesToEdit MUST be a subset of rankedFilePaths (do not invent paths).",
        "- Prefer 1-3 files if possible.",
        "- Keep changeDescription and strategy concise (1-3 sentences each).",
        "",
        `Repo summary:\n${input.repoSummary}`,
        "",
        `Task:\n${input.task}`,
        "",
        "rankedFilePaths:",
        ...input.rankedFilePaths.map((p) => `- ${p}`),
    ].join("\n");
    const response = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0,
        input: prompt,
    });
    const raw = String(response.output_text ?? "").trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const validated = plannerOutputSchema.safeParse(parsed);
    if (!validated.success)
        return null;
    const allowed = new Set(input.rankedFilePaths);
    const filesToEdit = validated.data.filesToEdit.filter((p) => allowed.has(p));
    if (filesToEdit.length === 0)
        return null;
    return {
        filesToEdit,
        changeDescription: validated.data.changeDescription,
        strategy: validated.data.strategy,
    };
}
//# sourceMappingURL=plannerStep.js.map