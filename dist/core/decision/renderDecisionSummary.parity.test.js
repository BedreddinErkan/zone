"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderDecisionSummary_js_1 = require("./renderDecisionSummary.js");
const buildRecommendation_js_1 = require("./buildRecommendation.js");
(0, vitest_1.describe)("renderDecisionSummary recommendation parity", () => {
    (0, vitest_1.it)("uses the same recommendation wording as buildRecommendation for preview_only patch-scope flow", () => {
        const result = {
            mode: "preview_only",
            confidenceScore: 84,
            reasons: [
                {
                    code: "MISSING_VALIDATED_FILES",
                    severity: "warning",
                    message: "Validated file coverage is incomplete."
                }
            ],
            topRisks: []
        };
        const expectedRecommendation = (0, buildRecommendation_js_1.buildRecommendation)(result);
        const rendered = (0, renderDecisionSummary_js_1.renderDecisionSummary)(result);
        (0, vitest_1.expect)(expectedRecommendation).toBe("Preview the patch and review patch scope before any apply step.");
        (0, vitest_1.expect)(rendered).toContain("Recommendation:");
        (0, vitest_1.expect)(rendered).toContain(expectedRecommendation);
    });
});
//# sourceMappingURL=renderDecisionSummary.parity.test.js.map