import { describe, expect, it } from "vitest";
import { renderSavedAgentResultSummary } from "./renderDecisionSummary.js";
import type { SavedAgentResult } from "../../types/agent.js";
describe("renderSavedAgentResultSummary", () => {
  it("renders saved agent result with recommendation, top risks and groups", () => {
    const result: SavedAgentResult = {
      summary: "Example summary",
      statusLine: "STATUS: preview_only | confidence=64 | warnings=3",
      intent: {
        rawTask: "add endpoint",
        operation: "update",
        target: "treatment",
        scope: "single",
        nestedTarget: "timeline",
        confidence: "medium",
        warnings: []
      },
      schema: {
        summary: "Schema summary",
        entities: ["treatments"],
        relations: [],
        confidence: "medium"
      },
      storage: {
        primaryStorage: "postgres",
        detectedClients: [],
        confidence: "medium",
        reasoning: ["Detected postgres"],
        resourceStorageKind: "separate_table"
      },
      validation: {
        patch: [],
        schema: []
      },
      decision: {
        mode: "preview",
        confidence: 64,
        reason: "Warnings detected",
        recommendation:
          "Preview çıktısını manuel incele. Warning ve risk sinyalleri temizlenmeden otomatik apply önerilmez."
      },
      confidenceDetails: {
        baseWeightedScore: 72,
        totalPenalty: 8,
        penalties: []
      },
      confidenceBreakdown: {
        finalScore: 64,
        level: "medium",
        factors: {
          intentClarity: 80,
          schemaCertainty: 58,
          storageCertainty: 55,
          patchValidationHealth: 70
        }
      },
      issues: {
        summary: {
          total: 3,
          errors: 1,
          warnings: 2
        },
        grouped: [
          {
            key: "schema",
            label: "Schema validation",
            total: 1,
            errors: 1,
            warnings: 0,
            issues: [
              {
                code: "SCHEMA_VALIDATION_ERROR",
                severity: "error",
                message: "Table not found"
              }
            ]
          },
          {
            key: "risk",
            label: "Patch risk warnings",
            total: 2,
            errors: 0,
            warnings: 2,
            issues: [
              {
                code: "PATCH_RISK_WARNING",
                severity: "warning",
                message: "Possible tenant scope issue"
              }
            ]
          }
        ],
 topRisks: [
  {
    id: "issue:schema_invalid",
    title: "Schema mismatch riski",
    description: "Patch çıktısı beklenen şemayla uyumlu değil.",
    severity: "high",
    score: 90,
    category: "schema",
    source: "validation_issue",
    relatedCode: "SCHEMA_INVALID"
  },
  {
    id: "issue:patch_warning",
    title: "Patch riski",
    description: "Patch yan etki riski taşıyor.",
    severity: "medium",
    score: 55,
    category: "patch",
    source: "warning",
    relatedCode: "PATCH_WARNING"
  }
]
      },
      notes: {
        execution: [],
        assumptions: [],
        followUps: []
      }
    };

    const output = renderSavedAgentResultSummary(result);

    expect(output).toContain("=== AGENT DECISION ===");
    expect(output).toContain("Mode: preview");
    expect(output).toContain("Confidence: 64/100 (medium)");
    expect(output).toContain("Recommendation:");
    expect(output).toContain("Top Risks:");
    expect(output).toContain("Schema mismatch riski");
    // İş 2: relatedCode ve category yeni format
    expect(output).toContain("(schema / SCHEMA_INVALID)");
    expect(output).toContain("(patch / PATCH_WARNING)");
    expect(output).toContain("Issue Groups:");
    expect(output).toContain("Schema validation: 1 error, 0 warning");
    expect(output).toContain("Summary:");
  });
});