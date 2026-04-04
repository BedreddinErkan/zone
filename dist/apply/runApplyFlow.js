"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runApplyFlow = runApplyFlow;
const canApplyDecision_js_1 = require("./canApplyDecision.js");
const applyPatchPlan_js_1 = require("./applyPatchPlan.js");
function validateBasicPatchPlan(plan) {
    if (!Array.isArray(plan.patches) || plan.patches.length === 0) {
        throw new Error("Patch plan must include at least one patch.");
    }
    const seen = new Set();
    for (const patch of plan.patches) {
        if (!patch.filePath || patch.filePath.trim().length === 0) {
            throw new Error("Patch filePath is required.");
        }
        if (seen.has(patch.filePath)) {
            throw new Error(`Duplicate patch filePath detected: ${patch.filePath}`);
        }
        seen.add(patch.filePath);
    }
}
async function runApplyFlow({ result, plan, request }) {
    const eligibility = (0, canApplyDecision_js_1.canApplyDecision)(result);
    if (!eligibility.allowed) {
        return {
            applied: false,
            filesChanged: [],
            summary: eligibility.message
        };
    }
    if (!request.confirm) {
        return {
            applied: false,
            filesChanged: [],
            summary: "Apply confirmation is required."
        };
    }
    validateBasicPatchPlan(plan);
    return (0, applyPatchPlan_js_1.applyPatchPlan)(plan);
}
//# sourceMappingURL=runApplyFlow.js.map