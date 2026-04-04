"use strict";
/**
 * V2 pipeline parity tests.
 *
 * Each test drives the full v2 chain from the live decision engine
 * through to the rendered bundled output, mirroring the pattern of the
 * existing v1 parity tests (pipelineSafeToApplyParity, pipelineBlockedParity,
 * pipelinePreviewParity, pipelineHighRiskPreviewParity).
 *
 * Chain under test:
 *   decideExecutionMode()
 *     → buildDecisionStageResult()
 *       → buildBundledResult()
 *         → renderBundledResult()
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const decideExecutionMode_js_1 = require("../decision/decideExecutionMode.js");
const buildDecisionStageResult_js_1 = require("./buildDecisionStageResult.js");
const buildStageResultV2_js_1 = require("./buildStageResultV2.js");
const renderBundledResult_js_1 = require("./renderBundledResult.js");
const buildPreviewStageResult_js_1 = require("./buildPreviewStageResult.js");
const buildConversionStageResult_js_1 = require("./buildConversionStageResult.js");
const buildApplyStageResult_js_1 = require("./buildApplyStageResult.js");
// ── shared fixtures ───────────────────────────────────────────────────────────
const EMPTY_PREVIEW_PLAN = {
    version: 1,
    intent: "safe_replace",
    operations: [],
    summary: "No operations generated.",
    warnings: [],
};
const SINGLE_OP_PREVIEW_PLAN = {
    version: 1,
    intent: "safe_replace",
    operations: [
        {
            type: "safe_replace",
            filePath: "src/index.ts",
            find: "foo",
            replaceWith: "bar",
            matchMode: "exact",
        },
    ],
    summary: "Replace foo with bar.",
    warnings: [],
};
const CONVERSION_SUCCESS = { canConvert: true };
const CONVERSION_FAILURE = {
    canConvert: false,
    code: "PLACEHOLDER_FILE_PATH",
    reason: "File path contains a placeholder.",
};
function makeApplyResult(overrides = {}) {
    return {
        status: "applied",
        operationsAttempted: 1,
        operationsApplied: 1,
        filesTouched: ["src/index.ts"],
        backupCreated: true,
        message: "Applied successfully.",
        operationResults: [],
        ...overrides,
    };
}
// ── safe_to_apply flow ────────────────────────────────────────────────────────
(0, vitest_1.describe)("v2 pipeline parity — safe_to_apply", () => {
    (0, vitest_1.it)("decision stage resolves to ZONE_OK / ok / success", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(decision.mode).toBe("safe_to_apply");
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        (0, vitest_1.expect)(stage.code).toBe("ZONE_OK");
        (0, vitest_1.expect)(stage.severity).toBe("ok");
        (0, vitest_1.expect)(stage.status).toBe("success");
        (0, vitest_1.expect)(stage.stage).toBe("decision");
        (0, vitest_1.expect)(stage.meta.engine).toBe("zone");
        (0, vitest_1.expect)(stage.meta.version).toBe("2.0");
    });
    (0, vitest_1.it)("bundled result has overallStatus: success and overallSeverity: ok", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("success");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("ok");
        (0, vitest_1.expect)(bundled.engine).toBe("zone");
        (0, vitest_1.expect)(bundled.version).toBe("2.0");
    });
    (0, vitest_1.it)("rendered output contains correct header and decision section", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("=== ZONE BUNDLED RESULT ===");
        (0, vitest_1.expect)(output).toContain("Overall Status: success");
        (0, vitest_1.expect)(output).toContain("Overall Severity: ok");
        (0, vitest_1.expect)(output).toContain("--- Stage: decision ---");
        (0, vitest_1.expect)(output).toContain("Code: ZONE_OK");
        (0, vitest_1.expect)(output).toContain("Summary: Decision safe to apply: no blocking risks detected.");
    });
});
// ── preview_only flow ─────────────────────────────────────────────────────────
(0, vitest_1.describe)("v2 pipeline parity — preview_only", () => {
    (0, vitest_1.it)("decision stage resolves to ZONE_PREVIEW_ONLY / warning / success", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 55,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(decision.mode).toBe("preview_only");
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        (0, vitest_1.expect)(stage.code).toBe("ZONE_PREVIEW_ONLY");
        (0, vitest_1.expect)(stage.severity).toBe("warning");
        (0, vitest_1.expect)(stage.status).toBe("success");
    });
    (0, vitest_1.it)("bundled result has overallStatus: success and overallSeverity: warning", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 55,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("success");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("warning");
    });
    (0, vitest_1.it)("rendered output contains ZONE_PREVIEW_ONLY and warning severity", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 55,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("Code: ZONE_PREVIEW_ONLY");
        (0, vitest_1.expect)(output).toContain("Overall Severity: warning");
        (0, vitest_1.expect)(output).toContain("Summary: Decision preview only: manual review is required before apply.");
    });
});
// ── blocked flow ─────────────────────────────────────────────────────────────
(0, vitest_1.describe)("v2 pipeline parity — blocked", () => {
    (0, vitest_1.it)("blocked by schema error resolves to ZONE_BLOCKED_SCHEMA_ERROR / fatal / blocked", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                { level: "error", code: "SCHEMA_FIELD_MISMATCH", message: "Schema mismatch detected." },
            ],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(decision.mode).toBe("blocked");
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        (0, vitest_1.expect)(stage.code).toBe("ZONE_BLOCKED_SCHEMA_ERROR");
        (0, vitest_1.expect)(stage.severity).toBe("fatal");
        (0, vitest_1.expect)(stage.status).toBe("blocked");
    });
    (0, vitest_1.it)("bundled result has overallStatus: blocked and overallSeverity: fatal", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                { level: "error", code: "SCHEMA_FIELD_MISMATCH", message: "Schema mismatch detected." },
            ],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("blocked");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("fatal");
    });
    (0, vitest_1.it)("rendered output contains ZONE_BLOCKED_SCHEMA_ERROR and fatal severity", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                { level: "error", code: "SCHEMA_FIELD_MISMATCH", message: "Schema mismatch detected." },
            ],
            hasValidatedFiles: true,
        });
        const stage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({ stages: { decision: stage } });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(output).toContain("Code: ZONE_BLOCKED_SCHEMA_ERROR");
        (0, vitest_1.expect)(output).toContain("Overall Status: blocked");
        (0, vitest_1.expect)(output).toContain("Overall Severity: fatal");
        (0, vitest_1.expect)(output).toContain("Details: Schema mismatch detected.");
    });
});
// ── multi-stage bundled result ────────────────────────────────────────────────
(0, vitest_1.describe)("v2 pipeline parity — multi-stage bundled result", () => {
    (0, vitest_1.it)("decision + preview: overallSeverity is ok when both stages are ok", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const decisionStage = (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision);
        const previewStage = (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN);
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: decisionStage,
                generated_patch_preview: previewStage,
            },
        });
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("ok");
        (0, vitest_1.expect)(bundled.overallStatus).toBe("success");
    });
    (0, vitest_1.it)("decision + preview + conversion success: all ok propagates correctly", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision),
                generated_patch_preview: (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN),
                generated_patch_conversion: (0, buildConversionStageResult_js_1.buildConversionStageResult)(CONVERSION_SUCCESS),
            },
        });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("success");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("ok");
    });
    (0, vitest_1.it)("conversion failure escalates overallStatus to blocked and severity to fatal", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision),
                generated_patch_preview: (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN),
                generated_patch_conversion: (0, buildConversionStageResult_js_1.buildConversionStageResult)(CONVERSION_FAILURE),
            },
        });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("blocked");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("fatal");
    });
    (0, vitest_1.it)("full four-stage success pipeline: overallStatus success, overallSeverity ok", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision),
                generated_patch_preview: (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN),
                generated_patch_conversion: (0, buildConversionStageResult_js_1.buildConversionStageResult)(CONVERSION_SUCCESS),
                apply: (0, buildApplyStageResult_js_1.buildApplyStageResult)(makeApplyResult()),
            },
        });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("success");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("ok");
        (0, vitest_1.expect)(bundled.stages.decision?.code).toBe("ZONE_OK");
        (0, vitest_1.expect)(bundled.stages.generated_patch_preview?.code).toBe("ZONE_OK");
        (0, vitest_1.expect)(bundled.stages.generated_patch_conversion?.code).toBe("ZONE_OK");
        (0, vitest_1.expect)(bundled.stages.apply?.code).toBe("ZONE_APPLY_SUCCESS");
    });
    (0, vitest_1.it)("full four-stage success: rendered output contains all four stage sections in order", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision),
                generated_patch_preview: (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN),
                generated_patch_conversion: (0, buildConversionStageResult_js_1.buildConversionStageResult)(CONVERSION_SUCCESS),
                apply: (0, buildApplyStageResult_js_1.buildApplyStageResult)(makeApplyResult()),
            },
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        const idxDecision = output.indexOf("--- Stage: decision ---");
        const idxPreview = output.indexOf("--- Stage: generated_patch_preview ---");
        const idxConversion = output.indexOf("--- Stage: generated_patch_conversion ---");
        const idxApply = output.indexOf("--- Stage: apply ---");
        (0, vitest_1.expect)(idxDecision).toBeGreaterThan(-1);
        (0, vitest_1.expect)(idxPreview).toBeGreaterThan(-1);
        (0, vitest_1.expect)(idxConversion).toBeGreaterThan(-1);
        (0, vitest_1.expect)(idxApply).toBeGreaterThan(-1);
        (0, vitest_1.expect)(idxDecision).toBeLessThan(idxPreview);
        (0, vitest_1.expect)(idxPreview).toBeLessThan(idxConversion);
        (0, vitest_1.expect)(idxConversion).toBeLessThan(idxApply);
    });
    (0, vitest_1.it)("apply failure downgrades bundled result correctly", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: {
                decision: (0, buildDecisionStageResult_js_1.buildDecisionStageResult)(decision),
                generated_patch_preview: (0, buildPreviewStageResult_js_1.buildPreviewStageResult)(SINGLE_OP_PREVIEW_PLAN),
                generated_patch_conversion: (0, buildConversionStageResult_js_1.buildConversionStageResult)(CONVERSION_SUCCESS),
                apply: (0, buildApplyStageResult_js_1.buildApplyStageResult)(makeApplyResult({ status: "failed", operationsApplied: 0 })),
            },
        });
        (0, vitest_1.expect)(bundled.overallStatus).toBe("failed");
        (0, vitest_1.expect)(bundled.overallSeverity).toBe("fatal");
        (0, vitest_1.expect)(bundled.stages.apply?.code).toBe("ZONE_APPLY_FAILED");
    });
    (0, vitest_1.it)("timestamps propagate through the full chain when provided", () => {
        const ts = {
            startedAt: "2026-04-03T10:00:00.000Z",
            completedAt: "2026-04-03T10:00:02.000Z",
            durationMs: 2000,
        };
        const decisionStage = (0, buildStageResultV2_js_1.buildStageResultV2)({
            stage: "decision",
            status: "success",
            severity: "ok",
            code: "ZONE_OK",
            summary: "OK",
            timestamps: ts,
        });
        const bundled = (0, buildStageResultV2_js_1.buildBundledResult)({
            stages: { decision: decisionStage },
            timestamps: ts,
        });
        const output = (0, renderBundledResult_js_1.renderBundledResult)(bundled);
        (0, vitest_1.expect)(bundled.timestamps).toEqual(ts);
        (0, vitest_1.expect)(output).toContain("--- Timestamps ---");
        (0, vitest_1.expect)(output).toContain("Started: 2026-04-03T10:00:00.000Z");
        (0, vitest_1.expect)(output).toContain("Duration: 2000ms");
    });
});
//# sourceMappingURL=pipelineV2Parity.test.js.map