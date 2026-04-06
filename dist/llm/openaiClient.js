"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInferenceMode = getInferenceMode;
exports.getHostedInferenceBaseUrl = getHostedInferenceBaseUrl;
exports.createOpenAIClient = createOpenAIClient;
exports.getModelName = getModelName;
const openai_1 = __importDefault(require("openai"));
function getInferenceMode() {
    const explicitMode = (process.env.ZONE_INFERENCE_MODE || "")
        .trim()
        .toLowerCase();
    if (explicitMode === "hosted" || explicitMode === "local") {
        return explicitMode;
    }
    if (process.env.VITEST === "true") {
        return "local";
    }
    const apiKey = typeof process.env.OPENAI_API_KEY === "string"
        ? process.env.OPENAI_API_KEY.trim()
        : "";
    return apiKey ? "local" : "hosted";
}
function getHostedInferenceBaseUrl() {
    const configuredBaseUrl = typeof process.env.ZONE_API_BASE_URL === "string"
        ? process.env.ZONE_API_BASE_URL.trim()
        : "";
    return (configuredBaseUrl || "https://zonecli.dev").replace(/\/+$/, "");
}
function createOpenAIClient() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is missing for local inference mode.");
    }
    return new openai_1.default({ apiKey });
}
function getModelName() {
    return process.env.OPENAI_MODEL || "gpt-4o-mini";
}
//# sourceMappingURL=openaiClient.js.map