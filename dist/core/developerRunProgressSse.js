"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachDeveloperPatchProgressSseClient = attachDeveloperPatchProgressSseClient;
exports.detachDeveloperPatchProgressSseClient = detachDeveloperPatchProgressSseClient;
exports.emitDeveloperPatchProgress = emitDeveloperPatchProgress;
const progressStreams = new Map();
function attachDeveloperPatchProgressSseClient(runId, res) {
    const listeners = progressStreams.get(runId) ?? new Set();
    listeners.add(res);
    progressStreams.set(runId, listeners);
}
function detachDeveloperPatchProgressSseClient(runId, res) {
    const current = progressStreams.get(runId);
    if (!current)
        return;
    current.delete(res);
    if (current.size === 0) {
        progressStreams.delete(runId);
    }
}
function emitDeveloperPatchProgress(runId, payload) {
    if (!runId)
        return;
    const listeners = progressStreams.get(runId);
    if (!listeners)
        return;
    const body = JSON.stringify(payload);
    const sse = `data: ${body}\n\n`;
    for (const client of listeners) {
        try {
            client.write(sse);
        }
        catch {
            // best-effort SSE
        }
    }
}
//# sourceMappingURL=developerRunProgressSse.js.map