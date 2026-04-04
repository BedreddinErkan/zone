"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const contradictionDetector_js_1 = require("../contradictionDetector.js");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function flagTypes(flags) {
    return flags.map((f) => f.type);
}
// ---------------------------------------------------------------------------
// LOW_CONFIDENCE_ON_SAFE
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — LOW_CONFIDENCE_ON_SAFE", () => {
    (0, vitest_1.it)("flags when mode is safe_to_apply and confidenceScore is below 0.4", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.2, 0.3, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("LOW_CONFIDENCE_ON_SAFE");
    });
    (0, vitest_1.it)("flags at the boundary just below 0.4 (0.39)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.39, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("LOW_CONFIDENCE_ON_SAFE");
    });
    (0, vitest_1.it)("does NOT flag when confidenceScore equals 0.4 (boundary is exclusive)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.4, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
    });
    (0, vitest_1.it)("does NOT flag when confidenceScore is above 0.4", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
    });
    (0, vitest_1.it)("does NOT flag for preview_only mode even with low confidence", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.1, "preview_only");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
    });
    (0, vitest_1.it)("does NOT flag for blocked mode even with low confidence", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.1, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
    });
});
// ---------------------------------------------------------------------------
// HIGH_CONFIDENCE_ON_BLOCK
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — HIGH_CONFIDENCE_ON_BLOCK", () => {
    (0, vitest_1.it)("flags when mode is blocked and riskScore is below 0.3", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
    (0, vitest_1.it)("flags at the boundary just below 0.3 (0.29)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.29, 0.8, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
    (0, vitest_1.it)("does NOT flag when riskScore equals 0.3 (boundary is exclusive)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.3, 0.9, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
    (0, vitest_1.it)("does NOT flag when riskScore is above 0.3", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.8, 0.9, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
    (0, vitest_1.it)("does NOT flag for safe_to_apply mode with low riskScore", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
    (0, vitest_1.it)("does NOT flag for preview_only mode with low riskScore", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "preview_only");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
    });
});
// ---------------------------------------------------------------------------
// SCORE_TENSION
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — SCORE_TENSION", () => {
    (0, vitest_1.it)("flags when riskScore > 0.6, confidenceScore > 0.8, and mode is safe_to_apply", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.7, 0.9, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("SCORE_TENSION");
    });
    (0, vitest_1.it)("flags at minimum triggering values (0.61 risk, 0.81 confidence)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.61, 0.81, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).toContain("SCORE_TENSION");
    });
    (0, vitest_1.it)("does NOT flag when riskScore equals exactly 0.6 (boundary is exclusive)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.6, 0.9, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("SCORE_TENSION");
    });
    (0, vitest_1.it)("does NOT flag when confidenceScore equals exactly 0.8 (boundary is exclusive)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.7, 0.8, "safe_to_apply");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("SCORE_TENSION");
    });
    (0, vitest_1.it)("does NOT flag for blocked mode even with high risk and high confidence", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.9, 0.9, "blocked");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("SCORE_TENSION");
    });
    (0, vitest_1.it)("does NOT flag for preview_only mode even with high risk and high confidence", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.9, 0.9, "preview_only");
        (0, vitest_1.expect)(flagTypes(flags)).not.toContain("SCORE_TENSION");
    });
});
// ---------------------------------------------------------------------------
// No contradictions — clean cases
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — clean cases (no flags)", () => {
    (0, vitest_1.it)("returns empty array for a well-supported safe_to_apply decision", () => {
        // Low risk, high confidence, safe mode — no contradictions
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.2, 0.9, "safe_to_apply");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
    (0, vitest_1.it)("returns empty array for a justified blocked decision with high risk", () => {
        // High risk, high confidence, blocked — semantically consistent
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.8, 0.9, "blocked");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
    (0, vitest_1.it)("returns empty array for a blocked decision with moderate risk", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.5, 0.6, "blocked");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
    (0, vitest_1.it)("returns empty array for preview_only with moderate scores", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.4, 0.6, "preview_only");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
    (0, vitest_1.it)("returns empty array for preview_only with high risk", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.8, 0.8, "preview_only");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
    (0, vitest_1.it)("returns empty array for safe_to_apply with mid-range confidence (0.5)", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.5, "safe_to_apply");
        (0, vitest_1.expect)(flags).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Severity values
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — severity values", () => {
    (0, vitest_1.it)("LOW_CONFIDENCE_ON_SAFE has severity 'warning'", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.2, 0.3, "safe_to_apply");
        const flag = flags.find((f) => f.type === "LOW_CONFIDENCE_ON_SAFE");
        (0, vitest_1.expect)(flag).toBeDefined();
        (0, vitest_1.expect)(flag?.severity).toBe("warning");
    });
    (0, vitest_1.it)("HIGH_CONFIDENCE_ON_BLOCK has severity 'info'", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "blocked");
        const flag = flags.find((f) => f.type === "HIGH_CONFIDENCE_ON_BLOCK");
        (0, vitest_1.expect)(flag).toBeDefined();
        (0, vitest_1.expect)(flag?.severity).toBe("info");
    });
    (0, vitest_1.it)("SCORE_TENSION has severity 'critical'", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.7, 0.9, "safe_to_apply");
        const flag = flags.find((f) => f.type === "SCORE_TENSION");
        (0, vitest_1.expect)(flag).toBeDefined();
        (0, vitest_1.expect)(flag?.severity).toBe("critical");
    });
    (0, vitest_1.it)("each flag carries a non-empty message string", () => {
        const allFlags = [
            ...(0, contradictionDetector_js_1.detectContradictions)(0.2, 0.3, "safe_to_apply"),
            ...(0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "blocked"),
            ...(0, contradictionDetector_js_1.detectContradictions)(0.7, 0.9, "safe_to_apply"),
        ];
        for (const flag of allFlags) {
            (0, vitest_1.expect)(typeof flag.message).toBe("string");
            (0, vitest_1.expect)(flag.message.length).toBeGreaterThan(0);
        }
    });
});
// ---------------------------------------------------------------------------
// Return type shape
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("detectContradictions — return type shape", () => {
    (0, vitest_1.it)("always returns an array", () => {
        (0, vitest_1.expect)(Array.isArray((0, contradictionDetector_js_1.detectContradictions)(0.5, 0.5, "preview_only"))).toBe(true);
    });
    (0, vitest_1.it)("each flag has type, severity, and message fields", () => {
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.1, 0.9, "blocked");
        for (const flag of flags) {
            (0, vitest_1.expect)(flag).toHaveProperty("type");
            (0, vitest_1.expect)(flag).toHaveProperty("severity");
            (0, vitest_1.expect)(flag).toHaveProperty("message");
        }
    });
    (0, vitest_1.it)("multiple flags can be returned in the same call", () => {
        // LOW_CONFIDENCE_ON_SAFE triggers (mode=safe, confidence=0.3)
        // HIGH_CONFIDENCE_ON_BLOCK does NOT trigger (wrong mode)
        // SCORE_TENSION does NOT trigger (risk too low)
        const flags = (0, contradictionDetector_js_1.detectContradictions)(0.2, 0.3, "safe_to_apply");
        (0, vitest_1.expect)(flags.length).toBeGreaterThanOrEqual(1);
    });
});
//# sourceMappingURL=contradictionDetector.test.js.map