import { describe, expect, it } from "vitest";
import { buildDecisionExplanation } from "./buildDecisionExplanation.js";
import { renderDecisionSummary } from "./renderDecisionSummary.js";
describe("buildDecisionExplanation", () => {
  it("explains blocked mode with critical reasons", () => {
    const output = buildDecisionExplanation({
      mode: "blocked",
      confidenceScore: 0,
      reasons: [
        {
          code: "PATCH_VALIDATION_ERROR",
          severity: "critical",
          message: "Patch validation failed."
        }
      ]
    });

    expect(output).toContain("Decision was set to BLOCKED");
    expect(output).toContain("1 critical reason(s) affected the decision");
    expect(output).toContain(
      "Automatic apply is not recommended until blocking issues are resolved."
    );
  });

  it("explains preview_only mode with warning reasons", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 68,
      reasons: [
        {
          code: "PATCH_VALIDATION_WARNING",
          severity: "warning",
          message: "Patch should be reviewed."
        },
        {
          code: "ARCHITECTURE_WARNING",
          severity: "warning",
          message: "Architecture mismatch warning."
        }
      ]
    });

    expect(output).toContain("Decision was set to PREVIEW ONLY");
    expect(output).toContain("2 warning-level reason(s) affected the decision");
    expect(output).toContain(
      "Automatic apply is not recommended until review is completed."
    );
  });

  it("includes medium or high top risk count when present", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 70,
      reasons: [
        {
          code: "PATCH_RISK_WARNING",
          severity: "warning",
          message: "Risk warnings detected."
        }
      ],
      topRisks: [
        {
          id: "risk-1",
          title: "Dangerous patch target",
          description: "Target may be unsafe.",
          severity: "high",
          score: 91,
          category: "patch",
          source: "warning"
        },
        {
          id: "risk-2",
          title: "Schema mismatch",
          description: "Schema may be incomplete.",
          severity: "medium",
          score: 66,
          category: "schema",
          source: "derived"
        },
        {
          id: "risk-3",
          title: "Low concern note",
          description: "Minor note.",
          severity: "low",
          score: 20,
          category: "other",
          source: "derived"
        }
      ]
    });

    expect(output).toContain(
      "2 medium/high top risk(s) remain visible in the result"
    );
  });

  it("explains safe_to_apply mode with informational reason", () => {
    const output = buildDecisionExplanation({
      mode: "safe_to_apply",
      confidenceScore: 92,
      reasons: [
        {
          code: "SAFE_TO_APPLY",
          severity: "info",
          message: "No blocking or warning-level execution risks were detected."
        }
      ]
    });

    expect(output).toContain("Decision was set to SAFE TO APPLY");
    expect(output).toContain(
      "1 informational confirmation reason(s) were recorded"
    );
    expect(output).toContain(
      "Automatic apply can proceed under the current safeguards."
    );
  });

  it("still returns fallback explanation when reasons are empty", () => {
    const output = buildDecisionExplanation({
      mode: "preview_only",
      confidenceScore: 60,
      reasons: []
    });

    expect(output).toContain("Decision was set to PREVIEW ONLY");
    expect(output).toContain(
      "Automatic apply is not recommended until review is completed."
    );
  });
});
