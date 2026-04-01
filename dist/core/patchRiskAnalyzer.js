"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzePatchRisk = analyzePatchRisk;
function includesAny(text, patterns) {
    const lower = text.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
}
function analyzePatchRisk(intent, patchPreview) {
    const warnings = [];
    const preview = patchPreview.toLowerCase();
    if (intent.resourceKind === "nested_resource") {
        const suspiciousParentDelete = includesAny(preview, [
            "findbyidanddelete",
            "deletetreatment",
            "remove treatment",
            "delete treatment",
            "router.delete('/:id'",
            'router.delete("/:id"',
            "delete('/:id'",
            'delete("/:id"'
        ]);
        const suspiciousParentUpdate = includesAny(preview, [
            "updatetreatment(",
            "findbyidandupdate(",
            "replace entire treatment",
            "treatment update payload"
        ]);
        const matchedParamCount = intent.paramHints.filter((param) => preview.includes(param.toLowerCase())).length;
        const missingNestedParam = intent.paramHints.length > 1 &&
            matchedParamCount < intent.paramHints.length;
        if (suspiciousParentDelete) {
            warnings.push("Patch appears to delete parent resource while task targets nested resource.");
        }
        if (suspiciousParentUpdate) {
            warnings.push("Patch appears to update parent resource broadly instead of nested item.");
        }
        if (missingNestedParam) {
            warnings.push("Patch may be missing nested identifier params required by task intent.");
        }
    }
    if (intent.action === "delete" &&
        !includesAny(preview, ["filter", ".find(", ".filter(", "timelineid", "itemid", "entryid"])) {
        warnings.push("Delete patch does not clearly show targeted filtering logic.");
    }
    return {
        warnings,
        isHighRisk: warnings.length > 0
    };
}
//# sourceMappingURL=patchRiskAnalyzer.js.map