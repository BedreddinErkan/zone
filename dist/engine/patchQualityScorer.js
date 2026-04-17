"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scorePatchQuality = scorePatchQuality;
const patchScopeValidator_js_1 = require("./patchScopeValidator.js");
function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}
function scorePatchQuality(input) {
    let patchSizeScore = 100;
    const scopeIntentType = input.taskIntent.codeIntent ??
        (input.taskIntent === "micro_edit" ? "micro_edit" : "unknown");
    let structurePreservationScore = 100;
    let designSystemComplianceScore = 100;
    let semanticAlignmentScore = 100;
    const qualityWarnings = [];
    if (input.patchScope.totalChangedLines > 80) {
        patchSizeScore -= 40;
    }
    else if (input.patchScope.totalChangedLines > 30) {
        patchSizeScore -= 25;
    }
    else if (input.patchScope.totalChangedLines > 15) {
        patchSizeScore -= 12;
    }
    if (input.patchScope.changedFileCount > 3) {
        patchSizeScore -= 18;
    }
    else if (input.patchScope.changedFileCount > 1) {
        patchSizeScore -= 10;
    }
    const scopeResult = (0, patchScopeValidator_js_1.validatePatchScope)(scopeIntentType, input.patchScope.totalChangedLines, input.patchScope.changedFileCount);
    patchSizeScore -= scopeResult.confidencePenalty;
    if (scopeResult.hasHardViolation || scopeResult.hasSoftViolation) {
        qualityWarnings.push(...scopeResult.violations.map((v) => v.message));
    }
    if (input.patchScope.rewriteLikeSuspicion) {
        patchSizeScore -= 25;
        structurePreservationScore -= 45;
        qualityWarnings.push("Patch looks larger than a targeted change.");
    }
    if (input.taskIntent === "micro_edit" && input.patchScope.changedFileCount > 1) {
        structurePreservationScore -= 20;
        qualityWarnings.push("Micro-edit task expanded across multiple files.");
    }
    if (input.patchScope.totalChangedLines > 30) {
        structurePreservationScore -= 15;
    }
    if (input.patchScope.cssRewriteSuspicion) {
        designSystemComplianceScore -= 45;
        qualityWarnings.push("Large CSS/style rewrite may bypass existing design patterns.");
    }
    const validationPenalty = Math.min(20, (input.validationWarnings ?? []).length * 4);
    designSystemComplianceScore -= validationPenalty;
    const inlineStylePenalty = Math.min(18, (input.designSystemSignals?.inlineStyleCount ?? 0) * 4);
    designSystemComplianceScore -= inlineStylePenalty;
    if ((input.designSystemSignals?.inlineStyleCount ?? 0) > 0) {
        qualityWarnings.push("Inline styles detected instead of using existing UI classes");
    }
    if (input.designSystemSignals?.excessiveInlineStyles) {
        designSystemComplianceScore -= 15;
        qualityWarnings.push("Excessive inline style usage reduces design system consistency");
    }
    if (input.designSystemSignals?.reusableClassPreferenceMissed) {
        designSystemComplianceScore -= 12;
        qualityWarnings.push("Patch does not introduce reusable class-based styling");
    }
    if (input.intentMismatch?.hasMismatch) {
        if (input.intentMismatch.severity === "high") {
            semanticAlignmentScore -= 55;
        }
        else if (input.intentMismatch.severity === "medium") {
            semanticAlignmentScore -= 30;
        }
        else if (input.intentMismatch.severity === "low") {
            semanticAlignmentScore -= 15;
        }
        if (input.intentMismatch.warnings.length > 0) {
            qualityWarnings.push(...input.intentMismatch.warnings);
        }
    }
    patchSizeScore = clampScore(patchSizeScore);
    structurePreservationScore = clampScore(structurePreservationScore);
    designSystemComplianceScore = clampScore(designSystemComplianceScore);
    semanticAlignmentScore = clampScore(semanticAlignmentScore);
    const qualityScore = clampScore(patchSizeScore * 0.3 +
        structurePreservationScore * 0.25 +
        designSystemComplianceScore * 0.2 +
        semanticAlignmentScore * 0.25);
    return {
        qualityScore,
        qualityWarnings: [...new Set(qualityWarnings)],
        patchSizeScore,
        structurePreservationScore,
        designSystemComplianceScore,
        semanticAlignmentScore,
    };
}
//# sourceMappingURL=patchQualityScorer.js.map