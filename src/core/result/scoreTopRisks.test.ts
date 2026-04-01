import { describe, expect, it } from "vitest";
import { scoreTopRisks } from "./scoreTopRisks.js";

describe("scoreTopRisks", () => {
  it("kritik issue'ları yüksek skorlu şekilde öne çıkarır", () => {
    const risks = scoreTopRisks({
      issues: [
        {
          code: "SCHEMA_INVALID",
          message: "Schema invalid",
          severity: "error"
        },
        {
          code: "DUPLICATE_TARGET",
          message: "Duplicate target",
          severity: "warning"
        }
      ],
      decisionMode: "preview_only"
    });

    expect(risks[0]?.title).toBe("Schema mismatch riski");
    expect(risks[0]?.severity).toBe("high");
    expect(risks[0]?.score).toBe(90);
  });

  it("preview mode için decision riskini ekler", () => {
    const risks = scoreTopRisks({
      issues: [],
      decisionMode: "preview_only"
    });

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      id: "decision:preview_only",
      severity: "medium",
      score: 57
    });
  });

  it("blocked mode için decision riskini yüksek öncelikle ekler", () => {
    const risks = scoreTopRisks({
      issues: [],
      decisionMode: "blocked"
    });

    expect(risks[0]).toMatchObject({
      id: "decision:blocked",
      severity: "high",
      score: 92
    });
  });

  it("aynı risk kodunu dedupe eder", () => {
    const risks = scoreTopRisks({
      issues: [
        {
          code: "PROTECTED_FILE",
          message: "Protected file",
          severity: "error"
        },
        {
          code: "PROTECTED_FILE",
          message: "Protected file duplicate",
          severity: "error"
        }
      ],
      decisionMode: "safe_to_apply"
    });

    expect(risks).toHaveLength(1);
    expect(risks[0]?.id).toBe("issue:protected_file");
  });

  it("score desc sıralama yapar", () => {
    const risks = scoreTopRisks({
      issues: [
        {
          code: "AMBIGUOUS_TARGET",
          message: "Ambiguous",
          severity: "warning"
        },
        {
          code: "PATH_TRAVERSAL",
          message: "Traversal",
          severity: "error"
        }
      ],
      decisionMode: "safe_to_apply"
    });

    expect(risks.map((risk) => risk.score)).toEqual([100, 60]);
  });

  it("limit uygular", () => {
    const risks = scoreTopRisks({
      issues: [
        { code: "PATH_TRAVERSAL", message: "x", severity: "error" },
        { code: "PROTECTED_FILE", message: "x", severity: "error" },
        { code: "SCHEMA_INVALID", message: "x", severity: "error" }
      ],
      decisionMode: "preview_only",
      limit: 2
    });

    expect(risks).toHaveLength(2);
  });
});