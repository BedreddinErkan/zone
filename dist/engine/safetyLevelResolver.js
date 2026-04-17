"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSafetyLevel = resolveSafetyLevel;
const HIGH_RISK_THRESHOLD = 71;
const PREVIEW_QUALITY_THRESHOLD = 60;
const REVIEW_QUALITY_THRESHOLD = 85;
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 85;
function resolveSafetyLevel(input) {
    const safetyReasons = [];
    const riskScore = input.developerRiskScore ?? 0;
    const qualityScore = input.patchQuality?.qualityScore ?? 100;
    if (input.hasBlockedPatch) {
        safetyReasons.push("Patch validation produced a blocking result.");
        return {
            safetyLevel: "high_risk_blocked",
            safetyReasons,
        };
    }
    if (riskScore >= HIGH_RISK_THRESHOLD) {
        safetyReasons.push("Risk score exceeded the high-risk threshold.");
        return {
            safetyLevel: "high_risk_blocked",
            safetyReasons,
        };
    }
    if (input.intentMismatch?.hasMismatch &&
        (input.intentMismatch.severity === "medium" ||
            input.intentMismatch.severity === "high")) {
        safetyReasons.push("Intent mismatch requires manual preview.");
        return {
            safetyLevel: "preview_only",
            safetyReasons,
            confidenceAdjusted: Math.min(input.developerConfidence, 70),
        };
    }
    if (input.decisionMode === "preview_only" ||
        qualityScore < PREVIEW_QUALITY_THRESHOLD ||
        input.developerConfidence < 70) {
        if (qualityScore < PREVIEW_QUALITY_THRESHOLD) {
            safetyReasons.push("Patch quality score is below the preview threshold.");
        }
        else {
            safetyReasons.push("Current decision engine requires preview.");
        }
        return {
            safetyLevel: "preview_only",
            safetyReasons,
            confidenceAdjusted: input.developerConfidence,
        };
    }
    if ((input.intentMismatch?.hasMismatch &&
        input.intentMismatch.severity === "low") ||
        qualityScore < REVIEW_QUALITY_THRESHOLD ||
        riskScore > 20) {
        if (input.intentMismatch?.severity === "low") {
            safetyReasons.push("Low-severity intent mismatch suggests review.");
        }
        if (qualityScore < REVIEW_QUALITY_THRESHOLD) {
            safetyReasons.push("Patch quality suggests a human review pass.");
        }
        if (riskScore > 0) {
            safetyReasons.push("Non-zero risk score keeps the patch reviewable.");
        }
        return {
            safetyLevel: "safe_with_review",
            safetyReasons: [...new Set(safetyReasons)],
            confidenceAdjusted: input.developerConfidence,
        };
    }
    if (input.developerConfidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
        safetyReasons.push("High confidence, low risk, and strong quality allow auto-apply.");
        return {
            safetyLevel: "safe_auto_apply",
            safetyReasons,
            confidenceAdjusted: input.developerConfidence,
        };
    }
    safetyReasons.push("Patch is safe but still benefits from review.");
    return {
        safetyLevel: "safe_with_review",
        safetyReasons,
        confidenceAdjusted: input.developerConfidence,
    };
}
//# sourceMappingURL=safetyLevelResolver.js.map