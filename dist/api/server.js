"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
exports.startServer = startServer;
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const runAgent_js_1 = require("../core/runAgent.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const applyLlmPatches_js_1 = require("../core/applyLlmPatches.js");
const runTestEngineerFlow_js_1 = require("../roles/runTestEngineerFlow.js");
const runDataAnalystFlow_js_1 = require("../roles/runDataAnalystFlow.js");
const colors_js_1 = require("../cli/colors.js");
exports.app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const progressStreams = new Map();
exports.app.use((0, cors_1.default)());
exports.app.use(body_parser_1.default.json());
exports.app.use(body_parser_1.default.urlencoded({ extended: true }));
function emitProgress(runId, stage) {
    if (!runId)
        return;
    const listeners = progressStreams.get(runId);
    if (!listeners)
        return;
    const payload = `data: ${JSON.stringify({ stage })}\n\n`;
    for (const res of listeners) {
        res.write(payload);
    }
}
exports.app.get("/api/progress", (req, res) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    if (!runId) {
        res.status(400).end();
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ stage: "Connected" })}\n\n`);
    const listeners = progressStreams.get(runId) ?? new Set();
    listeners.add(res);
    progressStreams.set(runId, listeners);
    req.on("close", () => {
        const current = progressStreams.get(runId);
        if (!current)
            return;
        current.delete(res);
        if (current.size === 0) {
            progressStreams.delete(runId);
        }
    });
});
exports.app.post("/api/analyze", async (req, res) => {
    const { task, repoPath } = req.body;
    const result = await (0, runAgent_js_1.runAgent)({ task, role: "developer" });
    res.json({
        decision: result.decision,
        risk: result.risk,
        confidence: result.confidence,
    });
});
exports.app.post("/api/patch", async (req, res) => {
    const { task, repoPath } = req.body;
    const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({ task, repoPath });
    res.json(result);
});
exports.app.post("/api/apply", async (req, res) => {
    const { patches, repoPath } = req.body;
    const result = await (0, applyLlmPatches_js_1.applyLlmPatches)(patches, repoPath);
    res.json(result);
});
exports.app.post("/api/test-engineer", async (req, res) => {
    const { task, repoPath, runId } = req.body;
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    try {
        const result = await (0, runTestEngineerFlow_js_1.runTestEngineerFlow)({
            task,
            repoPath,
            onProgress: (stage) => emitProgress(runId, stage),
        });
        res.json(result);
    }
    catch (err) {
        emitProgress(runId, "Ready");
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "Unknown error",
        });
    }
});
exports.app.post("/api/data-analyst", async (req, res) => {
    const { task, repoPath, runId } = req.body;
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    try {
        const result = await (0, runDataAnalystFlow_js_1.runDataAnalystFlow)({
            task,
            repoPath,
            onProgress: (stage) => emitProgress(runId, stage),
        });
        res.json(result);
    }
    catch (err) {
        emitProgress(runId, "Ready");
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "Unknown error",
        });
    }
});
exports.app.use(express_1.default.static("src/ui"));
async function startServer(port = 3000) {
    await new Promise((resolve) => {
        exports.app.listen(port, () => {
            console.log((0, colors_js_1.colorize)(`Zone UI running on http://localhost:${port}`, colors_js_1.c.green, colors_js_1.c.bold));
            console.log((0, colors_js_1.colorize)("Press Ctrl+C to stop", colors_js_1.c.dim, colors_js_1.c.gray));
            resolve();
        });
    });
}
if (process.env.VITEST !== "true" &&
    process.env.ZONE_SERVER_MANUAL_START !== "1") {
    void startServer(Number(PORT));
}
//# sourceMappingURL=server.js.map