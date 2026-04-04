"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionExplanation_js_1 = require("./buildDecisionExplanation.js");
const renderDecisionSummary_js_1 = require("./renderDecisionSummary.js");
const decisionReasonCodeMeta_js_1 = require("./decisionReasonCodeMeta.js");
function buildBlockedExplanationResult() {
    return {
        mode: "blocked",
        confidenceScore: 25,
        reasons: [
            {
                code: "PATCH_VALIDATION_ERROR",
                severity: "critical",
                message: "Patch validation failed."
            }
        ]
    };
}
function buildReasonsFromMetadataCodes(codes) {
    return (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)([...codes]).map((reason) => ({
        code: reason.code,
        severity: reason.severity === "high"
            ? "critical"
            : reason.severity === "medium"
                ? "warning"
                : "info",
        message: reason.summary
    }));
}
(0, vitest_1.describe)("buildDecisionExplanation", () => {
    (0, vitest_1.it)("explains blocked mode with critical reasons", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "blocked",
            confidenceScore: 0,
            reasons: [
                {
                    code: "PATCH_VALIDATION_ERROR",
                    severity: "critical",
                    message: "Patch validation failed."
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("Decision was set to BLOCKED");
        (0, vitest_1.expect)(output).toContain("1 critical reason(s) affected the decision");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until blocking issues are resolved.");
    });
    (0, vitest_1.it)("explains preview_only mode with warning reasons", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 68,
            reasons: [
                {
                    code: "PATCH_VALIDATION_WARNING",
                    severity: "warning",
                    message: "Patch should be reviewed."
                },
                {
                    code: "ARCHITECTURE_WARNING",
                    severity: "warning",
                    message: "Architecture mismatch warning."
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("Decision was set to PREVIEW ONLY");
        (0, vitest_1.expect)(output).toContain("2 warning-level reason(s) affected the decision");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until review is completed.");
    });
    (0, vitest_1.it)("includes medium or high top risk count when present", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 70,
            reasons: [
                {
                    code: "PATCH_RISK_WARNING",
                    severity: "warning",
                    message: "Risk warnings detected."
                }
            ],
            topRisks: [
                {
                    id: "risk-1",
                    title: "Dangerous patch target",
                    description: "Target may be unsafe.",
                    severity: "high",
                    score: 91,
                    category: "patch",
                    source: "warning"
                },
                {
                    id: "risk-2",
                    title: "Schema mismatch",
                    description: "Schema may be incomplete.",
                    severity: "medium",
                    score: 66,
                    category: "schema",
                    source: "derived"
                },
                {
                    id: "risk-3",
                    title: "Low concern note",
                    description: "Minor note.",
                    severity: "low",
                    score: 20,
                    category: "other",
                    source: "derived"
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("2 medium/high top risk(s) remain visible in the result");
    });
    (0, vitest_1.it)("explains safe_to_apply mode with informational reason", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "safe_to_apply",
            confidenceScore: 92,
            reasons: [
                {
                    code: "SAFE_TO_APPLY",
                    severity: "info",
                    message: "No blocking or warning-level execution risks were detected."
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("Decision was set to SAFE TO APPLY");
        (0, vitest_1.expect)(output).toContain("1 informational confirmation reason(s) were recorded");
        (0, vitest_1.expect)(output).toContain("Automatic apply can proceed under the current safeguards.");
    });
    (0, vitest_1.it)("still returns fallback explanation when reasons are empty", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 60,
            reasons: []
        });
        (0, vitest_1.expect)(output).toContain("Decision was set to PREVIEW ONLY");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until review is completed.");
    });
    (0, vitest_1.it)("includes metadata-driven why line when reasonCodes are provided", () => {
        const reasonCodes = [
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_HIGH_RISK_SCORE"
        ];
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "blocked",
            confidenceScore: 25,
            reasons: buildReasonsFromMetadataCodes(reasonCodes),
            topRisks: [
                {
                    id: "risk-1",
                    title: "Potentially destructive change",
                    description: "May cause irreversible loss",
                    severity: "high",
                    score: 91,
                    category: "patch",
                    source: "warning"
                }
            ]
        }, {
            reasonCodes
        });
        (0, vitest_1.expect)(output).toContain("Decision was set to BLOCKED because blocking validation signals were detected.");
        (0, vitest_1.expect)(output).toContain("Why:");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until blocking issues are resolved.");
    });
    (0, vitest_1.it)("does not include why line when reasonCodes are omitted", () => {
        const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 55,
            reasons: [
                {
                    code: "PATCH_VALIDATION_WARNING",
                    message: "Confidence is too low",
                    severity: "warning"
                }
            ],
            topRisks: []
        });
        (0, vitest_1.expect)(output).not.toContain("Why:");
        (0, vitest_1.expect)(output).toContain("Decision was set to PREVIEW ONLY because manual review is still required.");
    });
});
(0, vitest_1.it)("keeps existing summary lines and closing line intact", () => {
    const reasonCodes = [
        "SAFE_LOW_RISK_LOCALIZED",
        "SAFE_HIGH_CONFIDENCE"
    ];
    const output = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
        mode: "safe_to_apply",
        confidenceScore: 92,
        reasons: buildReasonsFromMetadataCodes(reasonCodes),
        topRisks: []
    }, {
        reasonCodes
    });
    (0, vitest_1.expect)(output).toContain("Why:");
    (0, vitest_1.expect)(output).toContain("- 2 informational confirmation reason(s) were recorded");
    (0, vitest_1.expect)(output).toContain("Automatic apply can proceed under the current safeguards.");
});
(0, vitest_1.describe)("buildDecisionExplanation + renderDecisionSummary parity", () => {
    (0, vitest_1.it)("keeps explanation mode wording aligned with rendered summary for blocked", () => {
        const result = buildBlockedExplanationResult();
        const explanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)(result);
        const summary = (0, renderDecisionSummary_js_1.renderDecisionSummary)(result);
        (0, vitest_1.expect)(explanation).toContain("Decision was set to BLOCKED");
        (0, vitest_1.expect)(summary).toContain("blocked");
    });
});
(0, vitest_1.describe)("buildDecisionExplanation – reason parity", () => {
    (0, vitest_1.it)("builds explanation when reasonCodes and reasons are aligned", () => {
        const reasonCodes = [
            "PREVIEW_LOW_CONFIDENCE"
        ];
        const explanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 75,
            reasons: buildReasonsFromMetadataCodes(reasonCodes),
            topRisks: []
        }, {
            reasonCodes
        });
        (0, vitest_1.expect)(explanation).toContain("Decision was set to PREVIEW ONLY");
    });
    (0, vitest_1.it)("throws when a provided reasonCode does not exist in reasons", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "preview_only",
            confidenceScore: 75,
            reasons: [
                {
                    code: "PATCH_VALIDATION_WARNING",
                    severity: "warning",
                    message: "Patch should be reviewed."
                }
            ],
            topRisks: []
        }, {
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"]
        })).toThrow("DECISION_EXPLANATION_REASON_MISMATCH");
    });
    (0, vitest_1.it)("remains backward compatible when reasonCodes are omitted", () => {
        const explanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            mode: "safe_to_apply",
            confidenceScore: 100,
            reasons: [
                {
                    code: "SAFE_TO_APPLY",
                    severity: "info",
                    message: "No blocking or warning-level execution risks were detected."
                }
            ],
            topRisks: []
        });
        (0, vitest_1.expect)(explanation).toContain("SAFE TO APPLY");
    });
});
//# sourceMappingURL=buildDecisionExplanation.test.js.map