"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeConfidenceScore = computeConfidenceScore;
function clamp(value) {
    if (value < 0)
        return 0;
    if (value > 100)
        return 100;
    return value;
}
function toPenalty(value) {
    return value > 0 ? -value : 0;
}
function toBonus(value) {
    return value < 0 ? Math.abs(value) : 0;
}
function computeConfidenceScore(input) {
    const breakdown = {
        base: 100,
        destructivePenalty: toPenalty(input.breakdown.destructive),
        schemaPenalty: toPenalty(input.breakdown.schema),
        criticalPenalty: toPenalty(input.breakdown.critical),
        massScopePenalty: toPenalty(input.breakdown.massScope),
        lowRiskBonus: toBonus(input.breakdown.lowRisk)
    };
    const score = clamp(breakdown.base +
        breakdown.destructivePenalty +
        breakdown.schemaPenalty +
        breakdown.criticalPenalty +
        breakdown.massScopePenalty +
        breakdown.lowRiskBonus);
    return {
        score,
        breakdown
    };
}
//# sourceMappingURL=computeConfidenceScore.js.map