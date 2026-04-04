"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStageResultV2 = buildStageResultV2;
exports.buildBundledResult = buildBundledResult;
function buildStageResultV2(input) {
    return {
        stage: input.stage,
        status: input.status,
        severity: input.severity,
        code: input.code,
        summary: input.summary,
        details: input.details,
        timestamps: input.timestamps,
        meta: {
            stage: input.stage,
            version: "2.0",
            engine: "zone",
        },
    };
}
function buildBundledResult(input) {
    const stageList = Object.values(input.stages).filter((s) => s !== undefined);
    const hasFatal = stageList.some((s) => s.severity === "fatal");
    const hasError = stageList.some((s) => s.severity === "error");
    const hasWarning = stageList.some((s) => s.severity === "warning");
    const overallSeverity = hasFatal
        ? "fatal"
        : hasError
            ? "error"
            : hasWarning
                ? "warning"
                : "ok";
    const hasBlocked = stageList.some((s) => s.status === "blocked");
    const hasFailed = stageList.some((s) => s.status === "failed");
    const allSuccess = stageList.every((s) => s.status === "success");
    const overallStatus = hasBlocked
        ? "blocked"
        : hasFailed
            ? "failed"
            : allSuccess
                ? "success"
                : "info";
    return {
        engine: "zone",
        version: "2.0",
        overallStatus,
        overallSeverity,
        timestamps: input.timestamps,
        stages: input.stages,
    };
}
//# sourceMappingURL=buildStageResultV2.js.map