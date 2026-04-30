"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRunStart = registerRunStart;
exports.registerRunComplete = registerRunComplete;
exports.getRunBuffer = getRunBuffer;
exports.attachDeveloperPatchProgressSseClient = attachDeveloperPatchProgressSseClient;
exports.detachDeveloperPatchProgressSseClient = detachDeveloperPatchProgressSseClient;
exports.emitDeveloperPatchProgress = emitDeveloperPatchProgress;
exports.closeDeveloperPatchProgressSseForRun = closeDeveloperPatchProgressSseForRun;
const progressStreams = new Map();
const runBuffers = new Map();
const COMPLETED_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_EVENTS = 5000;
function cleanupExpiredBuffers(now = Date.now()) {
    for (const [runId, buf] of runBuffers.entries()) {
        if ((buf.status === "completed" || buf.status === "cancelled") && buf.completedAt) {
            if (now - buf.completedAt > COMPLETED_TTL_MS) {
                runBuffers.delete(runId);
            }
        }
    }
}
function registerRunStart(runId, input) {
    const rid = String(runId || "").trim();
    if (!rid)
        return;
    cleanupExpiredBuffers();
    const existing = runBuffers.get(rid);
    if (existing && existing.status === "running") {
        if (input?.task && !existing.task)
            existing.task = input.task;
        return;
    }
    runBuffers.set(rid, {
        runId: rid,
        startedAt: Date.now(),
        status: "running",
        task: input?.task,
        events: [],
        maxEvents: DEFAULT_MAX_EVENTS,
    });
}
function registerRunComplete(runId, status) {
    const rid = String(runId || "").trim();
    if (!rid)
        return;
    cleanupExpiredBuffers();
    const buf = runBuffers.get(rid);
    const now = Date.now();
    if (buf) {
        buf.status = status;
        buf.completedAt = now;
        return;
    }
    runBuffers.set(rid, {
        runId: rid,
        startedAt: now,
        completedAt: now,
        status,
        events: [],
        maxEvents: DEFAULT_MAX_EVENTS,
    });
}
function getRunBuffer(runId) {
    const rid = String(runId || "").trim();
    if (!rid)
        return null;
    cleanupExpiredBuffers();
    return runBuffers.get(rid) ?? null;
}
function pushRunEvent(runId, payload) {
    const rid = String(runId || "").trim();
    if (!rid)
        return;
    cleanupExpiredBuffers();
    let buf = runBuffers.get(rid);
    if (!buf) {
        buf = {
            runId: rid,
            startedAt: Date.now(),
            status: "running",
            events: [],
            maxEvents: DEFAULT_MAX_EVENTS,
        };
        runBuffers.set(rid, buf);
    }
    buf.events.push({ ts: Date.now(), payload });
    if (buf.events.length > buf.maxEvents) {
        buf.events.splice(0, buf.events.length - buf.maxEvents);
    }
}
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
    pushRunEvent(runId, payload);
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
/** End all SSE connections for a run (e.g. user cancel). */
function closeDeveloperPatchProgressSseForRun(runId) {
    const listeners = progressStreams.get(runId);
    if (!listeners)
        return;
    for (const client of listeners) {
        try {
            client.end();
        }
        catch {
            // ignore
        }
    }
    progressStreams.delete(runId);
}
//# sourceMappingURL=developerRunProgressSse.js.map