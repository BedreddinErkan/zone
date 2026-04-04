"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const generatePatchPlan_js_1 = require("./generatePatchPlan.js");
(0, vitest_1.describe)("generatePatchPlan", () => {
    (0, vitest_1.it)("returns blocked result when decision mode is blocked", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "rename helper function",
            decision: {
                mode: "blocked",
                confidenceScore: 22
            },
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"]
        });
        (0, vitest_1.expect)(result).toEqual({
            allowed: false,
            strategy: "blocked",
            intent: "rename_symbol",
            operations: [],
            metadata: {
                reason: "Patch generation blocked by decision mode.",
                derivedFrom: ["BLOCKED_HIGH_RISK_SCORE"],
                confidenceScore: 22
            }
        });
    });
    (0, vitest_1.it)("returns blocked result when task intent is unknown", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "rewrite authentication flow",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 88
            },
            reasonCodes: ["SAFE_LOW_RISK"]
        });
        (0, vitest_1.expect)(result).toEqual({
            allowed: false,
            strategy: "safe",
            intent: "unknown",
            operations: [],
            metadata: {
                reason: "Patch generation blocked because task intent is unknown.",
                derivedFrom: ["SAFE_LOW_RISK"],
                confidenceScore: 88
            }
        });
    });
    (0, vitest_1.it)("returns blocked result when intent is not allowed for restricted strategy", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "update import path in api client",
            decision: {
                mode: "preview_only",
                confidenceScore: 61
            },
            reasonCodes: ["PREVIEW_REQUIRED"]
        });
        (0, vitest_1.expect)(result).toEqual({
            allowed: false,
            strategy: "restricted",
            intent: "update_import",
            operations: [],
            metadata: {
                reason: "Patch intent is not allowed for strategy: restricted.",
                derivedFrom: ["PREVIEW_REQUIRED"],
                confidenceScore: 61
            }
        });
    });
    (0, vitest_1.it)("generates a patch plan for allowed restricted intent", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "rename helper function",
            decision: {
                mode: "preview_only",
                confidenceScore: 73
            },
            reasonCodes: ["PREVIEW_MASS_SCOPE"]
        });
        (0, vitest_1.expect)(result).toEqual({
            allowed: true,
            strategy: "restricted",
            intent: "rename_symbol",
            operations: [
                {
                    type: "rename",
                    scope: "single_file"
                }
            ],
            metadata: {
                reason: "Patch plan generated successfully from deterministic intent classification.",
                derivedFrom: ["PREVIEW_MASS_SCOPE"],
                confidenceScore: 73
            }
        });
    });
    (0, vitest_1.it)("generates a patch plan for safe strategy", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "update import path in api client",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 91
            },
            reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
        });
        (0, vitest_1.expect)(result).toEqual({
            allowed: true,
            strategy: "safe",
            intent: "update_import",
            operations: [
                {
                    type: "update_import",
                    scope: "single_file"
                }
            ],
            metadata: {
                reason: "Patch plan generated successfully from deterministic intent classification.",
                derivedFrom: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"],
                confidenceScore: 91
            }
        });
    });
    (0, vitest_1.it)("defaults reasonCodes to an empty array", () => {
        const result = (0, generatePatchPlan_js_1.generatePatchPlan)({
            task: "add comment above helper",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 85
            }
        });
        (0, vitest_1.expect)(result.metadata.derivedFrom).toEqual([]);
    });
    (0, vitest_1.it)("is deterministic for repeated calls", () => {
        const input = {
            task: "replace exact text in config",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 84
            },
            reasonCodes: ["SAFE_LOW_RISK"]
        };
        const first = (0, generatePatchPlan_js_1.generatePatchPlan)(input);
        const second = (0, generatePatchPlan_js_1.generatePatchPlan)(input);
        (0, vitest_1.expect)(first).toEqual(second);
    });
});
//# sourceMappingURL=generatePatchPlan.test.js.map