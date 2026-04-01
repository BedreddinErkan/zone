"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const decideExecutionMode_js_1 = require("./decideExecutionMode.js");
(0, vitest_1.describe)("decideExecutionMode", () => {
    (0, vitest_1.it)("returns blocked when patch validation errors exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [
                {
                    level: "error",
                    code: "PATH_OUTSIDE_REPO",
                    message: "Patch target resolves outside the repository root.",
                    filePath: "../secret.txt",
                },
            ],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("blocked");
        (0, vitest_1.expect)(result.confidenceScore).toBe(0);
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "PATCH_VALIDATION_ERROR",
                severity: "critical",
            }),
        ]));
    });
    (0, vitest_1.it)("returns blocked when schema validation errors exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                {
                    level: "error",
                    code: "SCHEMA_FIELD_MISMATCH",
                    message: "Schema mismatch detected.",
                    filePath: "src/test.ts",
                },
            ],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("blocked");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "SCHEMA_VALIDATION_ERROR",
                severity: "critical",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when patch validation warnings exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [
                {
                    level: "warning",
                    code: "TARGETS_NODE_MODULES",
                    message: "Patch targets node_modules.",
                    filePath: "node_modules/pkg/index.js",
                },
            ],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "PATCH_VALIDATION_WARNING",
                severity: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when schema validation warnings exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                {
                    level: "warning",
                    code: "SCHEMA_SNAPSHOT_MISSING",
                    message: "No schema snapshot loaded.",
                },
            ],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "SCHEMA_VALIDATION_WARNING",
                severity: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when validated files are missing", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: false,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.confidenceScore).toBe(80);
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "MISSING_VALIDATED_FILES",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when schema confidence is low", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 55,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "LOW_SCHEMA_CONFIDENCE",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when storage confidence is low", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 50,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "LOW_STORAGE_CONFIDENCE",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when patch risk warnings exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: ["wide replacement detected"],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "PATCH_RISK_WARNING",
            }),
        ]));
    });
    (0, vitest_1.it)("returns preview_only when architecture warnings exist", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 90,
            storageConfidence: 90,
            architectureWarnings: ["controller and service pattern mismatch"],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "ARCHITECTURE_WARNING",
            }),
        ]));
    });
    (0, vitest_1.it)("returns safe_to_apply when no risks are detected", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 92,
            storageConfidence: 90,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true,
        });
        (0, vitest_1.expect)(result.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(result.confidenceScore).toBe(100);
        (0, vitest_1.expect)(result.reasons).toEqual([
            vitest_1.expect.objectContaining({
                code: "SAFE_TO_APPLY",
                severity: "info",
            }),
        ]);
    });
    (0, vitest_1.it)("keeps blocked precedence over preview_only signals", () => {
        const result = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 35,
            storageConfidence: 40,
            architectureWarnings: ["pattern mismatch"],
            patchRiskWarnings: ["wide patch"],
            patchValidationIssues: [
                {
                    level: "error",
                    code: "TARGETS_PROTECTED_FILE",
                    message: "Patch targets a protected file.",
                    filePath: ".env",
                },
            ],
            schemaValidationIssues: [],
            hasValidatedFiles: false,
        });
        (0, vitest_1.expect)(result.mode).toBe("blocked");
        (0, vitest_1.expect)(result.reasons).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "PATCH_VALIDATION_ERROR",
            }),
        ]));
    });
});
//# sourceMappingURL=decideExecutionMode.test.js.map