"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBillingAction = resolveBillingAction;
function resolveBillingAction(input) {
    const tokenCreditsUsed = input.tokenCreditsUsed ?? 0;
    const tokenCreditsLimit = input.tokenCreditsLimit ?? 500000;
    if (tokenCreditsLimit >= 999999999) {
        return "FREE";
    }
    if (tokenCreditsUsed >= tokenCreditsLimit) {
        return "LIMIT_EXCEEDED";
    }
    return "CHARGE";
}
//# sourceMappingURL=resolveBillingAction.js.map