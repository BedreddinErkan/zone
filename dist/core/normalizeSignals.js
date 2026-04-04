"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSignals = normalizeSignals;
function normalizeSignals(signals) {
    const result = [];
    if (signals.includes("destructive")) {
        result.push({
            type: "destructive",
            severity: "high",
            confidenceImpact: -50,
            label: "Potentially destructive change"
        });
    }
    if (signals.includes("schema")) {
        result.push({
            type: "schema",
            severity: "medium",
            confidenceImpact: -25,
            label: "Schema-sensitive change"
        });
    }
    if (signals.includes("critical_domain")) {
        result.push({
            type: "critical_domain",
            severity: "medium",
            confidenceImpact: -20,
            label: "Critical domain surface"
        });
    }
    if (signals.includes("mass_scope")) {
        result.push({
            type: "mass_scope",
            severity: "high",
            confidenceImpact: -25,
            label: "Mass-scope operation"
        });
    }
    return result;
}
//# sourceMappingURL=normalizeSignals.js.map