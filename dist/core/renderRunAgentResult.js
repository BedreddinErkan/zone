"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderRunAgentResult = renderRunAgentResult;
const decisionReasonCodeMeta_js_1 = require("./decision/decisionReasonCodeMeta.js");
function renderRunAgentResult(input, options = {}) {
    const lines = [];
    const reasonCodes = input.reasonCodes ?? [];
    const { verbose = false } = options;
    lines.push("=== ZONE ===");
    lines.push(`Task: ${input.task}`);
    lines.push(`Decision: ${input.decision.mode}`);
    lines.push(`Confidence: ${input.decision.confidenceScore}`);
    lines.push(`Explanation: ${input.explanation}`);
    lines.push(`Recommendation: ${input.recommendation}`);
    if (reasonCodes.length > 0) {
        lines.push("");
        lines.push("Reason Codes:");
        for (const code of reasonCodes) {
            lines.push(`- ${code}`);
        }
        if (verbose) {
            const reasonDetails = (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)([...reasonCodes]);
            lines.push("");
            lines.push("Reason Details:");
            for (const detail of reasonDetails) {
                lines.push(`- ${detail.label} [${detail.severity}/${detail.category}]`);
                lines.push(`  code: ${detail.code}`);
                lines.push(`  summary: ${detail.summary}`);
            }
        }
    }
    if (verbose && input.auditSnapshot) {
        lines.push("");
        lines.push("Audit Summary:");
        lines.push(`- triggered by: ${input.auditSnapshot.triggeredBy.join(", ") || "none"}`);
        lines.push(`- confidence formula: ${input.auditSnapshot.confidenceFormula || "n/a"}`);
        if (input.auditSnapshot.reasonDetails.length > 0) {
            lines.push("- audit reasons:");
            for (const detail of input.auditSnapshot.reasonDetails) {
                lines.push(`  - ${detail.label}`);
            }
        }
    }
    if (input.risk) {
        lines.push("");
        lines.push("=== RISK ===");
        lines.push(`${input.risk.score}/100`);
        lines.push("=== RISK BREAKDOWN ===");
        lines.push(`- destructive: ${input.risk.breakdown.destructive}`);
        lines.push(`- schema: ${input.risk.breakdown.schema}`);
        lines.push(`- critical: ${input.risk.breakdown.critical}`);
        lines.push(`- low-risk: ${input.risk.breakdown.lowRisk}`);
        lines.push(`- mass-scope: ${input.risk.breakdown.massScope}`);
    }
    if (input.confidence) {
        lines.push("");
        lines.push("=== CONFIDENCE BREAKDOWN ===");
        lines.push(`- base: ${input.confidence.breakdown.base}`);
        lines.push(`- destructive penalty: ${input.confidence.breakdown.destructivePenalty}`);
        lines.push(`- schema penalty: ${input.confidence.breakdown.schemaPenalty}`);
        lines.push(`- critical penalty: ${input.confidence.breakdown.criticalPenalty}`);
        lines.push(`- mass-scope penalty: ${input.confidence.breakdown.massScopePenalty}`);
        lines.push(`- low-risk bonus: ${input.confidence.breakdown.lowRiskBonus}`);
    }
    lines.push("");
    lines.push("Top Risks:");
    if (input.topRisks.length === 0) {
        lines.push("- none");
    }
    else {
        for (const risk of input.topRisks) {
            lines.push(`- [${risk.severity}] ${risk.title}: ${risk.reason}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=renderRunAgentResult.js.map