"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionExplanation_js_1 = require("../buildDecisionExplanation.js");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Returns the codes present in the resolved reasons array. */
function resolvedCodes(explanation) {
    return explanation.reasons.map((r) => r.code);
}
/** Asserts that every field in every ResolvedReason is a non-empty string. */
function assertCompleteShape(explanation) {
    (0, vitest_1.expect)(typeof explanation.why).toBe("string");
    (0, vitest_1.expect)(explanation.why.length).toBeGreaterThan(0);
    (0, vitest_1.expect)(Array.isArray(explanation.reasons)).toBe(true);
    for (const reason of explanation.reasons) {
        (0, vitest_1.expect)(typeof reason.code).toBe("string");
        (0, vitest_1.expect)(reason.code.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(typeof reason.severity).toBe("string");
        (0, vitest_1.expect)(reason.severity.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(typeof reason.category).toBe("string");
        (0, vitest_1.expect)(reason.category.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(typeof reason.summary).toBe("string");
        (0, vitest_1.expect)(reason.summary.length).toBeGreaterThan(0);
    }
}
// ---------------------------------------------------------------------------
// Empty reasonCodes
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — empty reasonCodes", () => {
    (0, vitest_1.it)("returns fallback why when reasonCodes is an empty array", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: [] });
        (0, vitest_1.expect)(result.why).toBe("No reason codes provided");
    });
    (0, vitest_1.it)("returns empty reasons array when reasonCodes is []", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: [] });
        (0, vitest_1.expect)(result.reasons).toEqual([]);
    });
    (0, vitest_1.it)("does NOT throw when reasonCodes is an empty array", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: [] })).not.toThrow();
    });
    (0, vitest_1.it)("output shape is complete with empty codes", () => {
        assertCompleteShape((0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: [] }));
    });
});
// ---------------------------------------------------------------------------
// null and undefined reasonCodes
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — null / undefined reasonCodes", () => {
    (0, vitest_1.it)("treats null reasonCodes as empty — returns fallback why", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: null });
        (0, vitest_1.expect)(result.why).toBe("No reason codes provided");
    });
    (0, vitest_1.it)("treats null reasonCodes as empty — returns empty reasons array", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: null });
        (0, vitest_1.expect)(result.reasons).toEqual([]);
    });
    (0, vitest_1.it)("does NOT throw when reasonCodes is null", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: null })).not.toThrow();
    });
    (0, vitest_1.it)("treats undefined reasonCodes as empty — returns fallback why", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: undefined });
        (0, vitest_1.expect)(result.why).toBe("No reason codes provided");
    });
    (0, vitest_1.it)("treats undefined reasonCodes as empty — returns empty reasons array", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: undefined });
        (0, vitest_1.expect)(result.reasons).toEqual([]);
    });
    (0, vitest_1.it)("does NOT throw when reasonCodes is undefined", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: undefined })).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Single unknown code
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — single unknown code", () => {
    (0, vitest_1.it)("returns empty reasons when the sole code is unknown", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["TOTALLY_UNKNOWN_CODE_XYZ"],
        });
        (0, vitest_1.expect)(result.reasons).toEqual([]);
    });
    (0, vitest_1.it)("returns fallback why when the sole code is unknown", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["TOTALLY_UNKNOWN_CODE_XYZ"],
        });
        (0, vitest_1.expect)(result.why).toBe("No valid reason codes resolved");
    });
    (0, vitest_1.it)("does NOT throw on a single unknown code", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["DOES_NOT_EXIST"] })).not.toThrow();
    });
    (0, vitest_1.it)("output shape is complete with a single unknown code", () => {
        assertCompleteShape((0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["UNKNOWN_42"] }));
    });
});
// ---------------------------------------------------------------------------
// All codes unknown (every code skipped)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — all codes unknown", () => {
    (0, vitest_1.it)("returns fallback why when every code is unknown", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["UNKNOWN_A", "UNKNOWN_B", "UNKNOWN_C"],
        });
        (0, vitest_1.expect)(result.why).toBe("No valid reason codes resolved");
    });
    (0, vitest_1.it)("returns empty reasons array when every code is unknown", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["UNKNOWN_A", "UNKNOWN_B"],
        });
        (0, vitest_1.expect)(result.reasons).toEqual([]);
    });
    (0, vitest_1.it)("does NOT throw when all codes are unknown", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["GHOST_CODE", "PHANTOM_CODE"] })).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Mix of valid + unknown codes
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — mix of valid and unknown codes", () => {
    (0, vitest_1.it)("includes only valid codes in the reasons array", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE", "UNKNOWN_CODE_XYZ"],
        });
        (0, vitest_1.expect)(resolvedCodes(result)).toContain("BLOCKED_HIGH_RISK_SCORE");
        (0, vitest_1.expect)(resolvedCodes(result)).not.toContain("UNKNOWN_CODE_XYZ");
    });
    (0, vitest_1.it)("reasons length equals only the count of valid codes", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: [
                "SAFE_HIGH_CONFIDENCE",
                "MYSTERY_CODE_1",
                "MYSTERY_CODE_2",
            ],
        });
        (0, vitest_1.expect)(result.reasons).toHaveLength(1);
    });
    (0, vitest_1.it)("does NOT throw when mixing valid and unknown codes", () => {
        (0, vitest_1.expect)(() => (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_SCHEMA_RISK", "DOES_NOT_EXIST"],
        })).not.toThrow();
    });
    (0, vitest_1.it)("why string reflects only the valid codes that were resolved", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "FAKE_CODE"],
        });
        (0, vitest_1.expect)(result.why).toContain("PREVIEW_LOW_CONFIDENCE");
        (0, vitest_1.expect)(result.why).not.toContain("FAKE_CODE");
    });
    (0, vitest_1.it)("output shape is complete for mixed-code input", () => {
        assertCompleteShape((0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION", "GHOST_CODE"],
        }));
    });
});
// ---------------------------------------------------------------------------
// Missing severity in metadata → defaults to "info"
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — missing severity fallback", () => {
    (0, vitest_1.it)("defaults severity to 'info' when metadata severity is undefined", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: {
                MY_CODE: { category: "risk", summary: "Something happened." },
                // severity intentionally omitted
            },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
    (0, vitest_1.it)("defaults severity to 'info' when metadata severity is null", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: {
                MY_CODE: { severity: null, category: "risk", summary: "Test." },
            },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
    (0, vitest_1.it)("defaults severity to 'info' when metadata severity is an empty string", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: {
                MY_CODE: { severity: "", category: "risk", summary: "Test." },
            },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
    (0, vitest_1.it)("maps 'high' severity to 'critical'", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "high", category: "risk", summary: "High risk." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("critical");
    });
    (0, vitest_1.it)("maps 'medium' severity to 'warning'", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "medium", category: "scope", summary: "Medium." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("warning");
    });
    (0, vitest_1.it)("maps 'low' severity to 'info'", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "low", category: "safety", summary: "Low risk." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
    (0, vitest_1.it)("defaults unrecognised severity string to 'info'", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "extreme", category: "risk", summary: "Unknown sev." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
});
// ---------------------------------------------------------------------------
// Missing category in metadata → defaults to "general"
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — missing category fallback", () => {
    (0, vitest_1.it)("defaults category to 'general' when metadata category is undefined", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "high", summary: "No category." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.category).toBe("general");
    });
    (0, vitest_1.it)("defaults category to 'general' when metadata category is null", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "medium", category: null, summary: "Null cat." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.category).toBe("general");
    });
    (0, vitest_1.it)("defaults category to 'general' when metadata category is an empty string", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "low", category: "", summary: "Empty cat." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.category).toBe("general");
    });
    (0, vitest_1.it)("uses the provided category when it is a non-empty string", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "high", category: "security", summary: "Security." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.category).toBe("security");
    });
});
// ---------------------------------------------------------------------------
// Missing summary in metadata → defaults to "No summary available"
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — missing summary fallback", () => {
    (0, vitest_1.it)("defaults summary to 'No summary available' when metadata summary is undefined", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "high", category: "risk" } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.summary).toBe("No summary available");
    });
    (0, vitest_1.it)("defaults summary to 'No summary available' when metadata summary is null", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "low", category: "scope", summary: null } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.summary).toBe("No summary available");
    });
    (0, vitest_1.it)("defaults summary to 'No summary available' when metadata summary is empty string", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "medium", category: "confidence", summary: "" } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.summary).toBe("No summary available");
    });
    (0, vitest_1.it)("uses the provided summary when it is a non-empty string", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["MY_CODE"] }, {
            metadata: { MY_CODE: { severity: "high", category: "risk", summary: "A real summary." } },
        });
        (0, vitest_1.expect)(result.reasons[0]?.summary).toBe("A real summary.");
    });
});
// ---------------------------------------------------------------------------
// All fields missing simultaneously (fully incomplete metadata entry)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — all fields missing simultaneously", () => {
    (0, vitest_1.it)("applies all three fallbacks when metadata entry has no fields", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["BARE_CODE"] }, { metadata: { BARE_CODE: {} } });
        const reason = result.reasons[0];
        (0, vitest_1.expect)(reason.severity).toBe("info");
        (0, vitest_1.expect)(reason.category).toBe("general");
        (0, vitest_1.expect)(reason.summary).toBe("No summary available");
    });
    (0, vitest_1.it)("still uses the original code string when metadata entry has no fields", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["BARE_CODE"] }, { metadata: { BARE_CODE: {} } });
        (0, vitest_1.expect)(result.reasons[0]?.code).toBe("BARE_CODE");
    });
    (0, vitest_1.it)("output shape is always complete even with a fully empty metadata entry", () => {
        assertCompleteShape((0, buildDecisionExplanation_js_1.buildDecisionExplanation)({ reasonCodes: ["BARE_CODE"] }, { metadata: { BARE_CODE: {} } }));
    });
});
// ---------------------------------------------------------------------------
// Normal path — real metadata registry, no edge cases
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildDecisionExplanation — normal (happy) path with real metadata", () => {
    (0, vitest_1.it)("resolves a known code correctly", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
        });
        (0, vitest_1.expect)(result.reasons).toHaveLength(1);
        (0, vitest_1.expect)(result.reasons[0]?.code).toBe("BLOCKED_HIGH_RISK_SCORE");
    });
    (0, vitest_1.it)("why string mentions the resolved code", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
        });
        (0, vitest_1.expect)(result.why).toContain("SAFE_HIGH_CONFIDENCE");
    });
    (0, vitest_1.it)("resolves multiple known codes preserving order", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_SCHEMA_RISK", "BLOCKED_CRITICAL_RISK"],
        });
        (0, vitest_1.expect)(resolvedCodes(result)).toEqual([
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_CRITICAL_RISK",
        ]);
    });
    (0, vitest_1.it)("normal path output shape is always complete", () => {
        assertCompleteShape((0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "PREVIEW_MASS_SCOPE_CHANGE"],
        }));
    });
    (0, vitest_1.it)("maps known 'high' metadata severity to 'critical' in the resolved reason", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION"],
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("critical");
    });
    (0, vitest_1.it)("maps known 'low' metadata severity to 'info' in the resolved reason", () => {
        const result = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)({
            reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
        });
        (0, vitest_1.expect)(result.reasons[0]?.severity).toBe("info");
    });
});
//# sourceMappingURL=buildDecisionExplanation.edgecases.test.js.map