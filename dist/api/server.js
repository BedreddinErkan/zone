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
const supabase_js_1 = require("@supabase/supabase-js");
const runAgent_js_1 = require("../core/runAgent.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const applyLlmPatches_js_1 = require("../core/applyLlmPatches.js");
const runTestEngineerFlow_js_1 = require("../roles/runTestEngineerFlow.js");
const runDataAnalystFlow_js_1 = require("../roles/runDataAnalystFlow.js");
const scanRepo_js_1 = require("../repo/scanRepo.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const openaiClient_js_1 = require("../llm/openaiClient.js");
const colors_js_1 = require("../cli/colors.js");
exports.app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const progressStreams = new Map();
const ENHANCE_TASK_SYSTEM_PROMPT = "You are a task optimizer for an AI code agent called Zone.\n" +
    "The user has written a vague or incomplete task description.\n" +
    "Rewrite it as a precise, actionable task that includes:\n" +
    "- The specific file or component to modify (if inferable from repo)\n" +
    "- The exact behavior or test scenario\n" +
    "- The framework/pattern already used in the repo\n" +
    "Keep it under 2 sentences. Return only the optimized task text, nothing else.";
exports.app.use((0, cors_1.default)());
exports.app.use(body_parser_1.default.json());
exports.app.use(body_parser_1.default.urlencoded({ extended: true }));
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
async function logRun(input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return;
    await supabase.from("run_logs").insert({
        user_id: input.userId,
        role: input.role,
        task: input.task,
        repo_path: input.repoPath,
        decision: input.decisionMode,
        confidence: input.confidence,
        credits_used: input.creditsUsed,
    });
    await supabase.rpc("deduct_credits_and_increment_runs", {
        p_user_id: input.userId,
        p_credits: input.creditsUsed,
    });
}
function queueRunLog(input) {
    if (!process.env.ZONE_USER_ID)
        return;
    void logRun(input).catch(() => undefined);
}
function getDecisionModeFromResult(result, confidence) {
    const decisionMode = result["decisionMode"];
    if (typeof decisionMode === "string" && decisionMode.length > 0) {
        return decisionMode;
    }
    return confidence < 70 ? "preview_only" : "safe_to_apply";
}
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
function selectEnhanceContextFiles(role, files) {
    const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const roleMatchers = {
        test_engineer: (filePath) => /\.(spec|test)\.[jt]sx?$/i.test(filePath.replace(/\\/g, "/")),
        developer: (filePath) => /^src\/.*\.ts$/i.test(filePath.replace(/\\/g, "/")),
        data_analyst: (filePath) => {
            const normalized = filePath.replace(/\\/g, "/");
            return normalized.endsWith(".sql") || normalized.includes("/migrations/");
        },
    };
    const match = roleMatchers[role] ?? (() => false);
    return sortedFiles
        .filter((file) => Boolean(file.absolutePath) && match(file.path))
        .slice(0, 3);
}
async function enhanceTask(input) {
    try {
        const repoFiles = await (0, scanRepo_js_1.scanRepo)(input.repoPath);
        const contextFiles = selectEnhanceContextFiles(input.role, repoFiles);
        const contents = contextFiles.length > 0
            ? await (0, readProjectFiles_js_1.readProjectFiles)(contextFiles.map((file) => file.absolutePath))
            : {};
        const repoContext = contextFiles.length > 0
            ? contextFiles
                .map((file) => {
                const content = contents[file.absolutePath] ?? "";
                return `FILE: ${file.path}\n${content}`;
            })
                .join("\n\n")
            : "(no matching context files found)";
        const client = (0, openaiClient_js_1.createOpenAIClient)();
        const model = (0, openaiClient_js_1.getModelName)();
        const response = await client.responses.create({
            model,
            instructions: ENHANCE_TASK_SYSTEM_PROMPT,
            input: `Role: ${input.role}\n` +
                `Repo path: ${input.repoPath}\n` +
                `User task: ${input.task}\n\n` +
                `Relevant repository context:\n${repoContext}`,
        });
        return String(response.output_text || "").trim();
    }
    catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
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
    if (result.ok) {
        const confidence = typeof result.developerConfidence === "number" ? result.developerConfidence : 0;
        queueRunLog({
            userId: process.env.ZONE_USER_ID ?? "",
            role: "developer",
            task,
            repoPath,
            decisionMode: result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
            confidence,
            creditsUsed: 0.1,
        });
    }
});
exports.app.post("/api/dry-run", async (req, res) => {
    const { task, repoPath } = req.body;
    const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({ task, repoPath, dryRun: true });
    if (!result.ok) {
        res.status(500).json(result);
        return;
    }
    res.json({
        ok: true,
        fileDiffs: result.fileDiffs ?? [],
        patchPreview: result.patchPreview,
        warnings: result.warnings,
        patchResults: result.patchResults,
    });
});
exports.app.post("/api/apply", async (req, res) => {
    const { patches, repoPath } = req.body;
    const result = await (0, applyLlmPatches_js_1.applyLlmPatches)(patches, repoPath);
    res.json(result);
});
exports.app.post("/api/enhance-task", async (req, res) => {
    const { task, role, repoPath } = req.body;
    if (!task || !role || !repoPath) {
        res
            .status(400)
            .json({ ok: false, reason: "task, role, and repoPath are required" });
        return;
    }
    try {
        const result = await enhanceTask({ task, role, repoPath });
        res
            .type("application/json")
            .send(JSON.stringify({ ok: true, enhancedTask: result }));
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "Unknown error",
        });
    }
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
        if (result.ok) {
            queueRunLog({
                userId: process.env.ZONE_USER_ID ?? "",
                role: "test_engineer",
                task,
                repoPath,
                decisionMode: getDecisionModeFromResult(result, result.confidence),
                confidence: result.confidence,
                creditsUsed: 0.08,
            });
        }
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
        if (result.ok) {
            queueRunLog({
                userId: process.env.ZONE_USER_ID ?? "",
                role: "data_analyst",
                task,
                repoPath,
                decisionMode: getDecisionModeFromResult(result, result.confidence),
                confidence: result.confidence,
                creditsUsed: 0.06,
            });
        }
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