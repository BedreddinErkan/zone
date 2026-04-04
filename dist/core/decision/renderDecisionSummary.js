"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderDecisionSummary = renderDecisionSummary;
exports.renderSavedAgentResultSummary = renderSavedAgentResultSummary;
const buildDecisionExplanation_js_1 = require("./buildDecisionExplanation.js");
const buildSavedRecommendation_js_1 = require("../result/buildSavedRecommendation.js");
const buildRecommendation_js_1 = require("./buildRecommendation.js");
function formatReason(reason) {
    const detailSuffix = reason.details && reason.details.length > 0
        ? ` (${reason.details.join(" | ")})`
        : "";
    const severityLabel = reason.severity === "critical"
        ? "CRITICAL"
        : reason.severity === "warning"
            ? "WARNING"
            : "INFO";
    return `- [${severityLabel}] ${reason.code}: ${reason.message}${detailSuffix}`;
}
function formatRiskSeverity(severity) {
    if (severity === "high")
        return "HIGH";
    if (severity === "medium")
        return "MEDIUM";
    return "LOW";
}
function renderTopRisks(topRisks, limit = 3) {
    if (!topRisks || topRisks.length === 0) {
        return [];
    }
    const lines = [];
    lines.push("");
    lines.push("Top Risks:");
    for (const risk of topRisks.slice(0, limit)) {
        lines.push(`- [${formatRiskSeverity(risk.severity)}] ${risk.title}`);
    }
    return lines;
}
function renderDecisionSummary(result) {
    const lines = [];
    lines.push("=== EXECUTION DECISION ===");
    lines.push(`Mode: ${result.mode}`);
    lines.push(`Confidence Score: ${result.confidenceScore}`);
    lines.push("");
    lines.push("Reasons:");
    if (result.reasons.length === 0) {
        lines.push("- No explicit reasons recorded.");
    }
    else {
        for (const reason of result.reasons) {
            lines.push(formatReason(reason));
        }
    }
    lines.push(...renderTopRisks(result.topRisks));
    lines.push("");
    lines.push("Explanation:");
    lines.push((0, buildDecisionExplanation_js_1.buildDecisionExplanation)(result));
    lines.push("");
    lines.push("Recommendation:");
    lines.push((0, buildRecommendation_js_1.buildRecommendation)(result));
    return lines.join("\n");
}
function formatIssueSeverity(severity) {
    if (severity === "error")
        return "ERROR";
    if (severity === "warning")
        return "WARNING";
    return "INFO";
}
function renderSavedAgentResultSummary(result) {
    const lines = [];
    lines.push("=== AGENT DECISION ===");
    lines.push(`Mode: ${result.decision.mode}`);
    const confidenceLevel = result.confidenceBreakdown?.level
        ? ` (${result.confidenceBreakdown.level})`
        : "";
    lines.push(`Confidence: ${result.decision.confidence}/100${confidenceLevel}`);
    lines.push("");
    lines.push("Recommendation:");
    lines.push((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result));
    if (result.issues?.topRisks?.length) {
        lines.push("");
        lines.push("Top Risks:");
        for (const risk of result.issues.topRisks.slice(0, 5)) {
            const meta = risk.category && risk.relatedCode
                ? ` (${risk.category} / ${risk.relatedCode})`
                : risk.category
                    ? ` (${risk.category})`
                    : risk.relatedCode
                        ? ` (${risk.relatedCode})`
                        : "";
            lines.push(`- [${formatRiskSeverity(risk.severity)} | score=${risk.score}] ${risk.title}${meta}`);
        }
    }
    if (result.issues?.grouped?.length) {
        lines.push("");
        lines.push("Issue Groups:");
        for (const group of result.issues.grouped) {
            lines.push(`- ${group.label}: ${group.errors} error, ${group.warnings} warning`);
        }
    }
    if (result.issues?.summary) {
        lines.push("");
        lines.push("Summary:");
        lines.push(`- Total: ${result.issues.summary.total} issue(s)`);
        lines.push(`- Errors: ${result.issues.summary.errors}`);
        lines.push(`- Warnings: ${result.issues.summary.warnings}`);
    }
    if (result.statusLine) {
        lines.push("");
        lines.push("Status:");
        lines.push(result.statusLine);
    }
    return lines.join("\n");
}
//# sourceMappingURL=renderDecisionSummary.js.map