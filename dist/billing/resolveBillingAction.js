"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBillingAction = resolveBillingAction;
function resolveBillingAction(input) {
    if (input.hasPaidAccess && input.mode === "byok") {
        return "FREE";
    }
    return "CHARGE";
}
//# sourceMappingURL=resolveBillingAction.js.map