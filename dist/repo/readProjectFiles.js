"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProjectFiles = readProjectFiles;
const promises_1 = __importDefault(require("node:fs/promises"));
function truncateContent(content, maxLength = 6000) {
    if (content.length <= maxLength) {
        return content;
    }
    return `${content.slice(0, maxLength)}\n\n/* ...truncated... */`;
}
async function readProjectFiles(paths) {
    const result = {};
    for (const filePath of paths) {
        try {
            const content = await promises_1.default.readFile(filePath, "utf-8");
            result[filePath] = truncateContent(content);
        }
        catch {
            result[filePath] = "";
        }
    }
    return result;
}
//# sourceMappingURL=readProjectFiles.js.map