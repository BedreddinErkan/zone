import { describe, expect, it } from "vitest";
import { evaluateCiResult } from "./evaluateCiResult";

describe("evaluateCiResult", () => {
  it("blocked mode icin fail sonucu donmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "blocked",
        confidenceScore: 0.22,
        reason: "unsafe patch"
      },
      confidenceDetails: {
        penalties: [
          { label: "missing_target_file" },
          { label: "weak_patch_anchor" }
        ]
      }
    });

    expect(result.decisionMode).toBe("blocked");
    expect(result.ciStatus).toBe("fail");
    expect(result.shouldFail).toBe(true);
    expect(result.confidenceScore).toBe(0.22);
    expect(result.statusLine).toBe("STATUS: BLOCKED");
    expect(result.penaltyReasons).toEqual([
      "missing_target_file",
      "weak_patch_anchor"
    ]);
    expect(result.summaryLine).toContain("decision=blocked");
    expect(result.summaryLine).toContain("confidence=0.22");
    expect(result.summaryLine).toContain("reason=unsafe patch");
    expect(result.summaryLine).toContain(
      "penalties=missing_target_file | weak_patch_anchor"
    );
  });

  it("preview_only mode icin warn sonucu donmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "preview_only",
        confidenceScore: 0.63,
        reason: "moderate confidence"
      },
      confidenceDetails: {
        penalties: [{ label: "weak_file_ranking" }]
      }
    });

    expect(result.decisionMode).toBe("preview_only");
    expect(result.ciStatus).toBe("warn");
    expect(result.shouldFail).toBe(false);
    expect(result.confidenceScore).toBe(0.63);
    expect(result.statusLine).toBe("STATUS: PREVIEW ONLY");
    expect(result.penaltyReasons).toEqual(["weak_file_ranking"]);
    expect(result.summaryLine).toContain("decision=preview_only");
    expect(result.summaryLine).toContain("confidence=0.63");
    expect(result.summaryLine).toContain("reason=moderate confidence");
    expect(result.summaryLine).toContain("penalties=weak_file_ranking");
  });

  it("safe_to_apply mode icin pass sonucu donmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 0.91,
        reason: "high confidence"
      },
      confidenceDetails: {
        penalties: []
      }
    });

    expect(result.decisionMode).toBe("safe_to_apply");
    expect(result.ciStatus).toBe("pass");
    expect(result.shouldFail).toBe(false);
    expect(result.confidenceScore).toBe(0.91);
    expect(result.statusLine).toBe("STATUS: SAFE TO APPLY");
    expect(result.penaltyReasons).toEqual([]);
    expect(result.summaryLine).toContain("decision=safe_to_apply");
    expect(result.summaryLine).toContain("confidence=0.91");
    expect(result.summaryLine).toContain("reason=high confidence");
    expect(result.summaryLine).toContain("penalties=none");
  });

  it("bilinmeyen decision mode icin unknown ve warn donmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "something_else",
        confidenceScore: 0.5
      }
    });

    expect(result.decisionMode).toBe("unknown");
    expect(result.ciStatus).toBe("warn");
    expect(result.shouldFail).toBe(false);
    expect(result.confidenceScore).toBe(0.5);
    expect(result.statusLine).toBe("STATUS: UNKNOWN");
    expect(result.summaryLine).toContain("decision=unknown");
    expect(result.summaryLine).toContain("confidence=0.5");
    expect(result.summaryLine).toContain("penalties=none");
  });

  it("decision.confidenceScore yoksa confidence.finalScore degerini kullanmali", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "preview_only"
      },
      confidence: {
        finalScore: 0.74
      }
    });

    expect(result.decisionMode).toBe("preview_only");
    expect(result.confidenceScore).toBe(0.74);
    expect(result.summaryLine).toContain("confidence=0.74");
  });

  it("hic confidence yoksa confidenceScore null donmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "preview_only"
      }
    });

    expect(result.confidenceScore).toBeNull();
    expect(result.summaryLine).toContain("decision=preview_only");
    expect(result.summaryLine).toContain("penalties=none");
    expect(result.summaryLine).not.toContain("confidence=");
  });

  it("penalty label degerlerini trim etmeli ve duplicate olanlari tekillestirmeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "blocked"
      },
      confidenceDetails: {
        penalties: [
          { label: " missing_target_file " },
          { label: "missing_target_file" },
          { label: " weak_patch_anchor " },
          { label: "" },
          {},
          { label: "weak_patch_anchor" }
        ]
      }
    });

    expect(result.penaltyReasons).toEqual([
      "missing_target_file",
      "weak_patch_anchor"
    ]);

    expect(result.summaryLine).toContain(
      "penalties=missing_target_file | weak_patch_anchor"
    );
  });

  it("summary line penalty sayisi fazla olsa bile ilk 4 nedeni gostermeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "preview_only"
      },
      confidenceDetails: {
        penalties: [
          { label: "p1" },
          { label: "p2" },
          { label: "p3" },
          { label: "p4" },
          { label: "p5" }
        ]
      }
    });

    expect(result.penaltyReasons).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(result.summaryLine).toContain("penalties=p1 | p2 | p3 | p4");
    expect(result.summaryLine).not.toContain("p5");
  });

  it("reason yoksa summary line icine reason eklememeli", () => {
    const result = evaluateCiResult({
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 0.88
      }
    });

    expect(result.summaryLine).toContain("decision=safe_to_apply");
    expect(result.summaryLine).toContain("confidence=0.88");
    expect(result.summaryLine).not.toContain("reason=");
  });
});