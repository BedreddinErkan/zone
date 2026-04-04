"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDecisionExplanation = buildDecisionExplanation;
const buildReasonSummaryLine_js_1 = require("./buildReasonSummaryLine.js");
function countReasonsBySeverity(reasons) {
    return reasons.reduce((acc, reason) => {
        if (reason.severity === "critical")
            acc.critical += 1;
        else if (reason.severity === "warning")
            acc.warning += 1;
        else
            acc.info += 1;
        return acc;
    }, { critical: 0, warning: 0, info: 0 });
}
function countSeriousRisks(topRisks) {
    if (!topRisks || topRisks.length === 0) {
        return 0;
    }
    return topRisks.filter((risk) => risk.severity === "high" || risk.severity === "medium").length;
}
function buildModeLead(result) {
    switch (result.mode) {
        case "blocked":
            return "Decision was set to BLOCKED because blocking validation signals were detected.";
        case "preview_only":
            return "Decision was set to PREVIEW ONLY because manual review is still required.";
        case "safe_to_apply":
            return "Decision was set to SAFE TO APPLY because no blocking execution risks were detected.";
    }
}
function buildReasonSummary(result) {
    const counts = countReasonsBySeverity(result.reasons);
    const lines = [];
    if (counts.critical > 0) {
        lines.push(`- ${counts.critical} critical reason(s) affected the decision`);
    }
    if (counts.warning > 0) {
        lines.push(`- ${counts.warning} warning-level reason(s) affected the decision`);
    }
    if (counts.info > 0 && result.mode === "safe_to_apply") {
        lines.push(`- ${counts.info} informational confirmation reason(s) were recorded`);
    }
    const seriousRiskCount = countSeriousRisks(result.topRisks);
    if (seriousRiskCount > 0) {
        lines.push(`- ${seriousRiskCount} medium/high top risk(s) remain visible in the result`);
    }
    return lines;
}
function buildClosingLine(result) {
    switch (result.mode) {
        case "blocked":
            return "Automatic apply is not recommended until blocking issues are resolved.";
        case "preview_only":
            return "Automatic apply is not recommended until review is completed.";
        case "safe_to_apply":
            return "Automatic apply can proceed under the current safeguards.";
    }
}
function assertReasonCodeParity(reasons, reasonCodes) {
    if (!reasonCodes || reasonCodes.length === 0) {
        return;
    }
    const reasonSequence = reasons.map((reason) => String(reason.code));
    let searchStartIndex = 0;
    for (const code of reasonCodes) {
        const matchedIndex = reasonSequence.indexOf(String(code), searchStartIndex);
        if (matchedIndex === -1) {
            throw new Error("DECISION_EXPLANATION_REASON_MISMATCH");
        }
        searchStartIndex = matchedIndex + 1;
    }
}
function buildDecisionExplanation(result, options = {}) {
    assertReasonCodeParity(result.reasons, options.reasonCodes);
    const lines = [];
    lines.push(buildModeLead(result));
    if (options.reasonCodes && options.reasonCodes.length > 0) {
        lines.push("");
        lines.push((0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)(options.reasonCodes));
    }
    const summaryLines = buildReasonSummary(result);
    if (summaryLines.length > 0) {
        lines.push("");
        lines.push(...summaryLines);
    }
    lines.push("");
    lines.push(buildClosingLine(result));
    return lines.join("\n");
}
//# sourceMappingURL=buildDecisionExplanation.js.map