"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConversionStageResult = buildConversionStageResult;
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
function resolveFailureSummary(code) {
    switch (code) {
        case "EMPTY_OPERATIONS":
            return "Conversion blocked: generated plan contains no operations.";
        case "MULTI_OPERATION_NOT_SUPPORTED":
            return "Conversion blocked: multiple operations are not supported.";
        case "UNSUPPORTED_INTENT":
            return "Conversion blocked: plan intent is not supported.";
        case "UNSUPPORTED_OPERATION":
            return "Conversion blocked: plan operation type is not supported.";
        case "PLACEHOLDER_FILE_PATH":
            return "Conversion blocked: file path contains a placeholder value.";
        case "PLACEHOLDER_TEXT":
            return "Conversion blocked: find/replace values contain placeholders.";
        case "MISSING_REQUIRED_FIELDS":
            return "Conversion blocked: required fields are missing.";
        case "NON_EXACT_MATCH":
            return "Conversion blocked: only exact match mode is supported.";
        case "NO_OP_REPLACEMENT":
            return "Conversion blocked: find and replaceWith are identical.";
    }
}
function resolveFailureCode(code) {
    switch (code) {
        case "PLACEHOLDER_FILE_PATH":
        case "PLACEHOLDER_TEXT":
            return "ZONE_CONVERSION_FAILED_PLACEHOLDER";
        case "UNSUPPORTED_INTENT":
        case "UNSUPPORTED_OPERATION":
            return "ZONE_CONVERSION_FAILED_UNSUPPORTED";
        case "EMPTY_OPERATIONS":
        case "MULTI_OPERATION_NOT_SUPPORTED":
        case "MISSING_REQUIRED_FIELDS":
        case "NON_EXACT_MATCH":
        case "NO_OP_REPLACEMENT":
            return "ZONE_CONVERSION_FAILED";
    }
}
function buildConversionStageResult(check) {
    if (check.canConvert) {
        return (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "generated_patch_conversion",
            status: "success",
            severity: "ok",
            code: "ZONE_OK",
            summary: "Generated patch plan conversion succeeded.",
        });
    }
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "generated_patch_conversion",
        status: "blocked",
        severity: "fatal",
        code: resolveFailureCode(check.code),
        summary: resolveFailureSummary(check.code),
        details: check.reason,
    });
}
//# sourceMappingURL=buildConversionStageResult.js.map