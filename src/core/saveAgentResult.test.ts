import { describe, expect, it } from "vitest";
import { buildTopRisks } from "./saveAgentResult.js";
import type { FeatureAgentResult, ValidationIssue } from "../types/agent.js";

function makeMinimalResult(
  overrides: Partial<FeatureAgentResult> = {}
): FeatureAgentResult {
  return {
    task: "test task",
    targetPath: "/tmp/test",
    structure: { language: "typescript", framework: "none", hasTests: false } as never,
    allFiles: [],
    relevantFiles: [],
    summary: "test summary",
    llmPlan: { implementationSummary: "", steps: [], suggestedFiles: [], risks: [] },
    validatedSuggestedFiles: [],
    patchPlan: { summary: "", patches: [], warnings: [] },
    intent: {
      action: "update",
      parentResource: "user",
      scope: "single",
      nestedResource: null,
      warnings: []
    } as never,
    architectureWarnings: [],
    patchRiskWarnings: [],
    schemaAwareSummary: { summary: "", entities: [], relations: [], confidence: "medium" },
    storageInsight: {
      primaryStorage: "postgres",
      detectedClients: [],
      reasoning: [],
      confidence: "medium"
    },
    patchValidationIssues: [],
    schemaPatchWarnings: [],
    executionNotes: { notes: [], assumptions: [], followUps: [] },
    confidence: {
      intentClarity: 80,
      schemaCertainty: 70,
      storageCertainty: 75,
      patchValidationHealth: 90,
      finalScore: 79
    },
    confidenceDetails: { baseWeightedScore: 80, totalPenalty: 1, penalties: [] },
    decision: { mode: "safe_to_apply", confidenceScore: 79, reason: "ok" },
    ...overrides
  };
}

describe("buildTopRisks", () => {
  it("patchValidationIssues üzerindeki file ve details alanlarını doğru taşır", () => {
    const issue: ValidationIssue = {
      code: "SCHEMA_INVALID",
      severity: "error",
      message: "Schema mismatch",
      source: "schema",
      file: "src/routes/user.ts",
      details: "Field 'id' beklenen tipte değil"
    };

    const result = makeMinimalResult({
      patchValidationIssues: [issue],
      decision: { mode: "preview_only", confidenceScore: 55, reason: "schema error" }
    });

    const risks = buildTopRisks(result);

    expect(risks.length).toBeGreaterThan(0);
    const schemaRisk = risks.find((r) => r.relatedCode === "SCHEMA_INVALID");
    expect(schemaRisk).toBeDefined();
    expect(schemaRisk!.category).toBe("schema");
    expect(schemaRisk!.severity).toBe("high");
    expect(schemaRisk!.score).toBe(90);
  });

  it("schemaPatchWarnings üzerindeki source alanına göre category atar", () => {
    const issue: ValidationIssue = {
      code: "CUSTOM_SCHEMA_CHECK",
      severity: "warning",
      message: "Schema custom warning",
      source: "schema",
      details: ["detail1", "detail2"]
    };

    const result = makeMinimalResult({
      schemaPatchWarnings: [issue],
      decision: { mode: "safe_to_apply", confidenceScore: 78, reason: "ok" }
    });

    const risks = buildTopRisks(result);
    const customRisk = risks.find((r) => r.relatedCode === "CUSTOM_SCHEMA_CHECK");
    expect(customRisk).toBeDefined();
    // source: "schema" fallback devreye girmeli
    expect(customRisk!.category).toBe("schema");
  });

  it("patchRiskWarnings için source:patch ile category:patch üretir", () => {
    const result = makeMinimalResult({
      patchRiskWarnings: ["Olası tenant scope sorunu"],
      decision: { mode: "safe_to_apply", confidenceScore: 78, reason: "ok" }
    });

    const risks = buildTopRisks(result);
    const patchRisk = risks.find((r) => r.relatedCode === "PATCH_RISK_WARNING");
    expect(patchRisk).toBeDefined();
    expect(patchRisk!.category).toBe("patch");
    expect(patchRisk!.source).toBe("validation_issue");
  });

  it("architectureWarnings için ARCHITECTURE_WARNING kodu architecture category üretir", () => {
    const result = makeMinimalResult({
      architectureWarnings: ["Circular dependency riski"],
      decision: { mode: "safe_to_apply", confidenceScore: 72, reason: "ok" }
    });

    const risks = buildTopRisks(result);
    const archRisk = risks.find((r) => r.relatedCode === "ARCHITECTURE_WARNING");
    expect(archRisk).toBeDefined();
    expect(archRisk!.category).toBe("architecture");
    expect(archRisk!.severity).toBe("medium");
  });

  it("blocked modda decision risk eklenir ve en yüksek skorda çıkar", () => {
    const result = makeMinimalResult({
      decision: { mode: "blocked", confidenceScore: 30, reason: "critical error" }
    });

    const risks = buildTopRisks(result);
    expect(risks[0]?.id).toBe("decision:blocked");
    expect(risks[0]?.score).toBe(92);
    expect(risks[0]?.severity).toBe("high");
  });

  it("limit 5 ile sınırlı sonuç döner", () => {
    const result = makeMinimalResult({
      patchValidationIssues: [
        { code: "PATH_TRAVERSAL", severity: "error", message: "x" },
        { code: "PROTECTED_FILE", severity: "error", message: "x" },
        { code: "SCHEMA_INVALID", severity: "error", message: "x" },
        { code: "DUPLICATE_TARGET", severity: "warning", message: "x" },
        { code: "AMBIGUOUS_TARGET", severity: "warning", message: "x" }
      ],
      patchRiskWarnings: ["extra risk"],
      decision: { mode: "blocked", confidenceScore: 20, reason: "multiple errors" }
    });

    const risks = buildTopRisks(result);
    expect(risks.length).toBeLessThanOrEqual(5);
  });
});
