"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeProgressStage = encodeProgressStage;
exports.decodeProgressStage = decodeProgressStage;
const PREFIX = "__zlf1__";
/**
 * Stores optional structured lifecycle alongside the human progress string in
 * `developer_patch_jobs.progress_stage` without a schema migration.
 */
function encodeProgressStage(displayStage, lifecycle) {
    if (!lifecycle) {
        return displayStage;
    }
    return `${PREFIX}${JSON.stringify({ stage: displayStage, lifecycle })}`;
}
function decodeProgressStage(raw) {
    if (!raw) {
        return { displayStage: "" };
    }
    if (!raw.startsWith(PREFIX)) {
        return { displayStage: raw };
    }
    try {
        const parsed = JSON.parse(raw.slice(PREFIX.length));
        return {
            displayStage: typeof parsed.stage === "string" ? parsed.stage : raw,
            lastLifecycle: parsed.lifecycle,
        };
    }
    catch {
        return { displayStage: raw };
    }
}
//# sourceMappingURL=progressStageCodec.js.map