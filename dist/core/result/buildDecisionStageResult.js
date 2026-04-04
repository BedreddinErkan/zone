"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDecisionStageResult = buildDecisionStageResult;
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
function resolveStatus(mode) {
    switch (mode) {
        case "blocked":
            return "blocked";
        case "preview_only":
            return "success";
        case "safe_to_apply":
            return "success";
    }
}
function resolveSeverity(mode) {
    switch (mode) {
        case "blocked":
            return "fatal";
        case "preview_only":
            return "warning";
        case "safe_to_apply":
            return "ok";
    }
}
function resolveCode(mode, reasons) {
    switch (mode) {
        case "blocked":
            return reasons.some((r) => r.code === "SCHEMA_VALIDATION_ERROR")
                ? "ZONE_BLOCKED_SCHEMA_ERROR"
                : "ZONE_BLOCKED_HIGH_RISK";
        case "preview_only":
            return "ZONE_PREVIEW_ONLY";
        case "safe_to_apply":
            return "ZONE_OK";
    }
}
function resolveSummary(mode) {
    switch (mode) {
        case "blocked":
            return "Decision blocked: automatic apply is not permitted.";
        case "preview_only":
            return "Decision preview only: manual review is required before apply.";
        case "safe_to_apply":
            return "Decision safe to apply: no blocking risks detected.";
    }
}
function buildDecisionStageResult(result) {
    const { mode, reasons } = result;
    const details = reasons.length > 0
        ? reasons.map((r) => r.message).join(" | ")
        : undefined;
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "decision",
        status: resolveStatus(mode),
        severity: resolveSeverity(mode),
        code: resolveCode(mode, reasons),
        summary: resolveSummary(mode),
        details,
    });
}
//# sourceMappingURL=buildDecisionStageResult.js.map