"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGeneratedPatchPlanFlow = runGeneratedPatchPlanFlow;
const generatedPlanConversion_js_1 = require("../patch/generatedPlanConversion.js");
function runGeneratedPatchPlanFlow(args) {
    const { generatedPlan, preview } = args;
    const validation = (0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(generatedPlan);
    if (!validation.canConvert) {
        return {
            ok: false,
            preview,
            code: validation.code,
            reason: validation.reason,
        };
    }
    const patchPlan = (0, generatedPlanConversion_js_1.convertGeneratedPlanToPatchPlan)(generatedPlan);
    return {
        ok: true,
        preview,
        patchPlan,
    };
}
//# sourceMappingURL=runGeneratedPatchPlanFlow.js.map