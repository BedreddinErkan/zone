"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderAuditDiff_js_1 = require("../renderAuditDiff.js");
function createBaseDiff(overrides = {}) {
    return {
        modeChanged: false,
        confidenceChanged: false,
        riskChanged: false,
        parityChanged: false,
        contradictionFlagsAdded: [],
        contradictionFlagsRemoved: [],
        reasonCodesAdded: [],
        reasonCodesRemoved: [],
        traceReasonMappingChanged: false,
        previous: {
            mode: "preview_only",
            confidenceScore: 0.55,
            riskScore: 0.44,
            parityValid: true,
        },
        current: {
            mode: "preview_only",
            confidenceScore: 0.55,
            riskScore: 0.44,
            parityValid: true,
        },
        ...overrides,
    };
}
(0, vitest_1.describe)("renderAuditDiff", () => {
    (0, vitest_1.it)("renders the header", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("=== AUDIT DIFF ===");
    });
    (0, vitest_1.it)("renders unchanged mode", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Mode: unchanged (preview_only)");
    });
    (0, vitest_1.it)("renders changed mode", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            modeChanged: true,
            previous: {
                mode: "blocked",
                confidenceScore: 0.55,
                riskScore: 0.44,
                parityValid: true,
            },
            current: {
                mode: "safe_to_apply",
                confidenceScore: 0.55,
                riskScore: 0.44,
                parityValid: true,
            },
        }));
        (0, vitest_1.expect)(output).toContain("Mode: blocked -> safe_to_apply");
    });
    (0, vitest_1.it)("renders unchanged confidence", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Confidence: unchanged (0.55)");
    });
    (0, vitest_1.it)("renders changed confidence", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            confidenceChanged: true,
            previous: {
                mode: "preview_only",
                confidenceScore: 0.4,
                riskScore: 0.44,
                parityValid: true,
            },
            current: {
                mode: "preview_only",
                confidenceScore: 0.72,
                riskScore: 0.44,
                parityValid: true,
            },
        }));
        (0, vitest_1.expect)(output).toContain("Confidence: 0.4 -> 0.72");
    });
    (0, vitest_1.it)("renders unchanged risk", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Risk: unchanged (0.44)");
    });
    (0, vitest_1.it)("renders changed risk", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            riskChanged: true,
            previous: {
                mode: "preview_only",
                confidenceScore: 0.55,
                riskScore: 0.81,
                parityValid: true,
            },
            current: {
                mode: "preview_only",
                confidenceScore: 0.55,
                riskScore: 0.21,
                parityValid: true,
            },
        }));
        (0, vitest_1.expect)(output).toContain("Risk: 0.81 -> 0.21");
    });
    (0, vitest_1.it)("renders unchanged parity", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Parity: unchanged (true)");
    });
    (0, vitest_1.it)("renders changed parity", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            parityChanged: true,
            previous: {
                mode: "preview_only",
                confidenceScore: 0.55,
                riskScore: 0.44,
                parityValid: true,
            },
            current: {
                mode: "preview_only",
                confidenceScore: 0.55,
                riskScore: 0.44,
                parityValid: false,
            },
        }));
        (0, vitest_1.expect)(output).toContain("Parity: true -> false");
    });
    (0, vitest_1.it)("renders no reason code changes", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Reason Codes: no changes");
    });
    (0, vitest_1.it)("renders added reason codes", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            reasonCodesAdded: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"],
        }));
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("+ SAFE_LOW_RISK");
        (0, vitest_1.expect)(output).toContain("+ SAFE_HIGH_CONFIDENCE");
    });
    (0, vitest_1.it)("renders removed reason codes", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            reasonCodesRemoved: ["BLOCKED_SCHEMA_RISK"],
        }));
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("- BLOCKED_SCHEMA_RISK");
    });
    (0, vitest_1.it)("renders no contradiction flag changes", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Contradiction Flags: no changes");
    });
    (0, vitest_1.it)("renders added contradiction flags", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            contradictionFlagsAdded: ["MODE_REASON_MISMATCH"],
        }));
        (0, vitest_1.expect)(output).toContain("Contradiction Flags:");
        (0, vitest_1.expect)(output).toContain("+ MODE_REASON_MISMATCH");
    });
    (0, vitest_1.it)("renders removed contradiction flags", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            contradictionFlagsRemoved: ["TRACE_REASON_MISSING"],
        }));
        (0, vitest_1.expect)(output).toContain("Contradiction Flags:");
        (0, vitest_1.expect)(output).toContain("- TRACE_REASON_MISSING");
    });
    (0, vitest_1.it)("renders unchanged trace reason mapping", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff());
        (0, vitest_1.expect)(output).toContain("Trace Reason Mapping: unchanged");
    });
    (0, vitest_1.it)("renders changed trace reason mapping", () => {
        const output = (0, renderAuditDiff_js_1.renderAuditDiff)(createBaseDiff({
            traceReasonMappingChanged: true,
        }));
        (0, vitest_1.expect)(output).toContain("Trace Reason Mapping: changed");
    });
});
//# sourceMappingURL=renderAuditDiff.test.js.map