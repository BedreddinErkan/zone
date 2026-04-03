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

import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../decision/decideExecutionMode.js";
import { buildDecisionStageResult } from "./buildDecisionStageResult.js";
import { buildBundledResult, buildStageResultV2 } from "./buildStageResultV2.js";
import { renderBundledResult } from "./renderBundledResult.js";
import { buildPreviewStageResult } from "./buildPreviewStageResult.js";
import { buildConversionStageResult } from "./buildConversionStageResult.js";
import { buildApplyStageResult } from "./buildApplyStageResult.js";
import type { GeneratedPatchPlan } from "../../patch-generation/generatedPatchPlanTypes.js";
import type { GeneratedPlanConversionCheck } from "../../patch/conversion/generatedPlanConversionTypes.js";
import type { ApplyFlowResult } from "../../patch/applyFlowTypes.js";

// ── shared fixtures ───────────────────────────────────────────────────────────

const EMPTY_PREVIEW_PLAN: GeneratedPatchPlan = {
  version: 1,
  intent: "safe_replace",
  operations: [],
  summary: "No operations generated.",
  warnings: [],
};

const SINGLE_OP_PREVIEW_PLAN: GeneratedPatchPlan = {
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

const CONVERSION_SUCCESS: GeneratedPlanConversionCheck = { canConvert: true };

const CONVERSION_FAILURE: GeneratedPlanConversionCheck = {
  canConvert: false,
  code: "PLACEHOLDER_FILE_PATH",
  reason: "File path contains a placeholder.",
};

function makeApplyResult(
  overrides: Partial<ApplyFlowResult> = {}
): ApplyFlowResult {
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

describe("v2 pipeline parity — safe_to_apply", () => {
  it("decision stage resolves to ZONE_OK / ok / success", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(decision.mode).toBe("safe_to_apply");

    const stage = buildDecisionStageResult(decision);

    expect(stage.code).toBe("ZONE_OK");
    expect(stage.severity).toBe("ok");
    expect(stage.status).toBe("success");
    expect(stage.stage).toBe("decision");
    expect(stage.meta.engine).toBe("zone");
    expect(stage.meta.version).toBe("2.0");
  });

  it("bundled result has overallStatus: success and overallSeverity: ok", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });

    expect(bundled.overallStatus).toBe("success");
    expect(bundled.overallSeverity).toBe("ok");
    expect(bundled.engine).toBe("zone");
    expect(bundled.version).toBe("2.0");
  });

  it("rendered output contains correct header and decision section", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });
    const output = renderBundledResult(bundled);

    expect(output).toContain("=== ZONE BUNDLED RESULT ===");
    expect(output).toContain("Overall Status: success");
    expect(output).toContain("Overall Severity: ok");
    expect(output).toContain("--- Stage: decision ---");
    expect(output).toContain("Code: ZONE_OK");
    expect(output).toContain("Summary: Decision safe to apply: no blocking risks detected.");
  });
});

// ── preview_only flow ─────────────────────────────────────────────────────────

describe("v2 pipeline parity — preview_only", () => {
  it("decision stage resolves to ZONE_PREVIEW_ONLY / warning / success", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 55,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(decision.mode).toBe("preview_only");

    const stage = buildDecisionStageResult(decision);

    expect(stage.code).toBe("ZONE_PREVIEW_ONLY");
    expect(stage.severity).toBe("warning");
    expect(stage.status).toBe("success");
  });

  it("bundled result has overallStatus: success and overallSeverity: warning", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 55,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });

    expect(bundled.overallStatus).toBe("success");
    expect(bundled.overallSeverity).toBe("warning");
  });

  it("rendered output contains ZONE_PREVIEW_ONLY and warning severity", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 55,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });
    const output = renderBundledResult(bundled);

    expect(output).toContain("Code: ZONE_PREVIEW_ONLY");
    expect(output).toContain("Overall Severity: warning");
    expect(output).toContain(
      "Summary: Decision preview only: manual review is required before apply."
    );
  });
});

// ── blocked flow ─────────────────────────────────────────────────────────────

describe("v2 pipeline parity — blocked", () => {
  it("blocked by schema error resolves to ZONE_BLOCKED_SCHEMA_ERROR / fatal / blocked", () => {
    const decision = decideExecutionMode({
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

    expect(decision.mode).toBe("blocked");

    const stage = buildDecisionStageResult(decision);

    expect(stage.code).toBe("ZONE_BLOCKED_SCHEMA_ERROR");
    expect(stage.severity).toBe("fatal");
    expect(stage.status).toBe("blocked");
  });

  it("bundled result has overallStatus: blocked and overallSeverity: fatal", () => {
    const decision = decideExecutionMode({
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

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });

    expect(bundled.overallStatus).toBe("blocked");
    expect(bundled.overallSeverity).toBe("fatal");
  });

  it("rendered output contains ZONE_BLOCKED_SCHEMA_ERROR and fatal severity", () => {
    const decision = decideExecutionMode({
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

    const stage = buildDecisionStageResult(decision);
    const bundled = buildBundledResult({ stages: { decision: stage } });
    const output = renderBundledResult(bundled);

    expect(output).toContain("Code: ZONE_BLOCKED_SCHEMA_ERROR");
    expect(output).toContain("Overall Status: blocked");
    expect(output).toContain("Overall Severity: fatal");
    expect(output).toContain("Details: Schema mismatch detected.");
  });
});

// ── multi-stage bundled result ────────────────────────────────────────────────

describe("v2 pipeline parity — multi-stage bundled result", () => {
  it("decision + preview: overallSeverity is ok when both stages are ok", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const decisionStage = buildDecisionStageResult(decision);
    const previewStage = buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN);

    const bundled = buildBundledResult({
      stages: {
        decision: decisionStage,
        generated_patch_preview: previewStage,
      },
    });

    expect(bundled.overallSeverity).toBe("ok");
    expect(bundled.overallStatus).toBe("success");
  });

  it("decision + preview + conversion success: all ok propagates correctly", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const bundled = buildBundledResult({
      stages: {
        decision: buildDecisionStageResult(decision),
        generated_patch_preview: buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN),
        generated_patch_conversion: buildConversionStageResult(CONVERSION_SUCCESS),
      },
    });

    expect(bundled.overallStatus).toBe("success");
    expect(bundled.overallSeverity).toBe("ok");
  });

  it("conversion failure escalates overallStatus to blocked and severity to fatal", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const bundled = buildBundledResult({
      stages: {
        decision: buildDecisionStageResult(decision),
        generated_patch_preview: buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN),
        generated_patch_conversion: buildConversionStageResult(CONVERSION_FAILURE),
      },
    });

    expect(bundled.overallStatus).toBe("blocked");
    expect(bundled.overallSeverity).toBe("fatal");
  });

  it("full four-stage success pipeline: overallStatus success, overallSeverity ok", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const bundled = buildBundledResult({
      stages: {
        decision: buildDecisionStageResult(decision),
        generated_patch_preview: buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN),
        generated_patch_conversion: buildConversionStageResult(CONVERSION_SUCCESS),
        apply: buildApplyStageResult(makeApplyResult()),
      },
    });

    expect(bundled.overallStatus).toBe("success");
    expect(bundled.overallSeverity).toBe("ok");
    expect(bundled.stages.decision?.code).toBe("ZONE_OK");
    expect(bundled.stages.generated_patch_preview?.code).toBe("ZONE_OK");
    expect(bundled.stages.generated_patch_conversion?.code).toBe("ZONE_OK");
    expect(bundled.stages.apply?.code).toBe("ZONE_APPLY_SUCCESS");
  });

  it("full four-stage success: rendered output contains all four stage sections in order", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const bundled = buildBundledResult({
      stages: {
        decision: buildDecisionStageResult(decision),
        generated_patch_preview: buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN),
        generated_patch_conversion: buildConversionStageResult(CONVERSION_SUCCESS),
        apply: buildApplyStageResult(makeApplyResult()),
      },
    });

    const output = renderBundledResult(bundled);

    const idxDecision = output.indexOf("--- Stage: decision ---");
    const idxPreview = output.indexOf("--- Stage: generated_patch_preview ---");
    const idxConversion = output.indexOf("--- Stage: generated_patch_conversion ---");
    const idxApply = output.indexOf("--- Stage: apply ---");

    expect(idxDecision).toBeGreaterThan(-1);
    expect(idxPreview).toBeGreaterThan(-1);
    expect(idxConversion).toBeGreaterThan(-1);
    expect(idxApply).toBeGreaterThan(-1);

    expect(idxDecision).toBeLessThan(idxPreview);
    expect(idxPreview).toBeLessThan(idxConversion);
    expect(idxConversion).toBeLessThan(idxApply);
  });

  it("apply failure downgrades bundled result correctly", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    const bundled = buildBundledResult({
      stages: {
        decision: buildDecisionStageResult(decision),
        generated_patch_preview: buildPreviewStageResult(SINGLE_OP_PREVIEW_PLAN),
        generated_patch_conversion: buildConversionStageResult(CONVERSION_SUCCESS),
        apply: buildApplyStageResult(
          makeApplyResult({ status: "failed", operationsApplied: 0 })
        ),
      },
    });

    expect(bundled.overallStatus).toBe("failed");
    expect(bundled.overallSeverity).toBe("fatal");
    expect(bundled.stages.apply?.code).toBe("ZONE_APPLY_FAILED");
  });

  it("timestamps propagate through the full chain when provided", () => {
    const ts = {
      startedAt: "2026-04-03T10:00:00.000Z",
      completedAt: "2026-04-03T10:00:02.000Z",
      durationMs: 2000,
    };

    const decisionStage = buildStageResultV2({
      stage: "decision",
      status: "success",
      severity: "ok",
      code: "ZONE_OK",
      summary: "OK",
      timestamps: ts,
    });

    const bundled = buildBundledResult({
      stages: { decision: decisionStage },
      timestamps: ts,
    });

    const output = renderBundledResult(bundled);

    expect(bundled.timestamps).toEqual(ts);
    expect(output).toContain("--- Timestamps ---");
    expect(output).toContain("Started: 2026-04-03T10:00:00.000Z");
    expect(output).toContain("Duration: 2000ms");
  });
});
