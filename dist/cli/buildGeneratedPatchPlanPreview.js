"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGeneratedPatchPlanPreview = buildGeneratedPatchPlanPreview;
const classifyPatchIntent_js_1 = require("../patch-generation/classifyPatchIntent.js");
const isIntentAllowed_js_1 = require("../patch-generation/isIntentAllowed.js");
const buildPatchOperations_js_1 = require("../patch-generation/buildPatchOperations.js");
function resolveStrategy(mode) {
    return mode === "blocked" ? "blocked" : "safe";
}
function resolveAllowedLabel(allowed) {
    return allowed ? "yes" : "no";
}
function renderOperations(intent) {
    if (intent === "unknown") {
        return ["- none"];
    }
    const operations = (0, buildPatchOperations_js_1.buildPatchOperations)(intent);
    if (!operations.length) {
        return ["- none"];
    }
    return operations.map((operation) => {
        const scope = "scope" in operation && typeof operation.scope === "string"
            ? operation.scope
            : "single_file";
        return `- ${operation.type} (scope: ${scope})`;
    });
}
function resolveReason(intent, allowed) {
    if (!allowed && intent === "unknown") {
        return "Patch generation blocked because task intent is unknown.";
    }
    if (!allowed) {
        return `Patch generation blocked because intent '${intent}' is not allowed for this strategy.`;
    }
    return "Patch generation allowed.";
}
function buildGeneratedPatchPlanPreview(input) {
    const reasonCodes = input.reasonCodes ?? [];
    const strategy = resolveStrategy(input.decision.mode);
    const rawIntent = (0, classifyPatchIntent_js_1.classifyPatchIntent)(input.task);
    const intent = rawIntent === "unknown" ? "unknown" : rawIntent;
    const allowed = rawIntent === "unknown" ? false : (0, isIntentAllowed_js_1.isIntentAllowed)(rawIntent, strategy);
    const lines = [];
    lines.push("=== GENERATED PATCH PLAN ===");
    lines.push(`Allowed: ${resolveAllowedLabel(allowed)}`);
    lines.push(`Strategy: ${strategy}`);
    lines.push(`Intent: ${intent}`);
    lines.push(`Confidence: ${input.decision.confidenceScore}`);
    lines.push(`Reason: ${resolveReason(intent, allowed)}`);
    lines.push("");
    lines.push("Operations:");
    lines.push(...renderOperations(intent));
    lines.push("");
    lines.push("Derived From:");
    if (reasonCodes.length === 0) {
        lines.push("- none");
    }
    else {
        for (const code of reasonCodes) {
            lines.push(`- ${code}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=buildGeneratedPatchPlanPreview.js.map