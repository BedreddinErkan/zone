"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderBundledResult_js_1 = require("./renderBundledResult.js");
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
// ── helpers ───────────────────────────────────────────────────────────────────
function makeDecisionStage(overrides = {}) {
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "decision",
        status: "success",
        severity: "ok",
        code: "ZONE_OK",
        summary: "Decision OK",
        ...overrides,
    });
}
function makeConversionStage(overrides = {}) {
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "generated_patch_conversion",
        status: "success",
        severity: "ok",
        code: "ZONE_OK",
        summary: "Conversion OK",
        ...overrides,
    });
}
function makeApplyStage(overrides = {}) {
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "apply",
        status: "success",
        severity: "ok",
        code: "ZONE_APPLY_SUCCESS",
        summary: "Apply OK",
        ...overrides,
    });
}
// ── tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("renderBundledResult", () => {
    // 1. header fields
    (0, vitest_1.it)("renders header fields correctly", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage() },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("=== ZONE BUNDLED RESULT ===");
        (0, vitest_1.expect)(output).toContain("Engine: zone");
        (0, vitest_1.expect)(output).toContain("Version: 2.0");
        (0, vitest_1.expect)(output).toContain("Overall Status:");
        (0, vitest_1.expect)(output).toContain("Overall Severity:");
    });
    // 2. decision stage section
    (0, vitest_1.it)("renders decision stage section", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage({ code: "ZONE_OK", summary: "All good" }) },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("--- Stage: decision ---");
        (0, vitest_1.expect)(output).toContain("Code: ZONE_OK");
        (0, vitest_1.expect)(output).toContain("Summary: All good");
    });
    // 3. details line present when defined
    (0, vitest_1.it)("renders details line when details is defined", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage({ details: "some detail" }) },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("Details: some detail");
    });
    // 4. details line absent when undefined
    (0, vitest_1.it)("omits details line when details is undefined", () => {
        const stage = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "decision",
            status: "success",
            severity: "ok",
            code: "ZONE_OK",
            summary: "OK",
            // no details
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).not.toContain("Details:");
    });
    // 5. conversion stage rendered when present
    (0, vitest_1.it)("renders generated_patch_conversion stage when present", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeDecisionStage(),
                generated_patch_conversion: makeConversionStage(),
            },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("--- Stage: generated_patch_conversion ---");
    });
    // 6. apply stage rendered when present
    (0, vitest_1.it)("renders apply stage when present", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeDecisionStage(),
                apply: makeApplyStage(),
            },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("--- Stage: apply ---");
    });
    // 7. missing stages are not rendered
    (0, vitest_1.it)("omits absent stages", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage() },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).not.toContain("--- Stage: apply ---");
        (0, vitest_1.expect)(output).not.toContain("--- Stage: generated_patch_conversion ---");
    });
    // 8. stage order is always decision → conversion → apply
    (0, vitest_1.it)("renders stages in fixed order: decision → conversion → apply", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeDecisionStage(),
                generated_patch_conversion: makeConversionStage(),
                apply: makeApplyStage(),
            },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        const idxDecision = output.indexOf("--- Stage: decision ---");
        const idxConversion = output.indexOf("--- Stage: generated_patch_conversion ---");
        const idxApply = output.indexOf("--- Stage: apply ---");
        (0, vitest_1.expect)(idxDecision).toBeLessThan(idxConversion);
        (0, vitest_1.expect)(idxConversion).toBeLessThan(idxApply);
    });
    // 9. timestamps section rendered when present
    (0, vitest_1.it)("renders timestamps section when timestamps are provided", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage() },
            timestamps: {
                startedAt: "2026-04-03T10:00:00.000Z",
                completedAt: "2026-04-03T10:00:01.000Z",
                durationMs: 1000,
            },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("--- Timestamps ---");
        (0, vitest_1.expect)(output).toContain("Started: 2026-04-03T10:00:00.000Z");
        (0, vitest_1.expect)(output).toContain("Duration: 1000ms");
    });
    // 10. timestamps section absent when not present
    (0, vitest_1.it)("omits timestamps section when timestamps are not provided", () => {
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: makeDecisionStage() },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).not.toContain("--- Timestamps ---");
    });
});
//# sourceMappingURL=renderBundledResult.test.js.map