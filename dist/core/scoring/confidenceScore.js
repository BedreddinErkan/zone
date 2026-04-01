"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeConfidenceScore = computeConfidenceScore;
const computeConfidenceBreakdown_js_1 = require("./computeConfidenceBreakdown.js");
function computeConfidenceScore(input) {
    return (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)(input).finalScore;
}
//# sourceMappingURL=confidenceScore.js.map