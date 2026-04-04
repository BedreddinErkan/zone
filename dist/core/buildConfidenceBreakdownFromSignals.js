"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConfidenceBreakdownFromSignals = buildConfidenceBreakdownFromSignals;
const normalizeSignals_js_1 = require("./normalizeSignals.js");
function buildConfidenceBreakdownFromSignals(signals) {
    const normalized = (0, normalizeSignals_js_1.normalizeSignals)(signals);
    const breakdown = {
        destructive: 0,
        schema: 0,
        critical: 0,
        massScope: 0,
        lowRisk: 0
    };
    for (const signal of normalized) {
        if (signal.type === "destructive") {
            breakdown.destructive = Math.abs(signal.confidenceImpact);
        }
        if (signal.type === "schema") {
            breakdown.schema = Math.abs(signal.confidenceImpact);
        }
        if (signal.type === "critical_domain") {
            breakdown.critical = Math.abs(signal.confidenceImpact);
        }
        if (signal.type === "mass_scope") {
            breakdown.massScope = Math.abs(signal.confidenceImpact);
        }
    }
    if (signals.includes("low_risk")) {
        breakdown.lowRisk = -20;
    }
    return breakdown;
}
//# sourceMappingURL=buildConfidenceBreakdownFromSignals.js.map