"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderGeneratedPatchPlan = renderGeneratedPatchPlan;
function renderOperation(operation) {
    switch (operation.type) {
        case "safe_replace":
            return [
                "- type: safe_replace",
                `  filePath: ${operation.filePath}`,
                `  find: ${operation.find}`,
                `  replaceWith: ${operation.replaceWith}`,
                `  matchMode: ${operation.matchMode}`
            ].join("\n");
        case "rename_symbol":
            return [
                "- type: rename_symbol",
                `  filePath: ${operation.filePath}`,
                `  from: ${operation.from}`,
                `  to: ${operation.to}`
            ].join("\n");
        case "update_import":
            return [
                "- type: update_import",
                `  filePath: ${operation.filePath}`,
                `  from: ${operation.from}`,
                `  to: ${operation.to}`
            ].join("\n");
        case "add_comment":
            return [
                "- type: add_comment",
                `  filePath: ${operation.filePath}`,
                `  comment: ${operation.comment}`,
                `  target: ${operation.target}`
            ].join("\n");
    }
}
function renderGeneratedPatchPlan(plan) {
    const lines = [];
    lines.push("=== GENERATED PATCH PLAN ===");
    lines.push(`Intent: ${plan.intent}`);
    lines.push(`Summary: ${plan.summary}`);
    lines.push("");
    if (plan.operations.length === 0) {
        lines.push("Operations:");
        lines.push("(none)");
    }
    else {
        lines.push("Operations:");
        for (const operation of plan.operations) {
            lines.push(renderOperation(operation));
        }
    }
    if (plan.warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        for (const warning of plan.warnings) {
            lines.push(`- ${warning}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=renderGeneratedPatchPlan.js.map