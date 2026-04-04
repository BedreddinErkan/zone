"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const canConvertGeneratedPlanToPatchPlan_js_1 = require("./canConvertGeneratedPlanToPatchPlan.js");
function buildPlan(overrides) {
    return {
        version: 1,
        summary: "generated plan",
        warnings: [],
        intent: "safe_replace",
        operations: [],
        ...overrides,
    };
}
(0, vitest_1.describe)("canConvertGeneratedPlanToPatchPlan", () => {
    (0, vitest_1.it)("returns EMPTY_OPERATIONS when operations are missing", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "EMPTY_OPERATIONS",
            reason: "Generated patch plan contains no operations.",
        });
    });
    (0, vitest_1.it)("returns UNSUPPORTED_INTENT for rename_symbol intent", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            intent: "rename_symbol",
            operations: [
                {
                    type: "rename_symbol",
                    filePath: "src/example.ts",
                    from: "oldName",
                    to: "newName",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "UNSUPPORTED_INTENT",
            reason: 'Generated patch intent "rename_symbol" is not supported for PatchPlan conversion.',
        });
    });
    (0, vitest_1.it)("returns MULTI_OPERATION_NOT_SUPPORTED when more than one operation exists", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "a",
                    replaceWith: "b",
                    matchMode: "exact",
                },
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "c",
                    replaceWith: "d",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "MULTI_OPERATION_NOT_SUPPORTED",
            reason: "Generated patch plan contains multiple operations, but only a single operation is supported.",
        });
    });
    (0, vitest_1.it)("returns UNSUPPORTED_OPERATION when operation type is not safe_replace", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "add_comment",
                    filePath: "src/example.ts",
                    comment: "note",
                    target: "line:1",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "UNSUPPORTED_OPERATION",
            reason: 'Generated patch operation "add_comment" is not supported for PatchPlan conversion.',
        });
    });
    (0, vitest_1.it)("returns MISSING_REQUIRED_FIELDS when filePath is empty", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "MISSING_REQUIRED_FIELDS",
            reason: "Generated patch operation requires a non-empty filePath.",
        });
    });
    (0, vitest_1.it)("returns MISSING_REQUIRED_FIELDS when find is empty", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "MISSING_REQUIRED_FIELDS",
            reason: "Generated patch operation requires a non-empty find value.",
        });
    });
    (0, vitest_1.it)("returns PLACEHOLDER_FILE_PATH for placeholder file path", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "unknown",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "PLACEHOLDER_FILE_PATH",
            reason: 'Generated patch operation contains placeholder filePath "unknown".',
        });
    });
    (0, vitest_1.it)("returns PLACEHOLDER_TEXT for placeholder values", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "old_value",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "PLACEHOLDER_TEXT",
            reason: "Generated patch operation contains placeholder find/replace values.",
        });
    });
    (0, vitest_1.it)("returns NON_EXACT_MATCH when matchMode is not exact", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "contains",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "NON_EXACT_MATCH",
            reason: 'Generated patch operation requires matchMode "exact", received "contains".',
        });
    });
    (0, vitest_1.it)("returns NO_OP_REPLACEMENT when find and replaceWith are the same", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "sameText",
                    replaceWith: "sameText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: false,
            code: "NO_OP_REPLACEMENT",
            reason: "Generated patch operation has no effect because find and replaceWith are identical.",
        });
    });
    (0, vitest_1.it)("returns canConvert true for a valid single exact safe_replace operation", () => {
        const result = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            canConvert: true,
        });
    });
});
//# sourceMappingURL=canConvertGeneratedPlanToPatchPlan.test.js.map