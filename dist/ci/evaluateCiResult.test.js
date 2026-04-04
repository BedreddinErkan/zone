"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const evaluateCiResult_js_1 = require("./evaluateCiResult.js");
(0, vitest_1.describe)("evaluateCiResult", () => {
    (0, vitest_1.it)("fails CI when decision mode is blocked", () => {
        const result = {
            decision: {
                mode: "blocked",
                confidenceScore: 22,
                reason: "Blocking validation errors were detected."
            },
            confidenceDetails: {
                penalties: [{ label: "Patch validation warnings" }]
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("blocked");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("fail");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(true);
        (0, vitest_1.expect)(evaluation.confidenceScore).toBe(22);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: BLOCKED");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("decision=blocked");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("confidence=22");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("reason=Blocking validation errors were detected.");
        (0, vitest_1.expect)(evaluation.penaltyReasons).toEqual(["Patch validation warnings"]);
    });
    (0, vitest_1.it)("fails CI when saved result contains error-level issues even if mode is preview", () => {
        const result = {
            decision: {
                mode: "preview",
                confidence: 61,
                reason: "Manual review required."
            },
            issues: {
                summary: {
                    total: 3,
                    errors: 1,
                    warnings: 2
                }
            },
            confidenceDetails: {
                penalties: [{ label: "Schema validation warnings" }]
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("preview");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("fail");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(true);
        (0, vitest_1.expect)(evaluation.confidenceScore).toBe(61);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: PREVIEW ONLY");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("decision=preview");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("errors=1");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("warnings=2");
    });
    (0, vitest_1.it)("returns warn for preview_only when there are no error-level issues", () => {
        const result = {
            decision: {
                mode: "preview_only",
                confidenceScore: 68,
                reason: "Warnings require review."
            },
            issues: {
                summary: {
                    total: 2,
                    errors: 0,
                    warnings: 2
                }
            },
            confidenceDetails: {
                penalties: [
                    { label: "Architecture warnings" },
                    { label: "Patch risk warnings" }
                ]
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("preview_only");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("warn");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
        (0, vitest_1.expect)(evaluation.confidenceScore).toBe(68);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: PREVIEW ONLY");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("decision=preview_only");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("warnings=2");
        (0, vitest_1.expect)(evaluation.penaltyReasons).toEqual([
            "Architecture warnings",
            "Patch risk warnings"
        ]);
    });
    (0, vitest_1.it)("returns pass for saved result with apply mode and zero errors", () => {
        const result = {
            decision: {
                mode: "apply",
                confidence: 91,
                reason: "Validation passed cleanly."
            },
            issues: {
                summary: {
                    total: 0,
                    errors: 0,
                    warnings: 0
                }
            },
            confidenceBreakdown: {
                finalScore: 91,
                level: "high"
            },
            confidenceDetails: {
                penalties: []
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("apply");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("pass");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
        (0, vitest_1.expect)(evaluation.confidenceScore).toBe(91);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: SAFE TO APPLY");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("decision=apply");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("confidence=91");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("errors=0");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("warnings=0");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("penalties=none");
    });
    (0, vitest_1.it)("prefers explicit saved statusLine when provided", () => {
        const result = {
            statusLine: "STATUS: CUSTOM SAVED LINE",
            decision: {
                mode: "preview",
                confidence: 57,
                reason: "Saved result should control status line."
            },
            issues: {
                summary: {
                    total: 1,
                    errors: 0,
                    warnings: 1
                }
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: CUSTOM SAVED LINE");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("warn");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
    });
    (0, vitest_1.it)("deduplicates penalty labels and ignores empty ones", () => {
        const result = {
            decision: {
                mode: "preview_only",
                confidenceScore: 70,
                reason: "Review penalties."
            },
            confidenceDetails: {
                penalties: [
                    { label: "Architecture warnings" },
                    { label: "Architecture warnings" },
                    { label: "   " },
                    {},
                    { label: "Patch risk warnings" }
                ]
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.penaltyReasons).toEqual([
            "Architecture warnings",
            "Patch risk warnings"
        ]);
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("penalties=Architecture warnings | Patch risk warnings");
    });
    (0, vitest_1.it)("falls back to confidence.finalScore for legacy result shape", () => {
        const result = {
            decision: {
                mode: "safe_to_apply",
                reason: "Legacy confidence source."
            },
            confidence: {
                finalScore: 87
            },
            confidenceDetails: {
                penalties: []
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("safe_to_apply");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("pass");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
        (0, vitest_1.expect)(evaluation.confidenceScore).toBe(87);
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("confidence=87");
    });
    (0, vitest_1.it)("falls back to unknown mode when decision mode is missing or unsupported", () => {
        const result = {
            decision: {
                mode: "manual_review",
                reason: "Unexpected custom mode."
            },
            confidenceDetails: {
                penalties: []
            }
        };
        const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
        (0, vitest_1.expect)(evaluation.decisionMode).toBe("unknown");
        (0, vitest_1.expect)(evaluation.ciStatus).toBe("warn");
        (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
        (0, vitest_1.expect)(evaluation.statusLine).toBe("STATUS: UNKNOWN");
        (0, vitest_1.expect)(evaluation.summaryLine).toContain("decision=unknown");
    });
});
(0, vitest_1.it)("fails CI when topRisks contains a high severity risk even if summary errors are zero", () => {
    const result = {
        decision: {
            mode: "preview_only",
            confidenceScore: 74,
            reason: "Review requested because of risk scoring."
        },
        issues: {
            summary: {
                total: 1,
                errors: 0,
                warnings: 1
            },
            topRisks: [
                {
                    id: "risk-1",
                    title: "Dangerous patch target",
                    severity: "high",
                    source: "warning"
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.decisionMode).toBe("preview_only");
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("fail");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(true);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("topRisks=high:Dangerous patch target");
});
(0, vitest_1.it)("keeps preview_only as warn when topRisks are not high severity", () => {
    const result = {
        decision: {
            mode: "preview_only",
            confidenceScore: 72,
            reason: "Manual review still required."
        },
        issues: {
            summary: {
                total: 2,
                errors: 0,
                warnings: 2
            },
            topRisks: [
                {
                    id: "risk-1",
                    title: "Architecture mismatch",
                    severity: "medium",
                    source: "warning"
                },
                {
                    id: "risk-2",
                    title: "Confidence gap",
                    severity: "low",
                    source: "derived"
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("warn");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("topRisks=medium:Architecture mismatch");
});
(0, vitest_1.it)("includes grouped ValidationIssue sources in summaryLine when present", () => {
    const result = {
        decision: {
            mode: "apply",
            confidenceScore: 89,
            reason: "Ready for CI summary rendering."
        },
        issues: {
            summary: {
                total: 2,
                errors: 0,
                warnings: 2
            },
            grouped: [
                {
                    issues: [
                        { source: "patch" },
                        { source: "schema" },
                        { source: "patch" }
                    ]
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("pass");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("sources=patch | schema");
});
(0, vitest_1.it)("fails CI when topRisks contains a high severity risk even if summary errors are zero", () => {
    const result = {
        decision: {
            mode: "preview_only",
            confidenceScore: 74,
            reason: "Review requested because of risk scoring."
        },
        issues: {
            summary: {
                total: 1,
                errors: 0,
                warnings: 1
            },
            topRisks: [
                {
                    id: "risk-1",
                    title: "Dangerous patch target",
                    severity: "high",
                    source: "warning"
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.decisionMode).toBe("preview_only");
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("fail");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(true);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("topRisks=high:Dangerous patch target");
});
(0, vitest_1.it)("keeps preview_only as warn when topRisks are not high severity", () => {
    const result = {
        decision: {
            mode: "preview_only",
            confidenceScore: 72,
            reason: "Manual review still required."
        },
        issues: {
            summary: {
                total: 2,
                errors: 0,
                warnings: 2
            },
            topRisks: [
                {
                    id: "risk-1",
                    title: "Architecture mismatch",
                    severity: "medium",
                    source: "warning"
                },
                {
                    id: "risk-2",
                    title: "Confidence gap",
                    severity: "low",
                    source: "derived"
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("warn");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("topRisks=medium:Architecture mismatch");
});
(0, vitest_1.it)("includes grouped ValidationIssue sources in summaryLine when present", () => {
    const result = {
        decision: {
            mode: "apply",
            confidenceScore: 89,
            reason: "Ready for CI summary rendering."
        },
        issues: {
            summary: {
                total: 2,
                errors: 0,
                warnings: 2
            },
            grouped: [
                {
                    issues: [
                        { source: "patch" },
                        { source: "schema" },
                        { source: "patch" }
                    ]
                }
            ]
        }
    };
    const evaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(result);
    (0, vitest_1.expect)(evaluation.ciStatus).toBe("pass");
    (0, vitest_1.expect)(evaluation.shouldFail).toBe(false);
    (0, vitest_1.expect)(evaluation.summaryLine).toContain("sources=patch | schema");
});
//# sourceMappingURL=evaluateCiResult.test.js.map