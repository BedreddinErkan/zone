"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApplyStageResult = buildApplyStageResult;
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
function resolveStatus(status) {
    switch (status) {
        case "applied":
            return "success";
        case "failed":
            return "failed";
        case "skipped":
            return "skipped";
    }
}
function resolveSeverity(status, operationsApplied) {
    switch (status) {
        case "applied":
            return "ok";
        case "failed":
            return operationsApplied > 0 ? "error" : "fatal";
        case "skipped":
            return "warning";
    }
}
function resolveCode(status, operationsApplied) {
    switch (status) {
        case "applied":
            return "ZONE_APPLY_SUCCESS";
        case "failed":
            return operationsApplied > 0 ? "ZONE_APPLY_PARTIAL" : "ZONE_APPLY_FAILED";
        case "skipped":
            return "ZONE_SKIPPED";
    }
}
function resolveSummary(status, operationsApplied) {
    switch (status) {
        case "applied":
            return "Apply succeeded: all operations applied successfully.";
        case "failed":
            return operationsApplied > 0
                ? "Apply partially failed: some operations were not applied."
                : "Apply failed: no operations were applied.";
        case "skipped":
            return "Apply skipped: no operations were executed.";
    }
}
function buildApplyStageResult(result) {
    const { status, operationsApplied, filesTouched } = result;
    const details = filesTouched.length > 0
        ? `Files touched: ${filesTouched.join(", ")}`
        : undefined;
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "apply",
        status: resolveStatus(status),
        severity: resolveSeverity(status, operationsApplied),
        code: resolveCode(status, operationsApplied),
        summary: resolveSummary(status, operationsApplied),
        details,
    });
}
//# sourceMappingURL=buildApplyStageResult.js.map