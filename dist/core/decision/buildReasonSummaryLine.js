"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildReasonSummaryLine = buildReasonSummaryLine;
const decisionReasonCodeMeta_js_1 = require("./decisionReasonCodeMeta.js");
function buildReasonSummaryLine(reasonCodes) {
    const uniqueCodes = [...new Set(reasonCodes)];
    if (uniqueCodes.length === 0) {
        return "Why: no explicit decision reasons.";
    }
    const details = (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)([...uniqueCodes]).filter((detail) => Boolean(detail));
    if (details.length === 0) {
        return "Why: no explicit decision reasons.";
    }
    const summaries = details.map((detail) => normalizeSummary(detail.summary));
    return `Why: ${summaries.join("; ")}.`;
}
function normalizeSummary(summary) {
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
        return "unspecified reason";
    }
    return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}
//# sourceMappingURL=buildReasonSummaryLine.js.map