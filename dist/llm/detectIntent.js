"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectMessageType = detectMessageType;
exports.detectIntent = detectIntent;
const openaiClient_js_1 = require("./openaiClient.js");
function fallbackMessageType(task) {
    const normalizedTask = String(task || "").trim();
    if (!normalizedTask)
        return "question";
    if (/\b(?:fix|add|remove|delete|refactor|implement|update|change|rename|create|modify|insert|replace)\b/i.test(normalizedTask)) {
        return "patch_request";
    }
    if (/\b(?:should|better|best|recommend|opinion|approach|tradeoff|vs|versus)\b/i.test(normalizedTask)) {
        return "discussion";
    }
    return "question";
}
function parseMessageTypeJson(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "patch_request" ||
            parsed?.type === "question" ||
            parsed?.type === "discussion") {
            return parsed.type;
        }
    }
    catch {
        // fall through
    }
    const direct = trimmed.toLowerCase();
    if (direct === "patch_request" ||
        direct === "question" ||
        direct === "discussion") {
        return direct;
    }
    const match = trimmed.match(/"type"\s*:\s*"(patch_request|question|discussion)"/i);
    if (match?.[1]) {
        return match[1].toLowerCase();
    }
    return null;
}
async function detectMessageType(task, userApiKey) {
    const normalizedTask = typeof task === "string" ? task.trim() : "";
    if (!normalizedTask)
        return "question";
    try {
        const client = (0, openaiClient_js_1.createOpenAIClient)(userApiKey);
        const prompt = [
            "Classify this user message into one of:",
            "- patch_request: user wants code to be modified",
            "- question: user wants information about existing code",
            "- discussion: user wants advice/recommendations",
            "",
            'Respond with JSON: { "type": "patch_request|question|discussion" }',
            "",
            `Message: ${normalizedTask}`,
        ].join("\n");
        const response = await client.responses.create({
            model: "gpt-4o-mini",
            temperature: 0,
            max_output_tokens: 50,
            input: prompt,
        });
        const extraction = (0, openaiClient_js_1.extractResponsesApiOutputText)(response);
        const raw = extraction.ok ? extraction.text : "";
        const messageType = parseMessageTypeJson(raw) ?? fallbackMessageType(normalizedTask);
        console.log("[zone-intent-classify]", {
            taskPreview: normalizedTask.slice(0, 120),
            raw: raw.slice(0, 120),
            messageType,
        });
        return messageType;
    }
    catch (error) {
        const messageType = fallbackMessageType(normalizedTask);
        console.log("[zone-intent-classify]", {
            taskPreview: normalizedTask.slice(0, 120),
            error: error instanceof Error ? error.message : String(error),
            messageType,
            fallback: true,
        });
        return messageType;
    }
}
async function detectIntent(task, userApiKey) {
    const messageType = await detectMessageType(task, userApiKey);
    return messageType === "patch_request" ? "execute" : "chat";
}
//# sourceMappingURL=detectIntent.js.map