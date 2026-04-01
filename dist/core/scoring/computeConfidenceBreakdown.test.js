"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const computeConfidenceBreakdown_js_1 = require("./computeConfidenceBreakdown.js");
(0, vitest_1.describe)("computeConfidenceBreakdown", () => {
    (0, vitest_1.it)("returns full score when all signals are healthy", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 92,
            storageConfidence: 88,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.baseScore).toBe(100);
        (0, vitest_1.expect)(result.finalScore).toBe(100);
        (0, vitest_1.expect)(result.factors).toHaveLength(0);
        (0, vitest_1.expect)(result.summary.totalPenalty).toBe(0);
        (0, vitest_1.expect)(result.summary.hasCriticalRisk).toBe(false);
    });
    (0, vitest_1.it)("applies schema confidence penalty for very low schema confidence", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 35,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(70);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "schema_confidence",
                impact: -30,
                severity: "critical",
            }),
        ]));
        (0, vitest_1.expect)(result.summary.hasCriticalRisk).toBe(true);
    });
    (0, vitest_1.it)("applies storage confidence penalty for low storage confidence", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 90,
            storageConfidence: 50,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(85);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "storage_confidence",
                impact: -15,
                severity: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("applies penalty when validated files are missing", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: false,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(80);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "missing_validated_files",
                impact: -20,
            }),
        ]));
    });
    (0, vitest_1.it)("caps architecture warning penalty", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [
                "warning-1",
                "warning-2",
                "warning-3",
                "warning-4",
                "warning-5",
            ],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(82);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "architecture_warnings",
                impact: -18,
            }),
        ]));
    });
    (0, vitest_1.it)("caps patch risk warning penalty", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [
                "risk-1",
                "risk-2",
                "risk-3",
                "risk-4",
                "risk-5",
            ],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(76);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "patch_risk_warnings",
                impact: -24,
            }),
        ]));
    });
    (0, vitest_1.it)("marks validation errors as critical and applies capped penalty", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: ["schema mismatch", "unsafe write", "bad target"],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(20);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "validation_errors",
                impact: -80,
                severity: "critical",
            }),
        ]));
        (0, vitest_1.expect)(result.summary.hasCriticalRisk).toBe(true);
    });
    (0, vitest_1.it)("combines multiple penalties deterministically", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 58,
            storageConfidence: 61,
            architectureWarnings: ["route mismatch", "service mismatch"],
            patchRiskWarnings: ["wide replacement"],
            validationErrors: [],
            hasValidatedFiles: false,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(34);
        (0, vitest_1.expect)(result.summary.totalPenalty).toBe(66);
        (0, vitest_1.expect)(result.summary.totalBonus).toBe(0);
    });
    (0, vitest_1.it)("clamps invalid confidence inputs into safe range", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: Number.NaN,
            storageConfidence: -10,
            architectureWarnings: [],
            patchRiskWarnings: [],
            validationErrors: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(45);
        (0, vitest_1.expect)(result.factors).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                key: "schema_confidence",
                impact: -30,
            }),
            vitest_1.expect.objectContaining({
                key: "storage_confidence",
                impact: -25,
            }),
        ]));
    });
    (0, vitest_1.it)("never returns a score below zero", () => {
        const result = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)({
            schemaConfidence: 0,
            storageConfidence: 0,
            architectureWarnings: ["a", "b", "c", "d", "e"],
            patchRiskWarnings: ["x", "y", "z", "w"],
            validationErrors: ["err-1", "err-2", "err-3"],
            hasValidatedFiles: false,
        });
        (0, vitest_1.expect)(result.finalScore).toBe(0);
    });
    (0, vitest_1.it)("returns identical output for identical input", () => {
        const input = {
            schemaConfidence: 58,
            storageConfidence: 61,
            architectureWarnings: ["route mismatch", "service mismatch"],
            patchRiskWarnings: ["wide replacement"],
            validationErrors: [],
            hasValidatedFiles: false,
        };
        const result1 = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)(input);
        const result2 = (0, computeConfidenceBreakdown_js_1.computeConfidenceBreakdown)(input);
        (0, vitest_1.expect)(result1).toEqual(result2);
    });
});
//# sourceMappingURL=computeConfidenceBreakdown.test.js.map