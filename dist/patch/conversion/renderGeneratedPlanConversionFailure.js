"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderGeneratedPlanConversionFailure = renderGeneratedPlanConversionFailure;
const generatedPlanConversionFailureMeta_js_1 = require("./generatedPlanConversionFailureMeta.js");
function renderGeneratedPlanConversionFailure(failure) {
    return [
        "=== GENERATED PATCH PLAN CONVERSION ===",
        "Status: failed",
        `Reason code: ${failure.code}`,
        `Summary: ${(0, generatedPlanConversionFailureMeta_js_1.getGeneratedPlanConversionFailureSummary)(failure.code)}`,
        `Details: ${failure.reason}`,
        "Apply status: blocked",
        "No changes were applied."
    ].join("\n");
}
//# sourceMappingURL=renderGeneratedPlanConversionFailure.js.map