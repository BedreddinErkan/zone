"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPreviewStageResult = buildPreviewStageResult;
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
function resolveStatus(operationCount) {
    return operationCount > 0 ? "success" : "info";
}
function resolveSeverity(operationCount) {
    return operationCount > 0 ? "ok" : "warning";
}
function resolveCode(operationCount) {
    return operationCount > 0 ? "ZONE_OK" : "ZONE_SKIPPED";
}
function resolveSummary(operationCount) {
    if (operationCount === 0) {
        return "Generated patch preview contains no operations.";
    }
    if (operationCount === 1) {
        return "Generated patch preview contains 1 operation.";
    }
    return `Generated patch preview contains ${operationCount} operations.`;
}
function resolveDetails(plan) {
    if (plan.operations.length === 0) {
        return undefined;
    }
    return plan.operations
        .map((operation, index) => {
        const filePath = "filePath" in operation && typeof operation.filePath === "string"
            ? operation.filePath
            : "unknown";
        return `${index + 1}. ${operation.type} -> ${filePath}`;
    })
        .join("\n");
}
function buildPreviewStageResult(plan) {
    const operationCount = plan.operations.length;
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "generated_patch_preview",
        status: resolveStatus(operationCount),
        severity: resolveSeverity(operationCount),
        code: resolveCode(operationCount),
        summary: resolveSummary(operationCount),
        details: resolveDetails(plan),
    });
}
//# sourceMappingURL=buildPreviewStageResult.js.map