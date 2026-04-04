"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const scoreTopRisks_js_1 = require("./scoreTopRisks.js");
(0, vitest_1.describe)("scoreTopRisks", () => {
    (0, vitest_1.it)("kritik issue'ları yüksek skorlu şekilde öne çıkarır", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
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
        (0, vitest_1.expect)(risks[0]?.title).toBe("Schema mismatch riski");
        (0, vitest_1.expect)(risks[0]?.severity).toBe("high");
        (0, vitest_1.expect)(risks[0]?.score).toBe(90);
    });
    (0, vitest_1.it)("preview mode için decision riskini ekler", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
            issues: [],
            decisionMode: "preview_only"
        });
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            id: "decision:preview_only",
            severity: "medium",
            score: 57
        });
    });
    (0, vitest_1.it)("blocked mode için decision riskini yüksek öncelikle ekler", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
            issues: [],
            decisionMode: "blocked"
        });
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            id: "decision:blocked",
            severity: "high",
            score: 92
        });
    });
    (0, vitest_1.it)("aynı risk kodunu dedupe eder", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
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
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]?.id).toBe("issue:protected_file");
    });
    (0, vitest_1.it)("score desc sıralama yapar", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
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
        (0, vitest_1.expect)(risks.map((risk) => risk.score)).toEqual([100, 60]);
    });
    (0, vitest_1.it)("limit uygular", () => {
        const risks = (0, scoreTopRisks_js_1.scoreTopRisks)({
            issues: [
                { code: "PATH_TRAVERSAL", message: "x", severity: "error" },
                { code: "PROTECTED_FILE", message: "x", severity: "error" },
                { code: "SCHEMA_INVALID", message: "x", severity: "error" }
            ],
            decisionMode: "preview_only",
            limit: 2
        });
        (0, vitest_1.expect)(risks).toHaveLength(2);
    });
});
//# sourceMappingURL=scoreTopRisks.test.js.map