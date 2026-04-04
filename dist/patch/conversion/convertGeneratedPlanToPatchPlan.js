"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertGeneratedPlanToPatchPlan = convertGeneratedPlanToPatchPlan;
const canConvertGeneratedPlanToPatchPlan_js_1 = require("./canConvertGeneratedPlanToPatchPlan.js");
function assertSafeReplaceOperation(operation) {
    if (operation.type !== "safe_replace") {
        throw new Error(`Invariant violation: expected "safe_replace" operation, received "${operation.type}".`);
    }
}
function convertGeneratedPlanToPatchPlan(plan) {
    const validation = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(plan);
    if (!validation.canConvert) {
        throw new Error(`[${validation.code}] Cannot convert generated patch plan: ${validation.reason}`);
    }
    if (plan.operations.length !== 1) {
        throw new Error("Invariant violation: validated generated patch plan must contain exactly one operation.");
    }
    if (plan.intent !== "safe_replace") {
        throw new Error(`Invariant violation: expected supported intent "safe_replace", received "${plan.intent}".`);
    }
    const operation = plan.operations[0];
    assertSafeReplaceOperation(operation);
    if (operation.matchMode !== "exact") {
        throw new Error(`Invariant violation: expected matchMode "exact", received "${operation.matchMode}".`);
    }
    return {
        operations: [
            {
                type: "replace",
                filePath: operation.filePath,
                find: operation.find,
                replaceWith: operation.replaceWith,
                matchMode: "exact",
            },
        ],
    };
}
//# sourceMappingURL=convertGeneratedPlanToPatchPlan.js.map