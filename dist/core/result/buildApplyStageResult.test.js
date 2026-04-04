"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildApplyStageResult_js_1 = require("./buildApplyStageResult.js");
// ── helpers ───────────────────────────────────────────────────────────────────
function buildFlowResult(overrides) {
    return {
        status: "applied",
        operationsAttempted: 1,
        operationsApplied: 1,
        filesTouched: ["src/index.ts"],
        backupCreated: true,
        message: "Patch applied successfully.",
        operationResults: [],
        ...overrides,
    };
}
// ── tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildApplyStageResult", () => {
    // 1. applied → success path
    (0, vitest_1.it)("applied → success path", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({}));
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_APPLY_SUCCESS");
        (0, vitest_1.expect)(result.stage).toBe("apply");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
        (0, vitest_1.expect)(result.summary).toBe("Apply succeeded: all operations applied successfully.");
        (0, vitest_1.expect)(result.details).toBe("Files touched: src/index.ts");
    });
    // 2. failed with partial success → ZONE_APPLY_PARTIAL
    (0, vitest_1.it)("failed with partial success → ZONE_APPLY_PARTIAL", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ status: "failed", operationsApplied: 1, operationsAttempted: 2 }));
        (0, vitest_1.expect)(result.severity).toBe("error");
        (0, vitest_1.expect)(result.code).toBe("ZONE_APPLY_PARTIAL");
        (0, vitest_1.expect)(result.status).toBe("failed");
        (0, vitest_1.expect)(result.summary).toBe("Apply partially failed: some operations were not applied.");
    });
    // 3. failed with zero applied → ZONE_APPLY_FAILED
    (0, vitest_1.it)("failed with zero applied → ZONE_APPLY_FAILED", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ status: "failed", operationsApplied: 0, operationsAttempted: 1 }));
        (0, vitest_1.expect)(result.severity).toBe("fatal");
        (0, vitest_1.expect)(result.code).toBe("ZONE_APPLY_FAILED");
        (0, vitest_1.expect)(result.status).toBe("failed");
        (0, vitest_1.expect)(result.summary).toBe("Apply failed: no operations were applied.");
    });
    // 4. skipped → ZONE_SKIPPED
    (0, vitest_1.it)("skipped → ZONE_SKIPPED", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ status: "skipped", operationsAttempted: 0, operationsApplied: 0, filesTouched: [] }));
        (0, vitest_1.expect)(result.status).toBe("skipped");
        (0, vitest_1.expect)(result.severity).toBe("warning");
        (0, vitest_1.expect)(result.code).toBe("ZONE_SKIPPED");
        (0, vitest_1.expect)(result.summary).toBe("Apply skipped: no operations were executed.");
    });
    // 5. details present when filesTouched non-empty
    (0, vitest_1.it)("details is set when filesTouched has entries", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ filesTouched: ["src/a.ts", "src/b.ts"] }));
        (0, vitest_1.expect)(result.details).toBe("Files touched: src/a.ts, src/b.ts");
    });
    // 6. details absent when filesTouched is empty
    (0, vitest_1.it)("details is absent when filesTouched is empty", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ filesTouched: [] }));
        (0, vitest_1.expect)(result.details).toBeUndefined();
    });
    // 7. meta invariant — applied path
    (0, vitest_1.it)("meta is stamped correctly for applied", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({}));
        (0, vitest_1.expect)(result.meta.stage).toBe("apply");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
    // 8. meta invariant — failed path
    (0, vitest_1.it)("meta is stamped correctly for failed", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ status: "failed", operationsApplied: 0 }));
        (0, vitest_1.expect)(result.meta.stage).toBe("apply");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
    // 9. meta invariant — skipped path
    (0, vitest_1.it)("meta is stamped correctly for skipped", () => {
        const result = (0, buildApplyStageResult_js_1.buildApplyStageResult)(buildFlowResult({ status: "skipped", operationsAttempted: 0, operationsApplied: 0, filesTouched: [] }));
        (0, vitest_1.expect)(result.meta.stage).toBe("apply");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
});
//# sourceMappingURL=buildApplyStageResult.test.js.map