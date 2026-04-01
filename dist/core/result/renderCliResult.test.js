"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildCliViewModel_js_1 = require("./buildCliViewModel.js");
const renderCliResult_js_1 = require("./renderCliResult.js");
const sampleResult = {
    version: 2,
    generatedAt: "2026-04-01T12:00:00.000Z",
    summary: "Preview recommended because warnings exist.",
    statusLine: "STATUS: PREVIEW | confidence=74 | warnings=1 | penalties=2 | patches=1 | relevant=3 | suggested=2",
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
                code: "SCHEMA_WARNING",
                severity: "warning",
                message: "Possible schema ambiguity."
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
(0, vitest_1.describe)("renderCliResult", () => {
    (0, vitest_1.it)("summary formatinda kisa okunabilir cikti verir", () => {
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(sampleResult);
        const output = (0, renderCliResult_js_1.renderCliResult)(view, "summary");
        (0, vitest_1.expect)(output).toContain("Decision: PREVIEW ONLY");
        (0, vitest_1.expect)(output).toContain("Confidence: 74");
        (0, vitest_1.expect)(output).toContain("Issues: 0 error, 1 warning");
        (0, vitest_1.expect)(output).toContain("Top Risk: SCHEMA_WARNING: Possible schema ambiguity.");
    });
    (0, vitest_1.it)("detailed formatinda risk note ve issue bolumlerini yazar", () => {
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(sampleResult);
        const output = (0, renderCliResult_js_1.renderCliResult)(view, "detailed");
        (0, vitest_1.expect)(output).toContain("Top Risks");
        (0, vitest_1.expect)(output).toContain("Notes");
        (0, vitest_1.expect)(output).toContain("Issues");
        (0, vitest_1.expect)(output).toContain("Schema");
        (0, vitest_1.expect)(output).toContain("SCHEMA_WARNING");
    });
    (0, vitest_1.it)("json formatinda parse edilebilir json verir", () => {
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(sampleResult);
        const output = (0, renderCliResult_js_1.renderCliResult)(view, "json");
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.decision.mode).toBe("preview");
        (0, vitest_1.expect)(parsed.confidenceBreakdown?.finalScore).toBe(74);
    });
});
(0, vitest_1.it)("detailed modda execution bilgilerini gosterir", () => {
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
    const view = (0, buildCliViewModel_js_1.buildCliViewModel)(resultWithExec);
    const output = (0, renderCliResult_js_1.renderCliResult)(view, "detailed");
    (0, vitest_1.expect)(output).toContain("Execution");
    (0, vitest_1.expect)(output).toContain("trace_test_123");
    (0, vitest_1.expect)(output).toContain("run_agent");
});
//# sourceMappingURL=renderCliResult.test.js.map