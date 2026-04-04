"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildReasonSummaryLine_js_1 = require("./buildReasonSummaryLine.js");
(0, vitest_1.describe)("buildReasonSummaryLine", () => {
    (0, vitest_1.it)("returns fallback when no reason codes exist", () => {
        (0, vitest_1.expect)((0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)([])).toBe("Why: no explicit decision reasons.");
    });
    (0, vitest_1.it)("returns deterministic blocked summary line from metadata summaries", () => {
        const output = (0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(output).toBe("Why: Task includes destructive intent and should not be auto-applied; Task touches schema-sensitive areas and may break existing contracts; Overall risk score exceeded the blocked threshold for auto-apply.");
    });
    (0, vitest_1.it)("returns deterministic preview summary line from metadata summaries", () => {
        const output = (0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)([
            "PREVIEW_MASS_SCOPE_CHANGE",
            "PREVIEW_LOW_CONFIDENCE"
        ]);
        (0, vitest_1.expect)(output).toBe("Why: Task appears to affect many records or a broad surface area; Confidence score is below the safe threshold, so preview is safer.");
    });
    (0, vitest_1.it)("returns deterministic safe summary line from metadata summaries", () => {
        const output = (0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)([
            "SAFE_LOW_RISK_LOCALIZED",
            "SAFE_HIGH_CONFIDENCE"
        ]);
        (0, vitest_1.expect)(output).toBe("Why: Task appears narrowly scoped and low risk for automatic application; Confidence score is strong enough to support safe auto-apply.");
    });
    (0, vitest_1.it)("deduplicates repeated reason codes", () => {
        const output = (0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(output).toBe("Why: Task includes destructive intent and should not be auto-applied; Overall risk score exceeded the blocked threshold for auto-apply.");
    });
    (0, vitest_1.it)("returns the same output for the same input", () => {
        const input = [
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ];
        (0, vitest_1.expect)((0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)(input)).toBe((0, buildReasonSummaryLine_js_1.buildReasonSummaryLine)(input));
    });
});
//# sourceMappingURL=buildReasonSummaryLine.test.js.map