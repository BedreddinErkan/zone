"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const normalizeIssues_js_1 = require("./normalizeIssues.js");
(0, vitest_1.describe)("normalizePatchValidationIssues", () => {
    (0, vitest_1.it)("error level → PATCH_VALIDATION_ERROR, source patch, severity error", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchValidationIssues)([
            { level: "error", message: "Path traversal detected", filePath: "src/routes/user.ts" }
        ]);
        (0, vitest_1.expect)(result).toHaveLength(1);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "PATCH_VALIDATION_ERROR",
            severity: "error",
            source: "patch",
            message: "Path traversal detected",
            file: "src/routes/user.ts"
        });
    });
    (0, vitest_1.it)("warning level → PATCH_VALIDATION_WARNING, source patch", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchValidationIssues)([
            { level: "warning", message: "Targets node_modules" }
        ]);
        (0, vitest_1.expect)(result).toHaveLength(1);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "PATCH_VALIDATION_WARNING",
            severity: "warning",
            source: "patch"
        });
    });
    (0, vitest_1.it)("filePath → file field'a taşınıyor, eksik filePath → file undefined", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchValidationIssues)([
            { level: "error", message: "With path", filePath: "src/index.ts" },
            { level: "warning", message: "Without path" }
        ]);
        (0, vitest_1.expect)(result[0]?.file).toBe("src/index.ts");
        (0, vitest_1.expect)(result[1]?.file).toBeUndefined();
    });
    (0, vitest_1.it)("boş array input → boş array output", () => {
        (0, vitest_1.expect)((0, normalizeIssues_js_1.normalizePatchValidationIssues)([])).toEqual([]);
    });
    (0, vitest_1.it)("çoklu issue'ları doğru sırayla normalize eder", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchValidationIssues)([
            { level: "error", message: "First" },
            { level: "warning", message: "Second" },
            { level: "error", message: "Third" }
        ]);
        (0, vitest_1.expect)(result).toHaveLength(3);
        (0, vitest_1.expect)(result[0]?.code).toBe("PATCH_VALIDATION_ERROR");
        (0, vitest_1.expect)(result[1]?.code).toBe("PATCH_VALIDATION_WARNING");
        (0, vitest_1.expect)(result[2]?.code).toBe("PATCH_VALIDATION_ERROR");
    });
});
(0, vitest_1.describe)("normalizeSchemaValidationIssues", () => {
    (0, vitest_1.it)("error level → SCHEMA_VALIDATION_ERROR, source schema", () => {
        const result = (0, normalizeIssues_js_1.normalizeSchemaValidationIssues)([
            { level: "error", message: "Field type mismatch", filePath: "schema.json" }
        ]);
        (0, vitest_1.expect)(result).toHaveLength(1);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "SCHEMA_VALIDATION_ERROR",
            severity: "error",
            source: "schema",
            message: "Field type mismatch",
            file: "schema.json"
        });
    });
    (0, vitest_1.it)("warning level → SCHEMA_VALIDATION_WARNING, source schema", () => {
        const result = (0, normalizeIssues_js_1.normalizeSchemaValidationIssues)([
            { level: "warning", message: "Schema snapshot missing" }
        ]);
        (0, vitest_1.expect)(result).toHaveLength(1);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "SCHEMA_VALIDATION_WARNING",
            severity: "warning",
            source: "schema"
        });
    });
    (0, vitest_1.it)("boş array → boş array", () => {
        (0, vitest_1.expect)((0, normalizeIssues_js_1.normalizeSchemaValidationIssues)([])).toEqual([]);
    });
});
(0, vitest_1.describe)("normalizePatchRiskWarnings", () => {
    (0, vitest_1.it)("string[] → ValidationIssue[], code PATCH_RISK_WARNING, source patch, severity warning", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchRiskWarnings)([
            "Possible tenant scope issue",
            "Wide replacement detected"
        ]);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "PATCH_RISK_WARNING",
            severity: "warning",
            source: "patch",
            message: "Possible tenant scope issue"
        });
        (0, vitest_1.expect)(result[1]).toMatchObject({
            code: "PATCH_RISK_WARNING",
            severity: "warning",
            source: "patch",
            message: "Wide replacement detected"
        });
    });
    (0, vitest_1.it)("boş array → boş array", () => {
        (0, vitest_1.expect)((0, normalizeIssues_js_1.normalizePatchRiskWarnings)([])).toEqual([]);
    });
    (0, vitest_1.it)("her uyarı için file field tanımsız kalır", () => {
        const result = (0, normalizeIssues_js_1.normalizePatchRiskWarnings)(["some warning"]);
        (0, vitest_1.expect)(result[0]?.file).toBeUndefined();
    });
});
(0, vitest_1.describe)("normalizeArchitectureWarnings", () => {
    (0, vitest_1.it)("string[] → ValidationIssue[], code ARCHITECTURE_WARNING, source architecture, severity warning", () => {
        const result = (0, normalizeIssues_js_1.normalizeArchitectureWarnings)([
            "Controller pattern mismatch",
            "Circular dependency detected"
        ]);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            code: "ARCHITECTURE_WARNING",
            severity: "warning",
            source: "architecture",
            message: "Controller pattern mismatch"
        });
        (0, vitest_1.expect)(result[1]).toMatchObject({
            code: "ARCHITECTURE_WARNING",
            severity: "warning",
            source: "architecture",
            message: "Circular dependency detected"
        });
    });
    (0, vitest_1.it)("boş array → boş array", () => {
        (0, vitest_1.expect)((0, normalizeIssues_js_1.normalizeArchitectureWarnings)([])).toEqual([]);
    });
    (0, vitest_1.it)("normalize edilen issue'larda source 'architecture', patch değil", () => {
        const result = (0, normalizeIssues_js_1.normalizeArchitectureWarnings)(["arch warning"]);
        (0, vitest_1.expect)(result[0]?.source).toBe("architecture");
        (0, vitest_1.expect)(result[0]?.source).not.toBe("patch");
    });
});
//# sourceMappingURL=normalizeIssues.test.js.map