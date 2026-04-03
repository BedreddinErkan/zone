import { describe, expect, it } from "vitest";
import { renderBundledResult } from "./renderBundledResult.js";
import { buildBundledResult, buildStageResultV2 } from "./buildStageResultV2.js";
import type { ZoneStageResultV2 } from "../output/zoneStageTypes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDecisionStage(overrides: Partial<ZoneStageResultV2> = {}): ZoneStageResultV2 {
  return buildStageResultV2({
    stage: "decision",
    status: "success",
    severity: "ok",
    code: "ZONE_OK",
    summary: "Decision OK",
    ...overrides,
  });
}

function makeConversionStage(overrides: Partial<ZoneStageResultV2> = {}): ZoneStageResultV2 {
  return buildStageResultV2({
    stage: "generated_patch_conversion",
    status: "success",
    severity: "ok",
    code: "ZONE_OK",
    summary: "Conversion OK",
    ...overrides,
  });
}

function makeApplyStage(overrides: Partial<ZoneStageResultV2> = {}): ZoneStageResultV2 {
  return buildStageResultV2({
    stage: "apply",
    status: "success",
    severity: "ok",
    code: "ZONE_APPLY_SUCCESS",
    summary: "Apply OK",
    ...overrides,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("renderBundledResult", () => {
  // 1. header fields
  it("renders header fields correctly", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage() },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("=== ZONE BUNDLED RESULT ===");
    expect(output).toContain("Engine: zone");
    expect(output).toContain("Version: 2.0");
    expect(output).toContain("Overall Status:");
    expect(output).toContain("Overall Severity:");
  });

  // 2. decision stage section
  it("renders decision stage section", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage({ code: "ZONE_OK", summary: "All good" }) },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("--- Stage: decision ---");
    expect(output).toContain("Code: ZONE_OK");
    expect(output).toContain("Summary: All good");
  });

  // 3. details line present when defined
  it("renders details line when details is defined", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage({ details: "some detail" }) },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("Details: some detail");
  });

  // 4. details line absent when undefined
  it("omits details line when details is undefined", () => {
    const stage = buildStageResultV2({
      stage: "decision",
      status: "success",
      severity: "ok",
      code: "ZONE_OK",
      summary: "OK",
      // no details
    });
    const bundled = buildBundledResult({ stages: { decision: stage } });
    const output = renderBundledResult(bundled);

    expect(output).not.toContain("Details:");
  });

  // 5. conversion stage rendered when present
  it("renders generated_patch_conversion stage when present", () => {
    const bundled = buildBundledResult({
      stages: {
        decision: makeDecisionStage(),
        generated_patch_conversion: makeConversionStage(),
      },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("--- Stage: generated_patch_conversion ---");
  });

  // 6. apply stage rendered when present
  it("renders apply stage when present", () => {
    const bundled = buildBundledResult({
      stages: {
        decision: makeDecisionStage(),
        apply: makeApplyStage(),
      },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("--- Stage: apply ---");
  });

  // 7. missing stages are not rendered
  it("omits absent stages", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage() },
    });
    const output = renderBundledResult(bundled);

    expect(output).not.toContain("--- Stage: apply ---");
    expect(output).not.toContain("--- Stage: generated_patch_conversion ---");
  });

  // 8. stage order is always decision → conversion → apply
  it("renders stages in fixed order: decision → conversion → apply", () => {
    const bundled = buildBundledResult({
      stages: {
        decision: makeDecisionStage(),
        generated_patch_conversion: makeConversionStage(),
        apply: makeApplyStage(),
      },
    });
    const output = renderBundledResult(bundled);

    const idxDecision = output.indexOf("--- Stage: decision ---");
    const idxConversion = output.indexOf("--- Stage: generated_patch_conversion ---");
    const idxApply = output.indexOf("--- Stage: apply ---");

    expect(idxDecision).toBeLessThan(idxConversion);
    expect(idxConversion).toBeLessThan(idxApply);
  });

  // 9. timestamps section rendered when present
  it("renders timestamps section when timestamps are provided", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage() },
      timestamps: {
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:01.000Z",
        durationMs: 1000,
      },
    });
    const output = renderBundledResult(bundled);

    expect(output).toContain("--- Timestamps ---");
    expect(output).toContain("Started: 2026-04-03T10:00:00.000Z");
    expect(output).toContain("Duration: 1000ms");
  });

  // 10. timestamps section absent when not present
  it("omits timestamps section when timestamps are not provided", () => {
    const bundled = buildBundledResult({
      stages: { decision: makeDecisionStage() },
    });
    const output = renderBundledResult(bundled);

    expect(output).not.toContain("--- Timestamps ---");
  });
});
