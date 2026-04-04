"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDecisionEngine = runDecisionEngine;
const contradictionDetector_js_1 = require("./contradictionDetector.js");
/**
 * Runs the decision engine: evaluates scores and mode for semantic contradictions.
 * Does not alter scoring logic — purely additive contradiction layer.
 */
function runDecisionEngine(input) {
    const { riskScore, confidenceScore, mode } = input;
    const contradictionFlags = (0, contradictionDetector_js_1.detectContradictions)(riskScore, confidenceScore, mode);
    return {
        riskScore,
        confidenceScore,
        mode,
        contradictionFlags,
    };
}
//# sourceMappingURL=decisionEngine.js.map