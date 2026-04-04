"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildPreviewStageResult_js_1 = require("./buildPreviewStageResult.js");
// ── helpers ───────────────────────────────────────────────────────────────────
function makePlan(overrides = {}) {
    return {
        version: 1,
        intent: "safe_replace",
        operations: [],
        summary: "Test plan",
        warnings: [],
        ...overrides,
    };
}
const safeReplaceOp = {
    type: "safe_replace",
    filePath: "src/index.ts",
    find: "foo",
    replaceWith: "bar",
    matchMode: "exact",
};
const renameOp = {
    type: "rename_symbol",
    filePath: "src/utils.ts",
    from: "oldName",
    to: "newName",
};
// ── tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildPreviewStageResult", () => {
    (0, vitest_1.it)("stage is always 'generated_patch_preview'", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan());
        (0, vitest_1.expect)(result.stage).toBe("generated_patch_preview");
    });
    (0, vitest_1.it)("meta is always stamped correctly", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp] }));
        (0, vitest_1.expect)(result.meta.stage).toBe("generated_patch_preview");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
    // ── zero operations ──────────────────────────────────────────────────────
    (0, vitest_1.it)("zero operations → status: info, severity: warning, code: ZONE_SKIPPED", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [] }));
        (0, vitest_1.expect)(result.status).toBe("info");
        (0, vitest_1.expect)(result.severity).toBe("warning");
        (0, vitest_1.expect)(result.code).toBe("ZONE_SKIPPED");
    });
    (0, vitest_1.it)("zero operations → summary mentions no operations", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [] }));
        (0, vitest_1.expect)(result.summary).toBe("Generated patch preview contains no operations.");
    });
    (0, vitest_1.it)("zero operations → details is undefined", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [] }));
        (0, vitest_1.expect)(result.details).toBeUndefined();
    });
    // ── one operation ────────────────────────────────────────────────────────
    (0, vitest_1.it)("one operation → status: success, severity: ok, code: ZONE_OK", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp] }));
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_OK");
    });
    (0, vitest_1.it)("one operation → summary uses singular form", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp] }));
        (0, vitest_1.expect)(result.summary).toBe("Generated patch preview contains 1 operation.");
    });
    (0, vitest_1.it)("one operation → details lists the operation with filePath", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp] }));
        (0, vitest_1.expect)(result.details).toBe("1. safe_replace -> src/index.ts");
    });
    // ── multiple operations ──────────────────────────────────────────────────
    (0, vitest_1.it)("multiple operations → status: success, severity: ok, code: ZONE_OK", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp, renameOp] }));
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_OK");
    });
    (0, vitest_1.it)("multiple operations → summary uses plural form with count", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp, renameOp] }));
        (0, vitest_1.expect)(result.summary).toBe("Generated patch preview contains 2 operations.");
    });
    (0, vitest_1.it)("multiple operations → details lists all operations in order", () => {
        const result = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp, renameOp] }));
        (0, vitest_1.expect)(result.details).toBe("1. safe_replace -> src/index.ts\n2. rename_symbol -> src/utils.ts");
    });
    // ── timestamps not set ───────────────────────────────────────────────────
    (0, vitest_1.it)("timestamps is never set by this builder", () => {
        const withOps = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [safeReplaceOp] }));
        const withoutOps = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(makePlan({ operations: [] }));
        (0, vitest_1.expect)(withOps.timestamps).toBeUndefined();
        (0, vitest_1.expect)(withoutOps.timestamps).toBeUndefined();
    });
});
//# sourceMappingURL=buildPreviewStageResult.test.js.map