import { describe, expect, it } from "vitest";
import { buildCliViewModel } from "./buildCliViewModel.js";
import { renderCliResult } from "./renderCliResult.js";
import type { SavedAgentResult } from "../../types/agent.js";

const sampleResult: SavedAgentResult = {
  version: 2,
  generatedAt: "2026-04-01T12:00:00.000Z",
  summary: "Preview recommended because warnings exist.",
  statusLine:
    "STATUS: PREVIEW | confidence=74 | warnings=1 | penalties=2 | patches=1 | relevant=3 | suggested=2",
  meta: {
    task: "Add PATCH endpoint",
    targetPath: "/repo",
    relevantFileCount: 3,
    suggestedFileCount: 2,
    patchCount: 1
  },
  intent: {
    rawTask: "Add PATCH endpoint",
    operation: "modify",
    target: "endpoint",
    scope: "server",
    nestedTarget: null,
    confidence: "medium",
    warnings: []
  },
  schema: {
    summary: "Schema seems compatible.",
    entities: [],
    relations: [],
    confidence: "medium"
  },
  storage: {
    primaryStorage: "postgres",
    detectedClients: ["supabase"],
    confidence: "medium",
    reasoning: ["Detected Supabase client usage."],
    resourceStorageKind: "separate_table"
  },
  validation: {
    patch: [],
    schema: [
      {
        code: "SCHEMA_WARNING",
        severity: "warning",
        message: "Possible schema ambiguity."
      }
    ]
  },
  issues: {
    summary: {
      total: 1,
      errors: 0,
      warnings: 1
    },
    grouped: [
      {
        key: "schema",
        label: "Schema",
        total: 1,
        errors: 0,
        warnings: 1,
        issues: [
          {
            code: "SCHEMA_WARNING",
            severity: "warning",
            message: "Possible schema ambiguity."
          }
        ]
      }
    ],
    topRisks: [
      {
        id: "issue:ambiguous_target",
        title: "Belirsiz dosya hedefi",
        description: "Değişikliğin uygulanacağı gerçek dosya net değil.",
        severity: "medium",
        score: 60,
        category: "validation",
        source: "validation_issue",
        relatedCode: "AMBIGUOUS_TARGET"
      }
    ]
  },
  decision: {
    mode: "preview",
    confidence: 74,
    reason: "Warnings require review.",
    recommendation: "Review before apply."
  },
  confidenceBreakdown: {
    finalScore: 74,
    level: "medium",
    factors: {
      intentClarity: 20,
      schemaCertainty: 18,
      storageCertainty: 18,
      patchValidationHealth: 18
    }
  },
  confidenceDetails: {
    baseWeightedScore: 84,
    totalPenalty: 10,
    penalties: [
      {
        code: "SCHEMA_WARNING",
        label: "Schema ambiguity",
        appliedPenalty: 10
      }
    ]
  },
  notes: {
    execution: ["Patch plan built successfully."],
    assumptions: ["Endpoint path inferred from route patterns."],
    followUps: ["Review schema alignment before apply."]
  },
  debug: {
    patchTargets: [
      {
        path: "server/controllers/treatmentController.js",
        operation: "modify"
      }
    ],
    suggestedFiles: [
      {
        originalPath: "server/routes/treatmentRoutes.js",
        resolvedPath: "server/routes/treatmentRoutes.js",
        status: "verified",
        action: "modify"
      }
    ]
  }
};

describe("renderCliResult", () => {
  it("summary formatinda kisa okunabilir cikti verir", () => {
    const view = buildCliViewModel(sampleResult);
    const output = renderCliResult(view, "summary");

    expect(output).toContain("Decision: PREVIEW ONLY");
    expect(output).toContain("Confidence: 74");
    expect(output).toContain("Issues: 0 error, 1 warning");
    expect(output).toContain("Top Risk: MEDIUM (score: 60) - Belirsiz dosya hedefi");
    expect(output).toContain("Recommendation: Review before apply.");
  });

  it("detailed formatinda risk note issue explanation ve recommendation bolumlerini yazar", () => {
    const view = buildCliViewModel(sampleResult);
    const output = renderCliResult(view, "detailed");

    expect(output).toContain("Top Risks");
    expect(output).toContain("Notes");
    expect(output).toContain("Issues");
    expect(output).toContain("Schema");
    expect(output).toContain("SCHEMA_WARNING");
    expect(output).toContain("Recommendation");
    expect(output).toContain("Review before apply.");
    expect(output).toContain("Explanation");
    expect(output).toContain("Decision was saved as PREVIEW ONLY");
    expect(output).toContain("1 warning-level issue(s) remain in the saved result");
  });

  it("detailed formatinda risk description ve category gosterir", () => {
    const view = buildCliViewModel(sampleResult);
    const output = renderCliResult(view, "detailed");

    expect(output).toContain("Belirsiz dosya hedefi");
    expect(output).toContain("validation");
    expect(output).toContain("Değişikliğin uygulanacağı gerçek dosya net değil");
    expect(output).toContain("score=60");
  });

  it("json formatinda parse edilebilir json verir", () => {
    const view = buildCliViewModel(sampleResult);
    const output = renderCliResult(view, "json");
    const parsed = JSON.parse(output) as SavedAgentResult;

    expect(parsed.decision.mode).toBe("preview");
    expect(parsed.confidenceBreakdown?.finalScore).toBe(74);
  });

  it("detailed modda execution bilgilerini gosterir", () => {
    const resultWithExec = {
      ...sampleResult,
      execution: {
        traceId: "trace_test_123",
        startedAt: "2026-04-01T10:00:00.000Z",
        finishedAt: "2026-04-01T10:00:01.000Z",
        durationMs: 1000,
        phases: [
          { name: "run_agent", durationMs: 800 },
          { name: "load_result", durationMs: 50 }
        ]
      }
    };

    const view = buildCliViewModel(resultWithExec as SavedAgentResult);
    const output = renderCliResult(view, "detailed");

    expect(output).toContain("Execution");
    expect(output).toContain("trace_test_123");
    expect(output).toContain("run_agent");
  });
});