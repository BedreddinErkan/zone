"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIntentAwareScoreBoost = getIntentAwareScoreBoost;
function getIntentAwareScoreBoost(filePath, content, intent) {
    let score = 0;
    const path = filePath.toLowerCase();
    const text = content.toLowerCase();
    if (intent.resourceKind === "nested_resource") {
        if (path.includes("route") ||
            path.includes("controller") ||
            path.includes("service")) {
            score += 3;
        }
        if (text.includes("timeline") ||
            text.includes("entry") ||
            text.includes("item")) {
            score += 4;
        }
    }
    if (intent.action === "update" || intent.action === "delete") {
        if (text.includes("update") ||
            text.includes("delete") ||
            text.includes("remove") ||
            text.includes("patch")) {
            score += 2;
        }
    }
    for (const param of intent.paramHints) {
        if (text.toLowerCase().includes(param.toLowerCase())) {
            score += 2;
        }
    }
    return score;
}
//# sourceMappingURL=intentAwareScore.js.map