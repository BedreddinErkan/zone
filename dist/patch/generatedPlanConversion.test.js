"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const generatedPlanConversion_js_1 = require("./generatedPlanConversion.js");
function buildValidPlan() {
    return {
        intent: "replace_exact_text",
        operations: [
            {
                filePath: "src/example.ts",
                find: "oldText",
                replaceWith: "newText",
                matchMode: "exact",
            },
        ],
    };
}
(0, vitest_1.describe)("canConvertGeneratedPlanToPatchPlan", () => {
    (0, vitest_1.it)("rejects empty operations", () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "EMPTY_OPERATIONS",
            reason: "Generated patch plan contains no operations.",
        });
    });
    (0, vitest_1.it)("rejects multiple operations", () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/a.ts",
                    find: "a",
                    replaceWith: "b",
                    matchMode: "exact",
                },
                {
                    filePath: "src/b.ts",
                    find: "c",
                    replaceWith: "d",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "MULTI_OPERATION_NOT_SUPPORTED",
            reason: "Generated patch plan contains multiple operations, but only a single operation is supported.",
        });
    });
    (0, vitest_1.it)("rejects unsupported intent", () => {
        const plan = {
            intent: "create_file",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "a",
                    replaceWith: "b",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "UNSUPPORTED_INTENT",
            reason: 'Generated patch intent "create_file" is not supported for PatchPlan conversion.',
        });
    });
    (0, vitest_1.it)('rejects placeholder filePath "unknown"', () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "unknown",
                    find: "a",
                    replaceWith: "b",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "PLACEHOLDER_FILE_PATH",
            reason: 'Generated patch operation contains placeholder filePath "unknown".',
        });
    });
    (0, vitest_1.it)('rejects placeholder find value "old_value"', () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "old_value",
                    replaceWith: "actual_value",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "PLACEHOLDER_TEXT",
            reason: "Generated patch operation contains placeholder find/replace values.",
        });
    });
    (0, vitest_1.it)('rejects placeholder replaceWith value "new_value"', () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "actual_value",
                    replaceWith: "new_value",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "PLACEHOLDER_TEXT",
            reason: "Generated patch operation contains placeholder find/replace values.",
        });
    });
    (0, vitest_1.it)("rejects non-exact match mode", () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "substring",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "NON_EXACT_MATCH",
            reason: 'Generated patch operation requires matchMode "exact", received "substring".',
        });
    });
    (0, vitest_1.it)("rejects no-op replacement", () => {
        const plan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "sameText",
                    replaceWith: "sameText",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "NO_OP_REPLACEMENT",
            reason: "Generated patch operation has no effect because find and replaceWith are identical.",
        });
    });
    (0, vitest_1.it)("returns canConvert true for a valid plan", () => {
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(buildValidPlan())).toEqual({
            canConvert: true,
        });
    });
    (0, vitest_1.it)("returns first deterministic failure when multiple rules are violated", () => {
        const plan = {
            intent: "unsupported_intent",
            operations: [],
        };
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.canConvertGeneratedPlanToPatchPlan)(plan)).toEqual({
            canConvert: false,
            code: "EMPTY_OPERATIONS",
            reason: "Generated patch plan contains no operations.",
        });
    });
});
(0, vitest_1.describe)("convertGeneratedPlanToPatchPlan", () => {
    (0, vitest_1.it)("converts a valid generated plan into a PatchPlan", () => {
        (0, vitest_1.expect)((0, generatedPlanConversion_js_1.convertGeneratedPlanToPatchPlan)(buildValidPlan())).toEqual({
            operations: [
                {
                    type: "replace",
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        });
    });
    (0, vitest_1.it)("throws with structured failure details when conversion validation fails", () => {
        const invalidPlan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "unknown",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        };
        (0, vitest_1.expect)(() => (0, generatedPlanConversion_js_1.convertGeneratedPlanToPatchPlan)(invalidPlan)).toThrow('[PLACEHOLDER_FILE_PATH] Cannot convert generated patch plan: Generated patch operation contains placeholder filePath "unknown".');
    });
});
//# sourceMappingURL=generatedPlanConversion.test.js.map