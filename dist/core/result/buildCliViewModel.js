"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCliViewModel = buildCliViewModel;
function toDecisionLabel(mode) {
    switch (mode) {
        case "blocked":
            return "BLOCKED";
        case "preview":
            return "PREVIEW ONLY";
        case "apply":
            return "SAFE TO APPLY";
    }
}
function normalizeIssue(issue) {
    if (issue.severity === "error") {
        return {
            code: issue.code,
            severity: "error",
            message: issue.message
        };
    }
    if (issue.severity === "warning" || issue.severity === "info") {
        return {
            code: issue.code,
            severity: "warning",
            message: issue.message
        };
    }
    return null;
}
function toCliRiskSeverity(severity) {
    switch (severity) {
        case "high":
            return "HIGH";
        case "medium":
            return "MEDIUM";
        case "low":
            return "LOW";
    }
}
function buildCliViewModel(result) {
    const groupedIssues = (result.issues?.grouped ?? []).map((group) => {
        const issues = group.issues
            .map(normalizeIssue)
            .filter((item) => item !== null);
        return {
            label: group.label,
            errors: group.errors,
            warnings: group.warnings,
            issues
        };
    });
    const notes = [
        ...result.notes.execution,
        ...result.notes.assumptions,
        ...result.notes.followUps
    ];
    return {
        decisionMode: result.decision.mode,
        decisionLabel: toDecisionLabel(result.decision.mode),
        statusLine: result.statusLine ??
            `STATUS: ${result.decision.mode.toUpperCase()} | confidence=${result.decision.confidence}`,
        confidenceScore: result.confidenceBreakdown?.finalScore ?? result.decision.confidence,
        errorCount: result.issues?.summary.errors ?? 0,
        warningCount: result.issues?.summary.warnings ?? 0,
        recommendation: result.decision.recommendation ?? result.decision.reason,
        notes,
        topRisks: (result.issues?.topRisks ?? []).map((risk) => ({
            title: risk.title,
            severity: toCliRiskSeverity(risk.severity),
            score: risk.score,
            description: risk.description,
            category: risk.category
        })),
        groupedIssues,
        rawResult: result
    };
}
//# sourceMappingURL=buildCliViewModel.js.map