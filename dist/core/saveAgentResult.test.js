"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const saveAgentResult_js_1 = require("./saveAgentResult.js");
function makeMinimalResult(overrides = {}) {
    return {
        task: "test task",
        targetPath: "/tmp/test",
        structure: { language: "typescript", framework: "none", hasTests: false },
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
        },
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
(0, vitest_1.describe)("buildTopRisks", () => {
    (0, vitest_1.it)("patchValidationIssues üzerindeki file ve details alanlarını doğru taşır", () => {
        const issue = {
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
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        (0, vitest_1.expect)(risks.length).toBeGreaterThan(0);
        const schemaRisk = risks.find((r) => r.relatedCode === "SCHEMA_INVALID");
        (0, vitest_1.expect)(schemaRisk).toBeDefined();
        (0, vitest_1.expect)(schemaRisk.category).toBe("schema");
        (0, vitest_1.expect)(schemaRisk.severity).toBe("high");
        (0, vitest_1.expect)(schemaRisk.score).toBe(90);
    });
    (0, vitest_1.it)("schemaPatchWarnings üzerindeki source alanına göre category atar", () => {
        const issue = {
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
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        const customRisk = risks.find((r) => r.relatedCode === "CUSTOM_SCHEMA_CHECK");
        (0, vitest_1.expect)(customRisk).toBeDefined();
        // source: "schema" fallback devreye girmeli
        (0, vitest_1.expect)(customRisk.category).toBe("schema");
    });
    (0, vitest_1.it)("patchRiskWarnings için source:patch ile category:patch üretir", () => {
        const result = makeMinimalResult({
            patchRiskWarnings: ["Olası tenant scope sorunu"],
            decision: { mode: "safe_to_apply", confidenceScore: 78, reason: "ok" }
        });
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        const patchRisk = risks.find((r) => r.relatedCode === "PATCH_RISK_WARNING");
        (0, vitest_1.expect)(patchRisk).toBeDefined();
        (0, vitest_1.expect)(patchRisk.category).toBe("patch");
        (0, vitest_1.expect)(patchRisk.source).toBe("validation_issue");
    });
    (0, vitest_1.it)("architectureWarnings için ARCHITECTURE_WARNING kodu architecture category üretir", () => {
        const result = makeMinimalResult({
            architectureWarnings: ["Circular dependency riski"],
            decision: { mode: "safe_to_apply", confidenceScore: 72, reason: "ok" }
        });
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        const archRisk = risks.find((r) => r.relatedCode === "ARCHITECTURE_WARNING");
        (0, vitest_1.expect)(archRisk).toBeDefined();
        (0, vitest_1.expect)(archRisk.category).toBe("architecture");
        (0, vitest_1.expect)(archRisk.severity).toBe("medium");
    });
    (0, vitest_1.it)("blocked modda decision risk eklenir ve en yüksek skorda çıkar", () => {
        const result = makeMinimalResult({
            decision: { mode: "blocked", confidenceScore: 30, reason: "critical error" }
        });
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        (0, vitest_1.expect)(risks[0]?.id).toBe("decision:blocked");
        (0, vitest_1.expect)(risks[0]?.score).toBe(92);
        (0, vitest_1.expect)(risks[0]?.severity).toBe("high");
    });
    (0, vitest_1.it)("limit 5 ile sınırlı sonuç döner", () => {
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
        const risks = (0, saveAgentResult_js_1.buildTopRisks)(result);
        (0, vitest_1.expect)(risks.length).toBeLessThanOrEqual(5);
    });
});
//# sourceMappingURL=saveAgentResult.test.js.map