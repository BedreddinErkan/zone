"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildConversionStageResult_js_1 = require("./buildConversionStageResult.js");
// ── helpers ───────────────────────────────────────────────────────────────────
const success = { canConvert: true };
function failure(code, reason = "some specific reason") {
    return { canConvert: false, code, reason };
}
// ── tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildConversionStageResult", () => {
    // 1. success path
    (0, vitest_1.it)("canConvert: true → success path", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(success);
        (0, vitest_1.expect)(result.status).toBe("success");
        (0, vitest_1.expect)(result.severity).toBe("ok");
        (0, vitest_1.expect)(result.code).toBe("ZONE_OK");
        (0, vitest_1.expect)(result.stage).toBe("generated_patch_conversion");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
        (0, vitest_1.expect)(result.details).toBeUndefined();
        (0, vitest_1.expect)(result.summary).toBe("Generated patch plan conversion succeeded.");
    });
    // 2. PLACEHOLDER_FILE_PATH
    (0, vitest_1.it)("PLACEHOLDER_FILE_PATH → ZONE_CONVERSION_FAILED_PLACEHOLDER", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("PLACEHOLDER_FILE_PATH", "path has {{placeholder}}"));
        (0, vitest_1.expect)(result.status).toBe("blocked");
        (0, vitest_1.expect)(result.severity).toBe("fatal");
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED_PLACEHOLDER");
        (0, vitest_1.expect)(result.details).toBe("path has {{placeholder}}");
    });
    // 3. PLACEHOLDER_TEXT
    (0, vitest_1.it)("PLACEHOLDER_TEXT → ZONE_CONVERSION_FAILED_PLACEHOLDER", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("PLACEHOLDER_TEXT", "find contains {{placeholder}}"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED_PLACEHOLDER");
        (0, vitest_1.expect)(result.status).toBe("blocked");
        (0, vitest_1.expect)(result.severity).toBe("fatal");
    });
    // 4. UNSUPPORTED_INTENT
    (0, vitest_1.it)("UNSUPPORTED_INTENT → ZONE_CONVERSION_FAILED_UNSUPPORTED", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("UNSUPPORTED_INTENT"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED_UNSUPPORTED");
        (0, vitest_1.expect)(result.status).toBe("blocked");
        (0, vitest_1.expect)(result.severity).toBe("fatal");
    });
    // 5. UNSUPPORTED_OPERATION
    (0, vitest_1.it)("UNSUPPORTED_OPERATION → ZONE_CONVERSION_FAILED_UNSUPPORTED", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("UNSUPPORTED_OPERATION"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED_UNSUPPORTED");
    });
    // 6. EMPTY_OPERATIONS
    (0, vitest_1.it)("EMPTY_OPERATIONS → ZONE_CONVERSION_FAILED with exact summary", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("EMPTY_OPERATIONS"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED");
        (0, vitest_1.expect)(result.summary).toBe("Conversion blocked: generated plan contains no operations.");
    });
    // 7. NON_EXACT_MATCH
    (0, vitest_1.it)("NON_EXACT_MATCH → ZONE_CONVERSION_FAILED", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("NON_EXACT_MATCH"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED");
    });
    // 8. NO_OP_REPLACEMENT
    (0, vitest_1.it)("NO_OP_REPLACEMENT → ZONE_CONVERSION_FAILED", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("NO_OP_REPLACEMENT"));
        (0, vitest_1.expect)(result.code).toBe("ZONE_CONVERSION_FAILED");
    });
    // 9. details always carries failure reason
    (0, vitest_1.it)("details always carries the failure reason string", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("MISSING_REQUIRED_FIELDS", "some specific reason"));
        (0, vitest_1.expect)(result.details).toBe("some specific reason");
    });
    // 10. meta invariant across both paths
    (0, vitest_1.it)("meta is stamped correctly for canConvert: true", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(success);
        (0, vitest_1.expect)(result.meta.stage).toBe("generated_patch_conversion");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
    (0, vitest_1.it)("meta is stamped correctly for canConvert: false", () => {
        const result = (0, buildConversionStageResult_js_1.buildConversionStageResult)(failure("MULTI_OPERATION_NOT_SUPPORTED"));
        (0, vitest_1.expect)(result.meta.stage).toBe("generated_patch_conversion");
        (0, vitest_1.expect)(result.meta.engine).toBe("zone");
        (0, vitest_1.expect)(result.meta.version).toBe("2.0");
    });
});
//# sourceMappingURL=buildConversionStageResult.test.js.map