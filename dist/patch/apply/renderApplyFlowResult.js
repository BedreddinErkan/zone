"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderApplyFlowResult = renderApplyFlowResult;
function renderApplyFlowResult(result) {
    return [
        "=== APPLY RESULT ===",
        `Status: ${result.status}`,
        `Operations attempted: ${result.operationsAttempted}`,
        `Operations applied: ${result.operationsApplied}`,
        `Files touched: ${result.filesTouched.join(", ") || "none"}`,
        `Backup created: ${result.backupCreated ? "yes" : "no"}`,
        `Message: ${result.message}`
    ].join("\n");
}
//# sourceMappingURL=renderApplyFlowResult.js.map