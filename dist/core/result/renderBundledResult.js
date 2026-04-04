"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderBundledResult = renderBundledResult;
function renderStage(stage) {
    const lines = [
        `--- Stage: ${stage.stage} ---`,
        `Status: ${stage.status}`,
        `Severity: ${stage.severity}`,
        `Code: ${stage.code}`,
        `Summary: ${stage.summary}`,
    ];
    if (stage.details !== undefined) {
        lines.push(`Details: ${stage.details}`);
    }
    return lines.join("\n");
}
function renderBundledResult(result) {
    const sections = [
        "=== ZONE BUNDLED RESULT ===",
        `Engine: ${result.engine}`,
        `Version: ${result.version}`,
        `Overall Status: ${result.overallStatus}`,
        `Overall Severity: ${result.overallSeverity}`,
    ];
    const stageOrder = [
        "decision",
        "generated_patch_preview",
        "generated_patch_conversion",
        "apply",
    ];
    for (const key of stageOrder) {
        const stage = result.stages[key];
        if (stage !== undefined) {
            sections.push(renderStage(stage));
        }
    }
    if (result.timestamps !== undefined) {
        sections.push([
            "--- Timestamps ---",
            `Started: ${result.timestamps.startedAt}`,
            `Completed: ${result.timestamps.completedAt}`,
            `Duration: ${result.timestamps.durationMs}ms`,
        ].join("\n"));
    }
    return sections.join("\n");
}
//# sourceMappingURL=renderBundledResult.js.map