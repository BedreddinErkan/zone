"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOpenAIClient = createOpenAIClient;
exports.getModelName = getModelName;
const openai_1 = __importDefault(require("openai"));
function createOpenAIClient() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is missing in .env");
    }
    return new openai_1.default({ apiKey });
}
function getModelName() {
    return process.env.OPENAI_MODEL || "gpt-4o-mini";
}
//# sourceMappingURL=openaiClient.js.map