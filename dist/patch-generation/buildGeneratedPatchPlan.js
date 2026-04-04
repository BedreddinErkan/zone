"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGeneratedPatchPlan = buildGeneratedPatchPlan;
const classifyPatchIntent_js_1 = require("./classifyPatchIntent.js");
function mapIntent(intent) {
    switch (intent) {
        case "safe_replace":
        case "add_comment":
        case "update_import":
        case "rename_symbol":
            return intent;
        default:
            return "add_comment";
    }
}
function buildOperations(intent) {
    switch (intent) {
        case "add_comment":
            return [
                {
                    type: "add_comment",
                    filePath: "unknown",
                    comment: "TODO",
                    target: "unknown"
                }
            ];
        case "safe_replace":
            return [
                {
                    type: "safe_replace",
                    filePath: "unknown",
                    find: "old_value",
                    replaceWith: "new_value",
                    matchMode: "exact"
                }
            ];
        case "update_import":
            return [
                {
                    type: "update_import",
                    filePath: "unknown",
                    from: "old/import",
                    to: "new/import"
                }
            ];
        case "rename_symbol":
            return [
                {
                    type: "rename_symbol",
                    filePath: "unknown",
                    from: "oldName",
                    to: "newName"
                }
            ];
    }
}
function buildSummary(intent) {
    switch (intent) {
        case "add_comment":
            return "Adds a comment in a deterministic location.";
        case "safe_replace":
            return "Performs a safe deterministic replacement.";
        case "update_import":
            return "Updates an import path in a deterministic way.";
        case "rename_symbol":
            return "Renames a symbol intent in preview form.";
    }
}
function buildWarnings(input, intent) {
    const warnings = [];
    if (input.decision.mode !== "safe_to_apply") {
        warnings.push(`Decision mode is '${input.decision.mode}', so generated operations are preview-oriented.`);
    }
    if (intent !== "safe_replace") {
        warnings.push(`Intent '${intent}' is not convertible to a real PatchPlan in v1 unless explicitly supported.`);
    }
    if (input.reasonCodes.length > 0) {
        warnings.push(`Reason codes: ${input.reasonCodes.join(", ")}`);
    }
    return warnings;
}
function buildGeneratedPatchPlan(input) {
    const rawIntent = (0, classifyPatchIntent_js_1.classifyPatchIntent)(input.task);
    const intent = mapIntent(rawIntent);
    const operations = buildOperations(intent);
    return {
        version: 1,
        intent,
        operations,
        summary: buildSummary(intent),
        warnings: buildWarnings(input, intent)
    };
}
//# sourceMappingURL=buildGeneratedPatchPlan.js.map