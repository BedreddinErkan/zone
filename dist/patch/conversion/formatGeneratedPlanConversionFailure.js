"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatGeneratedPlanConversionFailure = formatGeneratedPlanConversionFailure;
const generatedPlanConversionFailureMeta_js_1 = require("./generatedPlanConversionFailureMeta.js");
function formatGeneratedPlanConversionFailure(failure) {
    return {
        stage: "generated_patch_conversion",
        status: "blocked",
        summary: (0, generatedPlanConversionFailureMeta_js_1.getGeneratedPlanConversionFailureSummary)(failure.code),
        details: failure.reason,
        // existing fields (koru)
        canConvert: false,
        reasonCode: failure.code,
        applyStatus: "blocked"
    };
}
//# sourceMappingURL=formatGeneratedPlanConversionFailure.js.map