import { describe, expect, it } from "vitest";
import { evaluateCiResult, type CiResultLike } from "./evaluateCiResult.js";

describe("evaluateCiResult", () => {
  it("fails CI when decision mode is blocked", () => {
    const result: CiResultLike = {
      decision: {
        mode: "blocked",
        confidenceScore: 22,
        reason: "Blocking validation errors were detected."
      },
      confidenceDetails: {
        penalties: [{ label: "Patch validation warnings" }]
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("blocked");
    expect(evaluation.ciStatus).toBe("fail");
    expect(evaluation.shouldFail).toBe(true);
    expect(evaluation.confidenceScore).toBe(22);
    expect(evaluation.statusLine).toBe("STATUS: BLOCKED");
    expect(evaluation.summaryLine).toContain("decision=blocked");
    expect(evaluation.summaryLine).toContain("confidence=22");
    expect(evaluation.summaryLine).toContain(
      "reason=Blocking validation errors were detected."
    );
    expect(evaluation.penaltyReasons).toEqual(["Patch validation warnings"]);
  });

  it("fails CI when saved result contains error-level issues even if mode is preview", () => {
    const result: CiResultLike = {
      decision: {
        mode: "preview",
        confidence: 61,
        reason: "Manual review required."
      },
      issues: {
        summary: {
          total: 3,
          errors: 1,
          warnings: 2
        }
      },
      confidenceDetails: {
        penalties: [{ label: "Schema validation warnings" }]
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("preview");
    expect(evaluation.ciStatus).toBe("fail");
    expect(evaluation.shouldFail).toBe(true);
    expect(evaluation.confidenceScore).toBe(61);
    expect(evaluation.statusLine).toBe("STATUS: PREVIEW ONLY");
    expect(evaluation.summaryLine).toContain("decision=preview");
    expect(evaluation.summaryLine).toContain("errors=1");
    expect(evaluation.summaryLine).toContain("warnings=2");
  });

  it("returns warn for preview_only when there are no error-level issues", () => {
    const result: CiResultLike = {
      decision: {
        mode: "preview_only",
        confidenceScore: 68,
        reason: "Warnings require review."
      },
      issues: {
        summary: {
          total: 2,
          errors: 0,
          warnings: 2
        }
      },
      confidenceDetails: {
        penalties: [
          { label: "Architecture warnings" },
          { label: "Patch risk warnings" }
        ]
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("preview_only");
    expect(evaluation.ciStatus).toBe("warn");
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.confidenceScore).toBe(68);
    expect(evaluation.statusLine).toBe("STATUS: PREVIEW ONLY");
    expect(evaluation.summaryLine).toContain("decision=preview_only");
    expect(evaluation.summaryLine).toContain("warnings=2");
    expect(evaluation.penaltyReasons).toEqual([
      "Architecture warnings",
      "Patch risk warnings"
    ]);
  });

  it("returns pass for saved result with apply mode and zero errors", () => {
    const result: CiResultLike = {
      decision: {
        mode: "apply",
        confidence: 91,
        reason: "Validation passed cleanly."
      },
      issues: {
        summary: {
          total: 0,
          errors: 0,
          warnings: 0
        }
      },
      confidenceBreakdown: {
        finalScore: 91,
        level: "high"
      },
      confidenceDetails: {
        penalties: []
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("apply");
    expect(evaluation.ciStatus).toBe("pass");
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.confidenceScore).toBe(91);
    expect(evaluation.statusLine).toBe("STATUS: SAFE TO APPLY");
    expect(evaluation.summaryLine).toContain("decision=apply");
    expect(evaluation.summaryLine).toContain("confidence=91");
    expect(evaluation.summaryLine).toContain("errors=0");
    expect(evaluation.summaryLine).toContain("warnings=0");
    expect(evaluation.summaryLine).toContain("penalties=none");
  });

  it("prefers explicit saved statusLine when provided", () => {
    const result: CiResultLike = {
      statusLine: "STATUS: CUSTOM SAVED LINE",
      decision: {
        mode: "preview",
        confidence: 57,
        reason: "Saved result should control status line."
      },
      issues: {
        summary: {
          total: 1,
          errors: 0,
          warnings: 1
        }
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.statusLine).toBe("STATUS: CUSTOM SAVED LINE");
    expect(evaluation.ciStatus).toBe("warn");
    expect(evaluation.shouldFail).toBe(false);
  });

  it("deduplicates penalty labels and ignores empty ones", () => {
    const result: CiResultLike = {
      decision: {
        mode: "preview_only",
        confidenceScore: 70,
        reason: "Review penalties."
      },
      confidenceDetails: {
        penalties: [
          { label: "Architecture warnings" },
          { label: "Architecture warnings" },
          { label: "   " },
          {},
          { label: "Patch risk warnings" }
        ]
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.penaltyReasons).toEqual([
      "Architecture warnings",
      "Patch risk warnings"
    ]);
    expect(evaluation.summaryLine).toContain(
      "penalties=Architecture warnings | Patch risk warnings"
    );
  });

  it("falls back to confidence.finalScore for legacy result shape", () => {
    const result: CiResultLike = {
      decision: {
        mode: "safe_to_apply",
        reason: "Legacy confidence source."
      },
      confidence: {
        finalScore: 87
      },
      confidenceDetails: {
        penalties: []
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("safe_to_apply");
    expect(evaluation.ciStatus).toBe("pass");
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.confidenceScore).toBe(87);
    expect(evaluation.summaryLine).toContain("confidence=87");
  });

  it("falls back to unknown mode when decision mode is missing or unsupported", () => {
    const result: CiResultLike = {
      decision: {
        mode: "manual_review",
        reason: "Unexpected custom mode."
      },
      confidenceDetails: {
        penalties: []
      }
    };

    const evaluation = evaluateCiResult(result);

    expect(evaluation.decisionMode).toBe("unknown");
    expect(evaluation.ciStatus).toBe("warn");
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.statusLine).toBe("STATUS: UNKNOWN");
    expect(evaluation.summaryLine).toContain("decision=unknown");
  });
});