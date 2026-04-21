"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluatePlanAlignment = evaluatePlanAlignment;
function normalizePath(value) {
    return value.trim().replace(/\\/g, "/").toLowerCase();
}
function isLikelyTargetedScope(scopeSummary) {
    const summary = scopeSummary.toLowerCase();
    return /\b(targeted|localized|specific|single[- ]file|minimal|small|narrow|only)\b/.test(summary);
}
function clampScore(score) {
    return Math.max(0, Math.min(100, score));
}
function evaluatePlanAlignment(input) {
    const plannedFiles = new Set(input.plan.steps
        .flatMap((step) => step.filesLikely)
        .map(normalizePath)
        .filter(Boolean));
    const changedFiles = [
        ...new Set(input.changedFiles.map((filePath) => filePath.trim()).filter(Boolean)),
    ];
    const outOfPlanFiles = [];
    const inPlanFiles = [];
    let score = 100;
    for (const filePath of changedFiles) {
        if (plannedFiles.has(normalizePath(filePath))) {
            inPlanFiles.push(filePath);
        }
        else {
            outOfPlanFiles.push(filePath);
            score -= 20;
        }
    }
    const scopeMismatch = isLikelyTargetedScope(input.plan.scopeSummary) &&
        (changedFiles.length > 2 || (input.massScopeScore ?? 0) >= 40);
    if (scopeMismatch) {
        score -= 20;
    }
    const clampedScore = clampScore(score);
    return {
        score: clampedScore,
        outOfPlanFiles,
        inPlanFiles,
        scopeMismatch,
        ...(clampedScore < 70
            ? { warning: "Generated patch drifted beyond the execution plan." }
            : {}),
    };
}
//# sourceMappingURL=evaluatePlanAlignment.js.map