"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
// ── helpers ───────────────────────────────────────────────────────────────────
function makeStage(overrides = {}) {
    return (0, buildStageResultV2_js_1.buildStageResultV2)({
        stage: "decision",
        status: "success",
        severity: "ok",
        code: "ZONE_OK",
        summary: "All good",
        ...overrides,
    });
}
// ── buildStageResultV2 ────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildStageResultV2", () => {
    (0, vitest_1.it)("returns the correct shape with all required fields", () => {
        const result = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "apply",
            status: "success",
            severity: "ok",
            code: "ZONE_APPLY_SUCCESS",
            summary: "Apply succeeded",
        });
        (0, vitest_1.expect)(result.stage).toBe("apply");
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_APPLY_SUCCESS");
        (0, vitest_1.expect)(result.summary).toBe("Apply succeeded");
        (0, vitest_1.expect)(result.meta).toBeDefined();
    });
    (0, vitest_1.it)("meta always has engine: 'zone', version: '2.0', and stage matching input", () => {
        const result = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "generated_patch_conversion",
            status: "failed",
            severity: "error",
            code: "ZONE_CONVERSION_FAILED",
            summary: "Conversion failed",
        });
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
        (0, vitest_1.expect)(result.meta.stage).toBe("generated_patch_conversion");
    });
    (0, vitest_1.it)("details is absent when not provided", () => {
        const result = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "decision",
            status: "success",
            severity: "ok",
            code: "ZONE_OK",
            summary: "OK",
        });
        (0, vitest_1.expect)(result.details).toBeUndefined();
    });
    (0, vitest_1.it)("timestamps is absent when not provided", () => {
        const result = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "decision",
            status: "success",
            severity: "ok",
            code: "ZONE_OK",
            summary: "OK",
        });
        (0, vitest_1.expect)(result.timestamps).toBeUndefined();
    });
    (0, vitest_1.it)("includes details and timestamps when provided", () => {
        const ts = { startedAt: "2026-04-03T00:00:00Z", completedAt: "2026-04-03T00:00:01Z", durationMs: 1000 };
        const result = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "apply",
            status: "success",
            severity: "ok",
            code: "ZONE_APPLY_SUCCESS",
            summary: "Done",
            details: "All files written",
            timestamps: ts,
        });
        (0, vitest_1.expect)(result.details).toBe("All files written");
        (0, vitest_1.expect)(result.timestamps).toEqual(ts);
    });
});
// ── buildBundledResult ────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildBundledResult", () => {
    (0, vitest_1.it)("engine is always 'zone' and version is always '2.0'", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: {} });
        (0, vitest_1.expect)(result.engine).toBe("zone");
        (0, vitest_1.expect)(result.version).toBe("2.0");
    });
    (0, vitest_1.it)("overallSeverity is 'fatal' when any stage has severity 'fatal'", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ severity: "fatal", status: "failed", code: "ZONE_BLOCKED_HIGH_RISK" }),
                apply: makeStage({ severity: "ok" }),
            },
        });
        (0, vitest_1.expect)(result.overallSeverity).toBe("fatal");
    });
    (0, vitest_1.it)("overallSeverity is 'error' when any stage has severity 'error' (no fatal)", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ severity: "error", status: "failed", code: "ZONE_CONVERSION_FAILED" }),
                apply: makeStage({ severity: "warning" }),
            },
        });
        (0, vitest_1.expect)(result.overallSeverity).toBe("error");
    });
    (0, vitest_1.it)("overallSeverity is 'warning' when any stage has severity 'warning' (no error or fatal)", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ severity: "warning" }),
                apply: makeStage({ severity: "ok" }),
            },
        });
        (0, vitest_1.expect)(result.overallSeverity).toBe("warning");
    });
    (0, vitest_1.it)("overallSeverity is 'ok' when all stages have severity 'ok'", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ severity: "ok" }),
                apply: makeStage({ severity: "ok" }),
            },
        });
        (0, vitest_1.expect)(result.overallSeverity).toBe("ok");
    });
    (0, vitest_1.it)("overallSeverity is 'ok' when stages is empty", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: {} });
        (0, vitest_1.expect)(result.overallSeverity).toBe("ok");
    });
    (0, vitest_1.it)("overallStatus is 'blocked' when any stage has status 'blocked'", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ status: "blocked", severity: "fatal", code: "ZONE_BLOCKED_HIGH_RISK" }),
                apply: makeStage({ status: "success" }),
            },
        });
        (0, vitest_1.expect)(result.overallStatus).toBe("blocked");
    });
    (0, vitest_1.it)("overallStatus is 'failed' when any stage has status 'failed' (no blocked)", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ status: "failed", severity: "error", code: "ZONE_CONVERSION_FAILED" }),
                apply: makeStage({ status: "success" }),
            },
        });
        (0, vitest_1.expect)(result.overallStatus).toBe("failed");
    });
    (0, vitest_1.it)("overallStatus is 'success' when all stages have status 'success'", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ status: "success" }),
                apply: makeStage({ status: "success", code: "ZONE_APPLY_SUCCESS" }),
            },
        });
        (0, vitest_1.expect)(result.overallStatus).toBe("success");
    });
    (0, vitest_1.it)("overallStatus is 'info' when stages are mixed non-blocked/non-failed/non-all-success", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: makeStage({ status: "success" }),
                apply: makeStage({ status: "skipped", code: "ZONE_SKIPPED" }),
            },
        });
        (0, vitest_1.expect)(result.overallStatus).toBe("info");
    });
    (0, vitest_1.it)("passes through the stages map unchanged", () => {
        const decisionStage = makeStage({ stage: "decision" });
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: decisionStage },
        });
        (0, vitest_1.expect)(result.stages.decision).toEqual(decisionStage);
    });
    (0, vitest_1.it)("includes timestamps when provided", () => {
        const ts = { startedAt: "2026-04-03T00:00:00Z", completedAt: "2026-04-03T00:00:05Z", durationMs: 5000 };
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: {}, timestamps: ts });
        (0, vitest_1.expect)(result.timestamps).toEqual(ts);
    });
    (0, vitest_1.it)("timestamps is absent when not provided", () => {
        const result = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: {} });
        (0, vitest_1.expect)(result.timestamps).toBeUndefined();
    });
});
//# sourceMappingURL=buildStageResultV2.test.js.map