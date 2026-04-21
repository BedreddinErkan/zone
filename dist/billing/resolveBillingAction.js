"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBillingAction = resolveBillingAction;
function resolveBillingAction(input) {
    if (input.mode === "byok" && input.hasPaidAccess) {
        return "FREE";
    }
    if (input.credits <= 0) {
        return "LIMIT_EXCEEDED";
    }
    return "CHARGE";
}
//# sourceMappingURL=resolveBillingAction.js.map