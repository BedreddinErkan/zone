"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFallbackPatchPlan = buildFallbackPatchPlan;
function buildFallbackPatchPlan(task, suggestedFiles) {
    return {
        summary: `Fallback patch preview generated for: ${task}`,
        patches: suggestedFiles
            .filter((file) => typeof file.resolvedPath === "string" && file.resolvedPath.length > 0)
            .slice(0, 5)
            .map((file) => ({
            path: file.resolvedPath,
            operation: file.action === "create" ? "create" : "modify",
            summary: "Inspect and update this file with the minimal required change",
            targetHint: "Around the most relevant existing feature logic",
            contentPreview: `// Preview placeholder for task: ${task}`
        })),
        warnings: [
            "This patch preview was generated without a detailed LLM patch response",
            "Review target locations manually before applying changes"
        ]
    };
}
//# sourceMappingURL=buildFallbackPatchPlan.js.map