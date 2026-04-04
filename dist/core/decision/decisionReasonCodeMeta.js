"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECISION_REASON_CODE_META = void 0;
exports.getDecisionReasonCodeMeta = getDecisionReasonCodeMeta;
exports.buildDecisionReasonDetails = buildDecisionReasonDetails;
exports.DECISION_REASON_CODE_META = {
    BLOCKED_DESTRUCTIVE_OPERATION: {
        code: "BLOCKED_DESTRUCTIVE_OPERATION",
        label: "Destructive operation detected",
        summary: "Task includes destructive intent and should not be auto-applied.",
        severity: "high",
        category: "safety"
    },
    BLOCKED_SCHEMA_RISK: {
        code: "BLOCKED_SCHEMA_RISK",
        label: "Schema risk detected",
        summary: "Task touches schema-sensitive areas and may break existing contracts.",
        severity: "high",
        category: "risk"
    },
    BLOCKED_CRITICAL_RISK: {
        code: "BLOCKED_CRITICAL_RISK",
        label: "Critical domain risk detected",
        summary: "Task affects a critical domain and requires manual review before apply.",
        severity: "high",
        category: "risk"
    },
    BLOCKED_HIGH_RISK_SCORE: {
        code: "BLOCKED_HIGH_RISK_SCORE",
        label: "High risk threshold exceeded",
        summary: "Overall risk score exceeded the blocked threshold for auto-apply.",
        severity: "high",
        category: "risk"
    },
    PREVIEW_DESTRUCTIVE_SIGNAL: {
        code: "PREVIEW_DESTRUCTIVE_SIGNAL",
        label: "Destructive signal detected",
        summary: "Task contains destructive indicators and should be previewed carefully.",
        severity: "high",
        category: "safety"
    },
    PREVIEW_SCHEMA_UNCERTAINTY: {
        code: "PREVIEW_SCHEMA_UNCERTAINTY",
        label: "Schema uncertainty detected",
        summary: "Task appears schema-related and should be verified before applying.",
        severity: "medium",
        category: "risk"
    },
    PREVIEW_CRITICAL_SIGNAL: {
        code: "PREVIEW_CRITICAL_SIGNAL",
        label: "Critical signal detected",
        summary: "Task touches a critical area and should remain in preview mode.",
        severity: "medium",
        category: "risk"
    },
    PREVIEW_MASS_SCOPE_CHANGE: {
        code: "PREVIEW_MASS_SCOPE_CHANGE",
        label: "Mass-scope change detected",
        summary: "Task appears to affect many records or a broad surface area.",
        severity: "high",
        category: "scope"
    },
    PREVIEW_LOW_CONFIDENCE: {
        code: "PREVIEW_LOW_CONFIDENCE",
        label: "Low confidence score",
        summary: "Confidence score is below the safe threshold, so preview is safer.",
        severity: "medium",
        category: "confidence"
    },
    SAFE_LOW_RISK_LOCALIZED: {
        code: "SAFE_LOW_RISK_LOCALIZED",
        label: "Localized low-risk task",
        summary: "Task appears narrowly scoped and low risk for automatic application.",
        severity: "low",
        category: "safety"
    },
    SAFE_HIGH_CONFIDENCE: {
        code: "SAFE_HIGH_CONFIDENCE",
        label: "High confidence score",
        summary: "Confidence score is strong enough to support safe auto-apply.",
        severity: "low",
        category: "confidence"
    }
};
function getDecisionReasonCodeMeta(code) {
    return exports.DECISION_REASON_CODE_META[code];
}
function buildDecisionReasonDetails(codes) {
    return codes.map((code) => getDecisionReasonCodeMeta(code));
}
//# sourceMappingURL=decisionReasonCodeMeta.js.map