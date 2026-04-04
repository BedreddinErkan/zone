"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRiskScoreDetails = computeRiskScoreDetails;
function clampScore(value) {
    if (value < 0)
        return 0;
    if (value > 100)
        return 100;
    return value;
}
function includesAny(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword));
}
function computeRiskScoreDetails(input) {
    const normalizedTask = input.task.trim().toLowerCase();
    const hasDestructiveSignal = includesAny(normalizedTask, [
        "delete",
        "drop",
        "remove",
        "destroy",
        "truncate"
    ]);
    const hasSchemaSignal = includesAny(normalizedTask, [
        "schema",
        "migration",
        "migrate",
        "database",
        "db",
        "column",
        "columns",
        "table",
        "tables",
        "field",
        "fields",
        "model",
        "models"
    ]);
    const hasCriticalSignal = includesAny(normalizedTask, [
        "auth",
        "authentication",
        "authorization",
        "billing",
        "payment",
        "payments",
        "permission",
        "permissions",
        "security",
        "jwt",
        "token",
        "production"
    ]);
    const hasLowRiskSignal = includesAny(normalizedTask, [
        "copy",
        "text",
        "rename",
        "comment",
        "docs",
        "readme"
    ]);
    const hasMassScopeSignal = includesAny(normalizedTask, [
        "delete all",
        "drop all",
        "remove all",
        "truncate",
        "wipe",
        "purge",
        "flush",
        "delete everything",
        "delete every"
    ]);
    const riskBreakdown = {
        destructive: hasDestructiveSignal ? 50 : 0,
        schema: hasSchemaSignal ? 25 : 0,
        critical: hasCriticalSignal ? 20 : 0,
        lowRisk: hasLowRiskSignal ? -20 : 0,
        massScope: hasMassScopeSignal ? 25 : 0
    };
    const rawScore = riskBreakdown.destructive +
        riskBreakdown.schema +
        riskBreakdown.critical +
        riskBreakdown.lowRisk +
        riskBreakdown.massScope;
    const riskScore = clampScore(rawScore);
    const detectedSignals = [];
    if (hasDestructiveSignal) {
        detectedSignals.push("destructive");
    }
    if (hasSchemaSignal) {
        detectedSignals.push("schema_change");
    }
    if (hasCriticalSignal) {
        detectedSignals.push("critical_domain");
    }
    if (hasLowRiskSignal) {
        detectedSignals.push("low_risk");
    }
    if (hasMassScopeSignal) {
        detectedSignals.push("mass_scope");
    }
    return {
        riskScore,
        riskBreakdown,
        detectedSignals
    };
}
//# sourceMappingURL=computeRiskScoreDetails.js.map