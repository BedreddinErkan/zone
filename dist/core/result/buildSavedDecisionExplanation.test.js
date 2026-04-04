"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildSavedDecisionExplanation_js_1 = require("./buildSavedDecisionExplanation.js");
function createBaseResult(overrides) {
    return {
        summary: "Example summary",
        intent: {
            rawTask: "add endpoint",
            operation: "modify",
            target: "endpoint",
            scope: "server",
            nestedTarget: null,
            confidence: "medium",
            warnings: []
        },
        schema: {
            summary: "Schema summary",
            entities: [],
            relations: [],
            confidence: "medium"
        },
        storage: {
            primaryStorage: "postgres",
            detectedClients: [],
            confidence: "medium",
            reasoning: ["Detected postgres"]
        },
        validation: {
            patch: [],
            schema: []
        },
        decision: {
            mode: "preview",
            confidence: 72,
            reason: "Warnings require review."
        },
        confidenceDetails: {
            baseWeightedScore: 80,
            totalPenalty: 8,
            penalties: []
        },
        notes: {
            execution: [],
            assumptions: [],
            followUps: []
        },
        ...overrides
    };
}
(0, vitest_1.describe)("buildSavedDecisionExplanation", () => {
    (0, vitest_1.it)("explains blocked saved decision", () => {
        const result = createBaseResult({
            decision: {
                mode: "blocked",
                confidence: 20,
                reason: "Blocking issues detected."
            },
            issues: {
                summary: {
                    total: 2,
                    errors: 2,
                    warnings: 0
                },
                grouped: []
            }
        });
        const output = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(result);
        (0, vitest_1.expect)(output).toContain("Decision was saved as BLOCKED");
        (0, vitest_1.expect)(output).toContain("2 error-level issue(s) remain in the saved result");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until blocking issues are resolved.");
    });
    (0, vitest_1.it)("explains preview saved decision", () => {
        const result = createBaseResult({
            decision: {
                mode: "preview",
                confidence: 68,
                reason: "Warnings require review."
            },
            issues: {
                summary: {
                    total: 3,
                    errors: 0,
                    warnings: 3
                },
                grouped: []
            }
        });
        const output = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(result);
        (0, vitest_1.expect)(output).toContain("Decision was saved as PREVIEW ONLY");
        (0, vitest_1.expect)(output).toContain("3 warning-level issue(s) remain in the saved result");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until review is completed.");
    });
    (0, vitest_1.it)("includes medium/high top risk count when present", () => {
        const result = createBaseResult({
            issues: {
                summary: {
                    total: 2,
                    errors: 0,
                    warnings: 2
                },
                grouped: [],
                topRisks: [
                    {
                        id: "risk-1",
                        title: "Dangerous patch target",
                        description: "Patch may touch risky file",
                        severity: "high",
                        score: 90,
                        category: "patch",
                        source: "warning"
                    },
                    {
                        id: "risk-2",
                        title: "Schema mismatch",
                        description: "Schema confidence is limited",
                        severity: "medium",
                        score: 66,
                        category: "schema",
                        source: "derived"
                    },
                    {
                        id: "risk-3",
                        title: "Minor note",
                        description: "Low concern",
                        severity: "low",
                        score: 12,
                        category: "other",
                        source: "derived"
                    }
                ]
            }
        });
        const output = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(result);
        (0, vitest_1.expect)(output).toContain("2 medium/high top risk(s) remain visible in the saved result");
    });
    (0, vitest_1.it)("explains apply saved decision", () => {
        const result = createBaseResult({
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
                },
                grouped: []
            }
        });
        const output = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(result);
        (0, vitest_1.expect)(output).toContain("Decision was saved as SAFE TO APPLY");
        (0, vitest_1.expect)(output).toContain("Automatic apply can proceed under the current safeguards.");
    });
    (0, vitest_1.it)("still returns fallback explanation when issues are missing", () => {
        const result = createBaseResult({
            issues: undefined
        });
        const output = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(result);
        (0, vitest_1.expect)(output).toContain("Decision was saved as PREVIEW ONLY");
        (0, vitest_1.expect)(output).toContain("Automatic apply is not recommended until review is completed.");
    });
});
//# sourceMappingURL=buildSavedDecisionExplanation.test.js.map