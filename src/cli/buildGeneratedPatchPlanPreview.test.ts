import { describe, expect, it } from "vitest";
import { buildGeneratedPatchPlanPreview } from "./buildGeneratedPatchPlanPreview.js";

describe("buildGeneratedPatchPlanPreview", () => {
  it("builds a rendered generated patch plan preview for safe_to_apply", () => {
    const output = buildGeneratedPatchPlanPreview({
      task: "update import path in api client",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 91
      },
      reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
    });

    expect(output).toContain("=== GENERATED PATCH PLAN ===");
    expect(output).toContain("Intent:");
    expect(output).toContain("Allowed: yes");
    expect(output).toContain("Strategy: safe");
    expect(output).toContain("Intent: update_import");
    expect(output).toContain("Confidence: 91");
    expect(output).toContain("- update_import (scope: single_file)");
    expect(output).toContain("- SAFE_LOW_RISK");
    expect(output).toContain("- SAFE_HIGH_CONFIDENCE");
  });

  it("builds a blocked preview when generation is not allowed", () => {
    const output = buildGeneratedPatchPlanPreview({
      task: "rewrite authentication flow",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 88
      },
      reasonCodes: ["SAFE_LOW_RISK"]
    });

    expect(output).toContain("Allowed: no");
    expect(output).toContain("Strategy: safe");
    expect(output).toContain("Intent: unknown");
    expect(output).toContain("Patch generation blocked because task intent is unknown.");
  });

  it("defaults reason codes to an empty array", () => {
 const output = buildGeneratedPatchPlanPreview({
  task: "add comment above helper",
  decision: {
    mode: "preview_only",
    confidenceScore: 80
  },
  reasonCodes: []
});

    expect(output).toContain("Derived From:");
    expect(output).toContain("- none");
  });
});