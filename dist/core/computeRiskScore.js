"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRiskScore = computeRiskScore;
const computeRiskScoreDetails_js_1 = require("./computeRiskScoreDetails.js");
function computeRiskScore(input) {
    const task = typeof input === "string" ? input : input.task;
    const role = typeof input === "string" ? undefined : input.role;
    const details = (0, computeRiskScoreDetails_js_1.computeRiskScoreDetails)({ task });
    // Role-aware schema penalty adjustment:
    // test_engineer: writing tests is not a schema risk
    // data_analyst: schema changes are expected, handled separately
    const schemaScore = role === "test_engineer" || role === "data_analyst" || role === "developer"
        ? 0
        : details.riskBreakdown.schema;
    const signals = [];
    if (details.riskBreakdown.destructive > 0)
        signals.push("destructive");
    if (schemaScore > 0)
        signals.push("schema");
    if (details.riskBreakdown.critical > 0)
        signals.push("critical_domain");
    if (details.riskBreakdown.lowRisk < 0)
        signals.push("low_risk");
    if (details.riskBreakdown.massScope > 0)
        signals.push("mass_scope");
    const adjustedScore = Math.max(0, Math.min(100, details.riskBreakdown.destructive +
        schemaScore +
        details.riskBreakdown.critical +
        details.riskBreakdown.lowRisk +
        details.riskBreakdown.massScope));
    return {
        score: adjustedScore,
        signals,
        breakdown: {
            destructive: details.riskBreakdown.destructive,
            schema: schemaScore,
            critical: details.riskBreakdown.critical,
            lowRisk: details.riskBreakdown.lowRisk,
            massScope: details.riskBreakdown.massScope,
        },
    };
}
//# sourceMappingURL=computeRiskScore.js.map