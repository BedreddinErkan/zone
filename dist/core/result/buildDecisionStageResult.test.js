"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionStageResult_js_1 = require("./buildDecisionStageResult.js");
// ── helpers ───────────────────────────────────────────────────────────────────
function makeResult(overrides) {
    return {
        mode: "safe_to_apply",
        confidenceScore: 1,
        reasons: [],
        ...overrides,
    };
}
// ── tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildDecisionStageResult", () => {
    (0, vitest_1.it)("blocked with schema error reason → ZONE_BLOCKED_SCHEMA_ERROR", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({
            mode: "blocked",
            reasons: [
                {
                    code: "SCHEMA_VALIDATION_ERROR",
                    severity: "critical",
                    message: "Schema field missing",
                },
            ],
        }));
        (0, vitest_1.expect)(result.status).toBe("blocked");
        (0, vitest_1.expect)(result.severity).toBe("fatal");
        (0, vitest_1.expect)(result.code).toBe("ZONE_BLOCKED_SCHEMA_ERROR");
        (0, vitest_1.expect)(result.stage).toBe("decision");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
    (0, vitest_1.it)("blocked without schema error reason → ZONE_BLOCKED_HIGH_RISK", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({
            mode: "blocked",
            reasons: [
                {
                    code: "PATCH_VALIDATION_ERROR",
                    severity: "critical",
                    message: "Patch target not found",
                },
            ],
        }));
        (0, vitest_1.expect)(result.code).toBe("ZONE_BLOCKED_HIGH_RISK");
        (0, vitest_1.expect)(result.severity).toBe("fatal");
        (0, vitest_1.expect)(result.status).toBe("blocked");
    });
    (0, vitest_1.it)("preview_only → success / warning / ZONE_PREVIEW_ONLY", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({
            mode: "preview_only",
            reasons: [
                {
                    code: "PATCH_VALIDATION_WARNING",
                    severity: "warning",
                    message: "Low confidence detected",
                },
            ],
        }));
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("warning");
        (0, vitest_1.expect)(result.code).toBe("ZONE_PREVIEW_ONLY");
    });
    (0, vitest_1.it)("safe_to_apply → success / ok / ZONE_OK", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({
            mode: "safe_to_apply",
            reasons: [
                {
                    code: "SAFE_TO_APPLY",
                    severity: "info",
                    message: "No blocking risks detected.",
                },
            ],
        }));
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_OK");
    });
    (0, vitest_1.it)("details is set when reasons are non-empty — joined with ' | '", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({
            mode: "preview_only",
            reasons: [
                { code: "PATCH_VALIDATION_WARNING", severity: "warning", message: "A" },
                { code: "SCHEMA_VALIDATION_WARNING", severity: "warning", message: "B" },
            ],
        }));
        (0, vitest_1.expect)(result.details).toBe("A | B");
    });
    (0, vitest_1.it)("details is absent when reasons are empty", () => {
        const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({ mode: "safe_to_apply", reasons: [] }));
        (0, vitest_1.expect)(result.details).toBeUndefined();
    });
    (0, vitest_1.it)("summary is deterministic per mode", () => {
        (0, vitest_1.expect)((0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({ mode: "blocked", reasons: [{ code: "PATCH_VALIDATION_ERROR", severity: "critical", message: "x" }] })).summary).toBe("Decision blocked: automatic apply is not permitted.");
        (0, vitest_1.expect)((0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({ mode: "preview_only", reasons: [{ code: "PATCH_VALIDATION_WARNING", severity: "warning", message: "x" }] })).summary).toBe("Decision preview only: manual review is required before apply.");
        (0, vitest_1.expect)((0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({ mode: "safe_to_apply", reasons: [] })).summary).toBe("Decision safe to apply: no blocking risks detected.");
    });
    (0, vitest_1.it)("meta is always stamped correctly regardless of input", () => {
        for (const mode of ["blocked", "preview_only", "safe_to_apply"]) {
            const reasons = mode === "safe_to_apply"
                ? []
                : [{ code: "PATCH_VALIDATION_WARNING", severity: "warning", message: "x" }];
            const result = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(makeResult({ mode, reasons }));
            (0, vitest_1.expect)(result.meta.stage).toBe("decision");
            (0, vitest_1.expect)(result.meta.engine).toBe("zone");
            (0, vitest_1.expect)(result.meta.version).toBe("2.0");
        }
    });
});
//# sourceMappingURL=buildDecisionStageResult.test.js.map