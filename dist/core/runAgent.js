"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTopRisks = buildTopRisks;
exports.runAgent = runAgent;
exports.buildPrimaryCause = buildPrimaryCause;
exports.buildConfidenceImpactLine = buildConfidenceImpactLine;
const computeRiskScore_js_1 = require("./computeRiskScore.js");
const normalizeSignals_js_1 = require("./normalizeSignals.js");
const computeConfidenceScore_js_1 = require("./scoring/computeConfidenceScore.js");
const buildDecisionTrace_js_1 = require("./buildDecisionTrace.js");
const buildDecisionReasonCodes_js_1 = require("./decision/buildDecisionReasonCodes.js");
const buildDecisionExplanation_js_1 = require("./decision/buildDecisionExplanation.js");
const decisionReasonCodeMeta_js_1 = require("./decision/decisionReasonCodeMeta.js");
function mapScoreToMode(score, signals) {
    if (score >= 71) {
        return "blocked";
    }
    if (score >= 31 ||
        signals.includes("schema") ||
        signals.includes("critical_domain") ||
        signals.includes("mass_scope")) {
        return "preview_only";
    }
    return "safe_to_apply";
}
function toRiskSeverity(value) {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }
    return "medium";
}
function buildRecommendation(mode) {
    switch (mode) {
        case "blocked":
            return "Do not auto-apply. Manual review is required before making changes.";
        case "preview_only":
            return "Preview the patch and verify the affected scope before any apply step.";
        case "safe_to_apply":
        default:
            return "Patch can be applied automatically under current safeguards.";
    }
}
function mapNormalizedSignalTypeForReasonCodes(type) {
    switch (type) {
        case "destructive":
            return "destructive";
        case "schema":
            return "schema";
        case "critical_domain":
            return "critical";
        case "low_risk":
            return "lowRisk";
        case "mass_scope":
            return "massScope";
        default:
            return null;
    }
}
function mapReasonSeverityForExplanation(severity) {
    switch (severity) {
        case "high":
            return "critical";
        case "medium":
            return "warning";
        case "low":
        default:
            return "info";
    }
}
function buildTopRisks(_score, signals) {
    const normalized = (0, normalizeSignals_js_1.normalizeSignals)(signals);
    const risks = [];
    for (const signal of normalized) {
        if (signal.type === "destructive") {
            risks.push({
                title: signal.label,
                severity: toRiskSeverity(signal.severity),
                reason: "Task contains destructive keywords that may cause irreversible data loss."
            });
        }
        if (signal.type === "schema") {
            risks.push({
                title: signal.label,
                severity: toRiskSeverity(signal.severity),
                reason: "Schema modifications can break existing data contracts or migrations."
            });
        }
        if (signal.type === "critical_domain") {
            risks.push({
                title: signal.label,
                severity: toRiskSeverity(signal.severity),
                reason: "Touches auth, billing, or production — elevated impact if change is incorrect."
            });
        }
        if (signal.type === "mass_scope") {
            risks.push({
                title: signal.label,
                severity: toRiskSeverity(signal.severity),
                reason: "Task targets all records or the entire dataset — bulk operations are irreversible."
            });
        }
    }
    return risks;
}
async function runAgent(input) {
    const normalizedTask = input.task.trim();
    const { score, signals, breakdown } = (0, computeRiskScore_js_1.computeRiskScore)({
        task: normalizedTask,
        role: input.role,
    });
    const mode = mapScoreToMode(score, signals);
    const confidence = (0, computeConfidenceScore_js_1.computeConfidenceScore)({ breakdown });
    const reasonCodes = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
        mode,
        riskScore: score,
        confidenceScore: confidence.score,
        normalizedSignals: (0, normalizeSignals_js_1.normalizeSignals)(signals)
            .map((signal) => mapNormalizedSignalTypeForReasonCodes(signal.type))
            .filter((type) => type !== null)
            .map((type) => ({ type }))
    });
    const reasonDetails = (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)(reasonCodes);
    const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
        signals,
        riskScore: score,
        confidenceScore: confidence.score,
        confidenceBreakdown: confidence.breakdown,
        mode,
        reasonDetails: reasonDetails.map((reason) => ({
            code: reason.code,
            severity: mapReasonSeverityForExplanation(reason.severity),
            category: reason.category,
            message: reason.summary
        }))
    });
    const explanationReasons = reasonDetails.map((reason) => ({
        code: reason.code,
        severity: mapReasonSeverityForExplanation(reason.severity),
        category: reason.category,
        message: reason.summary
    }));
    const result = {
        task: normalizedTask,
        decision: {
            mode,
            confidenceScore: confidence.score
        },
        risk: {
            score,
            breakdown: {
                destructive: breakdown.destructive,
                schema: breakdown.schema,
                critical: breakdown.critical,
                lowRisk: breakdown.lowRisk,
                massScope: breakdown.massScope
            }
        },
        confidence,
        recommendation: buildRecommendation(mode),
        topRisks: buildTopRisks(score, signals),
        trace,
        reasonCodes
    };
    return {
        ...result,
        explanation: (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode,
            confidenceScore: confidence.score,
            reasons: explanationReasons
        }, { reasonCodes: reasonCodes })
    };
}
function buildPrimaryCause(signals) {
    if (signals.includes("destructive"))
        return "destructive operation";
    if (signals.includes("schema"))
        return "schema-sensitive change";
    if (signals.includes("critical_domain"))
        return "critical domain access";
    if (signals.includes("mass_scope"))
        return "mass-scope operation";
    return "general task";
}
function buildConfidenceImpactLine(breakdown) {
    const destructivePenalty = breakdown.destructivePenalty ?? 0;
    const schemaPenalty = breakdown.schemaPenalty ?? 0;
    const criticalPenalty = breakdown.criticalPenalty ?? 0;
    const massScopePenalty = breakdown.massScopePenalty ?? 0;
    const lowRiskBonus = breakdown.lowRiskBonus ?? 0;
    const parts = [];
    if (destructivePenalty !== 0) {
        parts.push(`destructive penalty: ${destructivePenalty}`);
    }
    if (schemaPenalty !== 0) {
        parts.push(`schema penalty: ${schemaPenalty}`);
    }
    if (criticalPenalty !== 0) {
        parts.push(`critical penalty: ${criticalPenalty}`);
    }
    if (massScopePenalty !== 0) {
        parts.push(`mass-scope penalty: ${massScopePenalty}`);
    }
    if (lowRiskBonus !== 0) {
        parts.push(`low-risk bonus: +${lowRiskBonus}`);
    }
    if (parts.length === 0)
        return null;
    return parts.join(", ");
}
//# sourceMappingURL=runAgent.js.map