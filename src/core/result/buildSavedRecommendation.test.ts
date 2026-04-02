import { describe, expect, it } from "vitest";
import { buildSavedRecommendation } from "./buildSavedRecommendation.js";
import type { SavedAgentResult } from "../../types/agent.js";

function createBaseResult(
  overrides?: Partial<SavedAgentResult>
): SavedAgentResult {
  return {
    summary: "Example summary",
    intent: {
      rawTask: "add endpoint",
      operation: "modify",
      target: "endpoint",
      scope: "server",
      nestedTarget: null,
      confidence: "medium",
      warnings: []
    },
    schema: {
      summary: "Schema summary",
      entities: [],
      relations: [],
      confidence: "medium"
    },
    storage: {
      primaryStorage: "postgres",
      detectedClients: [],
      confidence: "medium",
      reasoning: ["Detected postgres"]
    },
    validation: {
      patch: [],
      schema: []
    },
    decision: {
      mode: "preview",
      confidence: 72,
      reason: "Warnings require review."
    },
    confidenceDetails: {
      baseWeightedScore: 80,
      totalPenalty: 8,
      penalties: []
    },
    notes: {
      execution: [],
      assumptions: [],
      followUps: []
    },
    ...overrides
  };
}

describe("buildSavedRecommendation", () => {
  it("prefers explicit saved recommendation when provided", () => {
    const result = createBaseResult({
      decision: {
        mode: "preview",
        confidence: 72,
        reason: "Warnings require review.",
        recommendation: "Use the saved recommendation text."
      }
    });

    expect(buildSavedRecommendation(result)).toBe(
      "Use the saved recommendation text."
    );
  });

  it("returns schema-focused blocked recommendation when schema issues exist", () => {
    const result = createBaseResult({
      decision: {
        mode: "blocked",
        confidence: 20,
        reason: "Blocking issues detected."
      },
      validation: {
        patch: [],
        schema: [
          {
            code: "SCHEMA_VALIDATION_ERROR",
            severity: "error",
            message: "Schema validation failed."
          }
        ]
      }
    });

    expect(buildSavedRecommendation(result)).toBe(
      "Do not apply automatically. Resolve schema issues and verify schema alignment first."
    );
  });

  it("returns high-risk preview recommendation when high top risk exists", () => {
    const result = createBaseResult({
      decision: {
        mode: "preview",
        confidence: 68,
        reason: "Warnings require review."
      },
      issues: {
        summary: {
          total: 1,
          errors: 0,
          warnings: 1
        },
        grouped: [],
        topRisks: [
          {
            id: "risk-1",
            title: "Dangerous patch target",
            description: "Patch may affect risky files.",
            severity: "high",
            score: 90,
            category: "patch",
            source: "warning"
          }
        ]
      }
    });

    expect(buildSavedRecommendation(result)).toBe(
      "Preview the patch and complete manual review before any apply step because high-severity risks are still present."
    );
  });

  it("returns patch-focused preview recommendation when patch issues exist", () => {
    const result = createBaseResult({
      validation: {
        patch: [
          {
            code: "PATCH_VALIDATION_WARNING",
            severity: "warning",
            message: "Patch should be reviewed."
          }
        ],
        schema: []
      }
    });

    expect(buildSavedRecommendation(result)).toBe(
      "Preview the patch and review patch scope before any apply step."
    );
  });

  it("returns safe recommendation for apply mode", () => {
    const result = createBaseResult({
      decision: {
        mode: "apply",
        confidence: 91,
        reason: "Validation passed cleanly."
      }
    });

    expect(buildSavedRecommendation(result)).toBe(
      "Patch can be applied automatically under current safeguards."
    );
  });
});