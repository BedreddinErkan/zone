"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreSemanticRisk = scoreSemanticRisk;
const severityScores = {
    low: 10,
    medium: 40,
    high: 70,
    critical: 100,
};
const severityOrder = [
    "low",
    "medium",
    "high",
    "critical",
];
function scoreSemanticRisk(risks) {
    const countsBySeverity = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
    };
    let totalScore = 0;
    let highestSeverity = "low";
    for (const risk of risks) {
        countsBySeverity[risk.severity] += 1;
        totalScore += severityScores[risk.severity];
        if (severityOrder.indexOf(risk.severity) >
            severityOrder.indexOf(highestSeverity)) {
            highestSeverity = risk.severity;
        }
    }
    return {
        totalScore,
        highestSeverity,
        countsBySeverity,
    };
}
//# sourceMappingURL=scoreSemanticRisk.js.map