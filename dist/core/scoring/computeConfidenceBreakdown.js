"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeConfidenceBreakdown = computeConfidenceBreakdown;
const confidenceRules_js_1 = require("./confidenceRules.js");
function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function normalizeConfidence(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return clampNumber(Math.round(value), 0, 100);
}
function buildBandPenalty(params) {
    const normalizedValue = normalizeConfidence(params.value);
    const matchedBand = params.bands.find((band) => normalizedValue < band.maxExclusive);
    if (!matchedBand) {
        return [];
    }
    return [
        {
            key: params.key,
            label: matchedBand.label,
            impact: matchedBand.impact,
            severity: matchedBand.severity,
            reason: `${params.confidenceType} confidence is ${normalizedValue}, which falls below the safe threshold.`,
        },
    ];
}
function buildMissingValidatedFilesPenalty(hasValidatedFiles) {
    if (hasValidatedFiles) {
        return [];
    }
    return [
        {
            key: "missing_validated_files",
            label: confidenceRules_js_1.CONFIDENCE_RULES.missingValidatedFilesPenalty.label,
            impact: confidenceRules_js_1.CONFIDENCE_RULES.missingValidatedFilesPenalty.impact,
            severity: confidenceRules_js_1.CONFIDENCE_RULES.missingValidatedFilesPenalty.severity,
            reason: "No validated files were identified, so patch targeting confidence is reduced.",
        },
    ];
}
function buildRepeatedWarningPenalty(params) {
    if (params.warnings.length === 0) {
        return [];
    }
    const rawPenalty = params.warnings.length * params.penaltyPerItem;
    const finalPenalty = Math.max(rawPenalty, params.penaltyCap);
    return [
        {
            key: params.key,
            label: params.label,
            impact: finalPenalty,
            severity: "warning",
            reason: `${params.reasonPrefix}: ${params.warnings.join("; ")}`,
        },
    ];
}
function buildValidationErrorPenalty(validationErrors, role) {
    if (validationErrors.length === 0) {
        return [];
    }
    const multiplier = role
        ? confidenceRules_js_1.CONFIDENCE_RULES.roleValidationErrorMultipliers[role]
        : 1.0;
    const rawPenalty = validationErrors.length *
        confidenceRules_js_1.CONFIDENCE_RULES.validationErrorPenaltyPerItem *
        multiplier;
    const finalPenalty = Math.max(rawPenalty, confidenceRules_js_1.CONFIDENCE_RULES.validationErrorPenaltyCap);
    return [
        {
            key: "validation_errors",
            label: "Validation errors detected",
            impact: finalPenalty,
            severity: "critical",
            reason: `Validation errors reduce execution confidence: ${validationErrors.join("; ")}`,
        },
    ];
}
function computeConfidenceBreakdown(input) {
    const architectureWarnings = input.architectureWarnings ?? [];
    const patchRiskWarnings = input.patchRiskWarnings ?? [];
    const validationErrors = input.validationErrors ?? [];
    const factors = [
        ...buildBandPenalty({
            key: "schema_confidence",
            value: input.schemaConfidence,
            bands: confidenceRules_js_1.CONFIDENCE_RULES.schemaPenaltyBands,
            confidenceType: "schema",
        }),
        ...buildBandPenalty({
            key: "storage_confidence",
            value: input.storageConfidence,
            bands: confidenceRules_js_1.CONFIDENCE_RULES.storagePenaltyBands,
            confidenceType: "storage",
        }),
        ...buildMissingValidatedFilesPenalty(input.hasValidatedFiles),
        ...buildRepeatedWarningPenalty({
            key: "architecture_warnings",
            label: "Architecture warnings detected",
            warnings: architectureWarnings,
            penaltyPerItem: confidenceRules_js_1.CONFIDENCE_RULES.architectureWarningPenaltyPerItem,
            penaltyCap: confidenceRules_js_1.CONFIDENCE_RULES.architectureWarningPenaltyCap,
            reasonPrefix: "Architecture concerns identified",
        }),
        ...buildRepeatedWarningPenalty({
            key: "patch_risk_warnings",
            label: "Patch risk warnings detected",
            warnings: patchRiskWarnings,
            penaltyPerItem: confidenceRules_js_1.CONFIDENCE_RULES.patchRiskWarningPenaltyPerItem,
            penaltyCap: confidenceRules_js_1.CONFIDENCE_RULES.patchRiskWarningPenaltyCap,
            reasonPrefix: "Patch risk concerns identified",
        }),
        ...buildValidationErrorPenalty(validationErrors, input.role),
    ];
    const totalPenalty = factors
        .filter((factor) => factor.impact < 0)
        .reduce((sum, factor) => sum + Math.abs(factor.impact), 0);
    const totalBonus = factors
        .filter((factor) => factor.impact > 0)
        .reduce((sum, factor) => sum + factor.impact, 0);
    const finalScore = clampNumber(confidenceRules_js_1.CONFIDENCE_RULES.baseScore - totalPenalty + totalBonus, 0, 100);
    return {
        baseScore: confidenceRules_js_1.CONFIDENCE_RULES.baseScore,
        finalScore,
        factors,
        summary: {
            totalPenalty,
            totalBonus,
            hasCriticalRisk: factors.some((factor) => factor.severity === "critical"),
        },
    };
}
//# sourceMappingURL=computeConfidenceBreakdown.js.map