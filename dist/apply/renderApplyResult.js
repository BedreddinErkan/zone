"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderApplyResult = renderApplyResult;
function renderApplyResult(result) {
    const lines = [
        "=== APPLY RESULT ===",
        `Applied: ${result.applied ? "yes" : "no"}`,
        `Summary: ${result.summary}`
    ];
    if (result.filesChanged.length > 0) {
        lines.push("Changed files:");
        for (const filePath of result.filesChanged) {
            lines.push(`- ${filePath}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=renderApplyResult.js.map