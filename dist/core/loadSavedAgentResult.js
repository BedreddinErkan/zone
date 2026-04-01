"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSavedAgentResult = loadSavedAgentResult;
const node_path_1 = __importDefault(require("node:path"));
const files_js_1 = require("../utils/files.js");
async function loadSavedAgentResult(targetPath) {
    const resultPath = node_path_1.default.join(targetPath, ".agent-cache", "last-result.json");
    const exists = await (0, files_js_1.fileExists)(resultPath);
    if (!exists) {
        return null;
    }
    const raw = await (0, files_js_1.readTextFile)(resultPath);
    return JSON.parse(raw);
}
//# sourceMappingURL=loadSavedAgentResult.js.map