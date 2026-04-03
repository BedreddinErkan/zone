import { describe, expect, it } from "vitest";
import { buildDecisionStageResult } from "./buildDecisionStageResult.js";
import type { DecideExecutionModeResult } from "../decision/decideExecutionMode.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<DecideExecutionModeResult>
): DecideExecutionModeResult {
  return {
    mode: "safe_to_apply",
    confidenceScore: 1,
    reasons: [],
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildDecisionStageResult", () => {
  it("blocked with schema error reason → ZONE_BLOCKED_SCHEMA_ERROR", () => {
    const result = buildDecisionStageResult(
      makeResult({
        mode: "blocked",
        reasons: [
          {
            code: "SCHEMA_VALIDATION_ERROR",
            severity: "critical",
            message: "Schema field missing",
          },
        ],
      })
    );

    expect(result.status).toBe("blocked");
    expect(result.severity).toBe("fatal");
    expect(result.code).toBe("ZONE_BLOCKED_SCHEMA_ERROR");
    expect(result.stage).toBe("decision");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });

  it("blocked without schema error reason → ZONE_BLOCKED_HIGH_RISK", () => {
    const result = buildDecisionStageResult(
      makeResult({
        mode: "blocked",
        reasons: [
          {
            code: "PATCH_VALIDATION_ERROR",
            severity: "critical",
            message: "Patch target not found",
          },
        ],
      })
    );

    expect(result.code).toBe("ZONE_BLOCKED_HIGH_RISK");
    expect(result.severity).toBe("fatal");
    expect(result.status).toBe("blocked");
  });

  it("preview_only → success / warning / ZONE_PREVIEW_ONLY", () => {
    const result = buildDecisionStageResult(
      makeResult({
        mode: "preview_only",
        reasons: [
          {
            code: "PATCH_VALIDATION_WARNING",
            severity: "warning",
            message: "Low confidence detected",
          },
        ],
      })
    );

    expect(result.status).toBe("success");
    expect(result.severity).toBe("warning");
    expect(result.code).toBe("ZONE_PREVIEW_ONLY");
  });

  it("safe_to_apply → success / ok / ZONE_OK", () => {
    const result = buildDecisionStageResult(
      makeResult({
        mode: "safe_to_apply",
        reasons: [
          {
            code: "SAFE_TO_APPLY",
            severity: "info",
            message: "No blocking risks detected.",
          },
        ],
      })
    );

    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_OK");
  });

  it("details is set when reasons are non-empty — joined with ' | '", () => {
    const result = buildDecisionStageResult(
      makeResult({
        mode: "preview_only",
        reasons: [
          { code: "PATCH_VALIDATION_WARNING", severity: "warning", message: "A" },
          { code: "SCHEMA_VALIDATION_WARNING", severity: "warning", message: "B" },
        ],
      })
    );

    expect(result.details).toBe("A | B");
  });

  it("details is absent when reasons are empty", () => {
    const result = buildDecisionStageResult(
      makeResult({ mode: "safe_to_apply", reasons: [] })
    );

    expect(result.details).toBeUndefined();
  });

  it("summary is deterministic per mode", () => {
    expect(
      buildDecisionStageResult(makeResult({ mode: "blocked", reasons: [{ code: "PATCH_VALIDATION_ERROR", severity: "critical", message: "x" }] })).summary
    ).toBe("Decision blocked: automatic apply is not permitted.");

    expect(
      buildDecisionStageResult(makeResult({ mode: "preview_only", reasons: [{ code: "PATCH_VALIDATION_WARNING", severity: "warning", message: "x" }] })).summary
    ).toBe("Decision preview only: manual review is required before apply.");

    expect(
      buildDecisionStageResult(makeResult({ mode: "safe_to_apply", reasons: [] })).summary
    ).toBe("Decision safe to apply: no blocking risks detected.");
  });

  it("meta is always stamped correctly regardless of input", () => {
    for (const mode of ["blocked", "preview_only", "safe_to_apply"] as const) {
      const reasons =
        mode === "safe_to_apply"
          ? []
          : [{ code: "PATCH_VALIDATION_WARNING" as const, severity: "warning" as const, message: "x" }];

      const result = buildDecisionStageResult(makeResult({ mode, reasons }));

      expect(result.meta.stage).toBe("decision");
      expect(result.meta.engine).toBe("zone");
      expect(result.meta.version).toBe("2.0");
    }
  });
});
