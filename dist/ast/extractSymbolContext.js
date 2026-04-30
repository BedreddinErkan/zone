"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSymbolContext = extractSymbolContext;
const extractFunctionRange_js_1 = require("./extractFunctionRange.js");
function extractSymbolContext(fileContent, functionName, filePath, contextLines = 5) {
    const normalized = String(fileContent ?? "").replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const target = (0, extractFunctionRange_js_1.findFunctionByName)(normalized, functionName, filePath);
    if (!target)
        return null;
    const header = lines.slice(0, 20).join("\n");
    const startIdx = Math.max(0, target.startLine - 1 - Math.max(0, contextLines));
    const endIdx = Math.min(lines.length, target.endLine + Math.max(0, contextLines));
    const surroundingContext = lines.slice(startIdx, endIdx).join("\n");
    return {
        targetFunction: target,
        surroundingContext,
        fileHeader: header,
    };
}
//# sourceMappingURL=extractSymbolContext.js.map