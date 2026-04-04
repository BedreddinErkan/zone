"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERATED_PLAN_CONVERSION_FAILURE_META = void 0;
exports.getGeneratedPlanConversionFailureSummary = getGeneratedPlanConversionFailureSummary;
exports.GENERATED_PLAN_CONVERSION_FAILURE_META = {
    EMPTY_OPERATIONS: {
        summary: "Generated plan contains no operations."
    },
    MULTIPLE_OPERATIONS_UNSUPPORTED: {
        summary: "Generated plan contains multiple operations, which is not supported."
    },
    UNSUPPORTED_INTENT: {
        summary: "Generated plan intent is not allowed for deterministic conversion."
    },
    UNSUPPORTED_OPERATION_TYPE: {
        summary: "Generated plan operation type is not supported."
    },
    PLACEHOLDER_FILE_PATH: {
        summary: "Generated plan file path contains a placeholder value."
    },
    PLACEHOLDER_TEXT: {
        summary: "Generated plan text contains a placeholder value."
    },
    MISSING_REQUIRED_FIELDS: {
        summary: "Generated plan is missing required fields."
    },
    INVALID_MATCH_MODE: {
        summary: "Generated plan match mode is invalid."
    },
    NO_OP_REPLACEMENT: {
        summary: "Generated plan replacement would not change file contents."
    }
};
function getGeneratedPlanConversionFailureSummary(code) {
    if (code in exports.GENERATED_PLAN_CONVERSION_FAILURE_META) {
        return exports.GENERATED_PLAN_CONVERSION_FAILURE_META[code].summary;
    }
    return "Generated plan conversion failed.";
}
//# sourceMappingURL=generatedPlanConversionFailureMeta.js.map