"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDecisionAuditSnapshot = buildDecisionAuditSnapshot;
const decisionReasonCodeMeta_js_1 = require("./decision/decisionReasonCodeMeta.js");
function buildDecisionAuditSnapshot(result) {
    const reasonCodes = result.reasonCodes ?? [];
    return {
        mode: result.decision.mode,
        confidenceScore: result.decision.confidenceScore,
        riskScore: result.risk.score,
        reasonCodes,
        reasonDetails: (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)([...reasonCodes]),
        triggeredBy: result.trace?.decisionFactors.triggeredBy ?? [],
        confidenceFormula: result.trace?.confidenceFormula ?? "",
        topRiskSummaries: result.topRisks.map((risk) => `[${risk.severity}] ${risk.title}`)
    };
}
//# sourceMappingURL=buildDecisionAuditSnapshot.js.map