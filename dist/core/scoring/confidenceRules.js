"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIDENCE_RULES = void 0;
exports.CONFIDENCE_RULES = {
    baseScore: 100,
    schemaPenaltyBands: [
        {
            maxExclusive: 40,
            impact: -30,
            severity: "critical",
            label: "Schema confidence very low",
        },
        {
            maxExclusive: 60,
            impact: -18,
            severity: "warning",
            label: "Schema confidence low",
        },
        {
            maxExclusive: 75,
            impact: -10,
            severity: "warning",
            label: "Schema confidence slightly below safe threshold",
        },
    ],
    storagePenaltyBands: [
        {
            maxExclusive: 40,
            impact: -25,
            severity: "critical",
            label: "Storage confidence very low",
        },
        {
            maxExclusive: 60,
            impact: -15,
            severity: "warning",
            label: "Storage confidence low",
        },
        {
            maxExclusive: 75,
            impact: -8,
            severity: "warning",
            label: "Storage confidence slightly below safe threshold",
        },
    ],
    missingValidatedFilesPenalty: {
        impact: -20,
        severity: "warning",
        label: "No validated files found",
    },
    architectureWarningPenaltyPerItem: -6,
    architectureWarningPenaltyCap: -18,
    patchRiskWarningPenaltyPerItem: -8,
    patchRiskWarningPenaltyCap: -24,
    validationErrorPenaltyPerItem: -40,
    validationErrorPenaltyCap: -80,
    roleValidationErrorMultipliers: {
        data_analyst: 1.5,
        developer: 1.0,
        test_engineer: 0.7,
    },
};
//# sourceMappingURL=confidenceRules.js.map