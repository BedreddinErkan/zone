"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildRecommendation_js_1 = require("./buildRecommendation.js");
function makeBaseDecision() {
    return {
        mode: "preview_only",
        confidenceScore: 80,
        reasons: [
            {
                code: "MISSING_VALIDATED_FILES",
                severity: "warning",
                message: "Validated file coverage is incomplete."
            }
        ]
    };
}
function makeHighRisk() {
    return {
        id: "risk:test",
        title: "High risk change",
        description: "Potential dangerous change",
        severity: "high",
        score: 90,
        category: "patch",
        source: "derived"
    };
}
(0, vitest_1.describe)("topRisks contract behavior", () => {
    (0, vitest_1.it)("falls back to patch-scope recommendation when topRisks is undefined", () => {
        const decision = makeBaseDecision();
        const recommendation = (0, buildRecommendation_js_1.buildRecommendation)(decision);
        (0, vitest_1.expect)(recommendation).toBe("Preview the patch and review patch scope before any apply step.");
    });
    (0, vitest_1.it)("switches to high-risk recommendation when high severity topRisk exists", () => {
        const decision = {
            ...makeBaseDecision(),
            topRisks: [makeHighRisk()]
        };
        const recommendation = (0, buildRecommendation_js_1.buildRecommendation)(decision);
        (0, vitest_1.expect)(recommendation).toBe("Preview the patch and complete manual review before any apply step because high-severity risks are still present.");
    });
});
//# sourceMappingURL=topRisksContract.test.js.map