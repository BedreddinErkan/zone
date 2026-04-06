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
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const supabase_js_1 = require("@supabase/supabase-js");
const runAgent_js_1 = require("../core/runAgent.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const taskIntentParser_js_1 = require("../core/taskIntentParser.js");
const applyLlmPatches_js_1 = require("../core/applyLlmPatches.js");
const runTestEngineerFlow_js_1 = require("../roles/runTestEngineerFlow.js");
const detectTestFramework_js_1 = require("../roles/detectTestFramework.js");
const testEngineerContext_js_1 = require("../roles/testEngineerContext.js");
const runDataAnalystFlow_js_1 = require("../roles/runDataAnalystFlow.js");
const detectDataSchema_js_1 = require("../roles/detectDataSchema.js");
const dataAnalystContext_js_1 = require("../roles/dataAnalystContext.js");
const scanRepo_js_1 = require("../repo/scanRepo.js");
const detectProjectStructure_js_1 = require("../repo/detectProjectStructure.js");
const rankRelevantFiles_js_1 = require("../repo/rankRelevantFiles.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const openaiClient_js_1 = require("../llm/openaiClient.js");
const colors_js_1 = require("../cli/colors.js");
exports.app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const progressStreams = new Map();
const zoneUiDir = node_path_1.default.resolve(__dirname, "../ui");
const zoneUiHtmlTemplate = (0, node_fs_1.readFileSync)(node_path_1.default.join(zoneUiDir, "index.html"), "utf8");
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
exports.app.get("/", (_req, res) => {
    res.type("html").send(renderZoneUiHtml());
});
exports.app.get("/index.html", (_req, res) => {
    res.type("html").send(renderZoneUiHtml());
});
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function renderZoneUiHtml() {
    const configScript = `<script>window.__ZONE_PUBLIC_CONFIG__=${JSON.stringify({
        posthogKey: typeof process.env.POSTHOG_KEY === "string"
            ? process.env.POSTHOG_KEY.trim()
            : "",
        posthogHost: typeof process.env.POSTHOG_HOST === "string"
            ? process.env.POSTHOG_HOST.trim()
            : "",
    })};</script>`;
    return zoneUiHtmlTemplate.replace("</head>", `${configScript}</head>`);
}
function shouldUseHostedInferenceProxy() {
    return (0, openaiClient_js_1.getInferenceMode)() === "hosted";
}
function logStartupDiagnostics() {
    const mode = (0, openaiClient_js_1.getInferenceMode)();
    console.log(`[zone] inference mode: ${mode}`);
    if (mode === "hosted") {
        const hostedBaseUrl = (0, openaiClient_js_1.getHostedInferenceBaseUrl)();
        console.log(`[zone] hosted inference base URL: ${hostedBaseUrl}`);
        if (hostedBaseUrl === "https://zonecli.dev") {
            console.warn("[zone] Warning: default hosted target https://zonecli.dev must serve the real Zone product API routes for full hosted role support.");
        }
        return;
    }
    const hasOpenAiKey = typeof process.env.OPENAI_API_KEY === "string" &&
        process.env.OPENAI_API_KEY.trim().length > 0;
    console.log(`[zone] local inference OPENAI_API_KEY: ${hasOpenAiKey ? "present" : "missing"}`);
    const explicitMode = (process.env.ZONE_INFERENCE_MODE || "")
        .trim()
        .toLowerCase();
    if (explicitMode === "local" && !hasOpenAiKey) {
        console.warn("[zone] Warning: ZONE_INFERENCE_MODE=local requires OPENAI_API_KEY for local inference.");
    }
}
async function proxyHostedZoneRequest(req, res, routePath, options) {
    const baseUrl = (0, openaiClient_js_1.getHostedInferenceBaseUrl)();
    const targetUrl = new URL(routePath, `${baseUrl}/`);
    const forwardedUserId = typeof req.body?.userId === "string"
        ? req.body.userId.trim()
        : typeof req.query.userId === "string"
            ? req.query.userId.trim()
            : "";
    const forwardedHeaders = {
        "Content-Type": "application/json",
        "x-zone-client": "local-ui",
    };
    if (typeof req.headers.authorization === "string" && req.headers.authorization) {
        forwardedHeaders.authorization = req.headers.authorization;
    }
    if (typeof req.headers.cookie === "string" && req.headers.cookie) {
        forwardedHeaders.cookie = req.headers.cookie;
    }
    if (forwardedUserId) {
        forwardedHeaders["x-zone-user-id"] = forwardedUserId;
    }
    if (req.method === "GET") {
        for (const [key, value] of Object.entries(req.query)) {
            if (typeof value === "string") {
                targetUrl.searchParams.set(key, value);
            }
        }
    }
    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: forwardedHeaders,
            body: req.method === "GET"
                ? undefined
                : JSON.stringify(options?.bodyOverride ?? req.body ?? {}),
        });
        if (response.status === 404 && options?.onNotFound) {
            await options.onNotFound();
            return;
        }
        const responseText = await response.text();
        const contentType = response.headers.get("content-type") ?? "application/json; charset=utf-8";
        res.status(response.status);
        res.setHeader("Content-Type", contentType);
        res.send(responseText);
    }
    catch (error) {
        res.status(502).json({
            ok: false,
            reason: "hosted_inference_unavailable",
            message: error instanceof Error
                ? `Zone hosted inference is unavailable: ${error.message}`
                : "Zone hosted inference is unavailable.",
        });
    }
}
async function buildHostedDeveloperContext(task, repoPath) {
    const allFiles = await (0, scanRepo_js_1.scanRepo)(repoPath);
    const developerContextFiles = allFiles.filter((file) => !(0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)(file.path));
    const structure = (0, detectProjectStructure_js_1.detectProjectStructure)(developerContextFiles);
    const taskIntent = (0, taskIntentParser_js_1.parseTaskIntent)(task);
    const relevantFiles = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
        task,
        files: developerContextFiles,
        intent: taskIntent,
    }).slice(0, 8);
    const contextFileRecords = relevantFiles.map((file) => ({
        path: file.path,
        action: "inspect",
        reason: "High repo relevance for the requested developer task",
        absolutePath: file.absolutePath,
    }));
    const contextPaths = contextFileRecords
        .map((file) => file.absolutePath)
        .filter((filePath) => typeof filePath === "string");
    const contentMap = contextPaths.length > 0 ? await (0, readProjectFiles_js_1.readProjectFiles)(contextPaths) : {};
    const originalContents = Object.fromEntries(contextFileRecords.map((file) => [
        file.path,
        file.absolutePath ? contentMap[file.absolutePath] ?? "" : "",
    ]));
    const existingFilesSummary = relevantFiles.length > 0
        ? "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n" +
            relevantFiles.map((file) => `- ${file.path}`).join("\n")
        : "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n(none)";
    return {
        repoSummary: structure.notes.join(" ") || "No project summary available.",
        projectNotes: structure.notes,
        existingFilesSummary,
        availableFiles: developerContextFiles.map((file) => ({
            path: file.path,
            category: file.category,
            extension: file.extension,
        })),
        contextFiles: contextFileRecords.map((file) => ({
            path: file.path,
            action: file.action,
            reason: file.reason,
            content: originalContents[file.path] ?? "",
        })),
        originalContents,
    };
}
async function buildHostedEnhanceContext(role, repoPath) {
    const repoFiles = await (0, scanRepo_js_1.scanRepo)(repoPath);
    const contextFiles = selectEnhanceContextFiles(role, repoFiles);
    const contents = contextFiles.length > 0
        ? await (0, readProjectFiles_js_1.readProjectFiles)(contextFiles.map((file) => file.absolutePath))
        : {};
    return {
        contextFiles: contextFiles.map((file) => ({
            path: file.path,
            content: contents[file.absolutePath] ?? "",
        })),
    };
}
async function buildHostedTestEngineerContext(task, repoPath) {
    const allFiles = await (0, scanRepo_js_1.scanRepo)(repoPath);
    const framework = (0, detectTestFramework_js_1.detectTestFramework)(allFiles);
    const context = (0, testEngineerContext_js_1.buildTestEngineerContext)(task, framework, allFiles);
    return {
        availableFiles: allFiles.map((file) => ({
            path: file.path,
            category: file.category,
            extension: file.extension,
        })),
        pageObjectContents: await (0, runTestEngineerFlow_js_1.readExampleContents)(context.pageObjectFiles, allFiles, 3),
        stepDefinitionContents: await (0, runTestEngineerFlow_js_1.readExampleContents)(context.stepDefinitionFiles, allFiles, 2),
        featureContents: await (0, runTestEngineerFlow_js_1.readFeatureExampleContents)(context.featureFiles, allFiles, framework),
        existingTestContents: await (0, runTestEngineerFlow_js_1.readExampleContents)(context.existingTestFiles, allFiles, 3),
    };
}
async function buildHostedDataAnalystContext(task, repoPath) {
    const allFiles = await (0, scanRepo_js_1.scanRepo)(repoPath);
    const schema = (0, detectDataSchema_js_1.detectDataSchema)(allFiles);
    const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)(task, schema, allFiles);
    const existingSqlFiles = context.existingSqlFiles.slice(0, 3);
    const sqlPaths = existingSqlFiles
        .map((file) => file.absolutePath)
        .filter((filePath) => typeof filePath === "string");
    const contents = sqlPaths.length > 0 ? await (0, readProjectFiles_js_1.readProjectFiles)(sqlPaths) : {};
    return {
        availableFiles: allFiles.map((file) => ({
            path: file.path,
            category: file.category,
            extension: file.extension,
        })),
        schema,
        existingSqlContents: existingSqlFiles.map((file) => ({
            path: file.path,
            content: file.absolutePath ? contents[file.absolutePath] ?? "" : "",
        })),
    };
}
async function handleCheckAccess(req, res) {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    const authorization = await ensureRunAuthorized(userId);
    if (authorization.allowed) {
        res.json({ ok: true });
        return;
    }
    res.status(authorization.status).json(authorization.body);
}
async function handleBillingSummary(req, res) {
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    if (!userId) {
        res.json({ ok: false, reason: "missing_user" });
        return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
        res.json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    const profilesTable = supabase.from("profiles");
    const query = profilesTable
        .select?.("credits,subscription_status")
        ?.eq?.("id", userId);
    if (!query || typeof query.maybeSingle !== "function") {
        res.json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    try {
        const { data, error } = await query.maybeSingle();
        if (error || !data) {
            res.json({ ok: false, reason: "profile_unavailable" });
            return;
        }
        const credits = typeof data.credits === "number"
            ? data.credits
            : Number(data.credits ?? 0);
        const status = normalizeSubscriptionStatus(data.subscription_status) || "free";
        res.json({
            ok: true,
            plan: hasPaidAccess(status) ? "Pro" : "Free",
            credits: Number.isFinite(credits) ? Math.max(0, credits) : 0,
            subscriptionStatus: status,
        });
    }
    catch {
        res.json({ ok: false, reason: "profile_unavailable" });
    }
}
async function logRun(input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return;
    const effectiveUserId = typeof input.userId === "string" ? input.userId.trim() : "";
    const userEmail = typeof process.env.ZONE_USER_EMAIL === "string"
        ? process.env.ZONE_USER_EMAIL.trim()
        : "";
    console.log(`[zone] logRun: effectiveUserId=${effectiveUserId || "missing"}`);
    if (!effectiveUserId) {
        console.log("[zone] logRun: missing user id, skipping run log + credit update");
        return;
    }
    const insertResult = await supabase.from("run_logs").insert({
        user_id: effectiveUserId,
        ...(userEmail ? { user_email: userEmail } : {}),
        role: input.role,
        task: input.task,
        repo_path: input.repoPath,
        decision: input.decisionMode,
        confidence: input.confidence,
        credits_used: input.creditsUsed,
    });
    if (insertResult.error) {
        console.log(`[zone] logRun: run_logs insert error=${insertResult.error.message}`);
    }
    else {
        console.log("[zone] logRun: run_logs insert ok");
    }
    let freeRunDebit = 1;
    const profilesRead = supabase.from("profiles");
    const profileQuery = profilesRead
        .select?.("credits,total_runs,subscription_status")
        ?.eq?.("id", effectiveUserId);
    if (profileQuery && typeof profileQuery.maybeSingle === "function") {
        try {
            const { data, error } = await profileQuery.maybeSingle();
            if (!error && data) {
                const normalizedStatus = normalizeSubscriptionStatus(data.subscription_status);
                const paidAccess = normalizedStatus === "pro";
                freeRunDebit = paidAccess ? 0 : 1;
                console.log(`[zone] logRun: subscription_status=${normalizedStatus || "missing"}`);
                console.log(`[zone] logRun: paidAccess=${paidAccess}`);
            }
            else {
                console.log("[zone] logRun: profile read failed, defaulting debit=1");
                freeRunDebit = 1;
            }
        }
        catch {
            console.log("[zone] logRun: profile read threw, defaulting debit=1");
            freeRunDebit = 1;
        }
    }
    console.log(`[zone] logRun: rpc debit=${freeRunDebit}`);
    const rpcResult = await supabase.rpc("deduct_credits_and_increment_runs", {
        p_user_id: effectiveUserId,
        p_credits: freeRunDebit,
    });
    if (rpcResult.error) {
        console.log(`[zone] logRun: rpc error=${rpcResult.error.message}`);
    }
    else {
        console.log("[zone] logRun: rpc ok");
    }
}
function queueRunLog(input) {
    const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    if (!userId)
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
function getTestEngineerUserFacingReason(reason) {
    if (reason.includes("Could not detect a test framework")) {
        return ("No supported test setup detected\n\n" +
            "Zone Test Engineer needs an existing supported test setup in this folder.\n" +
            "Supported: Playwright, Cypress, Cucumber+Java, Selenium (Java/Python), TestNG, or pytest.");
    }
    return reason;
}
function getDataAnalystUserFacingReason(reason) {
    if (reason.includes("detectDataSchema failed") ||
        reason.includes("buildDataAnalystContext failed")) {
        return ("No database context detected\n\n" +
            "Zone Data Analyst needs existing schema or migration context in this folder.\n" +
            "Supported signals include SQL migrations, Alembic, Flyway, Liquibase, or existing database files.");
    }
    return reason;
}
function normalizeSubscriptionStatus(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function hasPaidAccess(subscriptionStatus) {
    const normalized = normalizeSubscriptionStatus(subscriptionStatus);
    return normalized === "pro";
}
async function ensureRunAuthorized(rawUserId) {
    const authenticatedUserId = typeof rawUserId === "string" ? rawUserId.trim() : "";
    if (!authenticatedUserId) {
        return {
            allowed: false,
            status: 401,
            body: {
                ok: false,
                reason: "unauthorized",
                message: "Missing user session. Please open Zone from your dashboard.",
            },
        };
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
        return { allowed: true };
    }
    const profilesTable = supabase.from("profiles");
    if (typeof profilesTable.select !== "function") {
        return { allowed: true };
    }
    const query = profilesTable
        .select("credits,total_runs,subscription_status")
        ?.eq?.("id", authenticatedUserId);
    if (!query || typeof query.maybeSingle !== "function") {
        return { allowed: true };
    }
    try {
        const { data, error } = await query.maybeSingle();
        if (error || !data) {
            return { allowed: true };
        }
        const credits = typeof data.credits === "number"
            ? data.credits
            : Number(data.credits ?? 0);
        const subscriptionStatus = normalizeSubscriptionStatus(data.subscription_status);
        if (hasPaidAccess(subscriptionStatus)) {
            return { allowed: true };
        }
        if (credits > 0) {
            return { allowed: true };
        }
        return {
            allowed: false,
            status: 402,
            body: {
                ok: false,
                reason: "no_free_runs",
                message: "You've used all your free runs. Upgrade to Pro.",
                upgradeUrl: "https://zonecli.dev/#pricing",
            },
        };
    }
    catch {
        return { allowed: true };
    }
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
        const repoContext = input.hostedContext?.contextFiles && input.hostedContext.contextFiles.length > 0
            ? input.hostedContext.contextFiles
                .map((file) => {
                return `FILE: ${file.path}\n${file.content ?? ""}`;
            })
                .join("\n\n")
            : (() => {
                const repoFiles = (0, scanRepo_js_1.scanRepo)(input.repoPath);
                return repoFiles.then(async (files) => {
                    const contextFiles = selectEnhanceContextFiles(input.role, files);
                    const contents = contextFiles.length > 0
                        ? await (0, readProjectFiles_js_1.readProjectFiles)(contextFiles.map((file) => file.absolutePath))
                        : {};
                    return contextFiles.length > 0
                        ? contextFiles
                            .map((file) => {
                            const content = contents[file.absolutePath] ?? "";
                            return `FILE: ${file.path}\n${content}`;
                        })
                            .join("\n\n")
                        : "(no matching context files found)";
                });
            })();
        const resolvedRepoContext = typeof repoContext === "string" ? repoContext : await repoContext;
        const client = (0, openaiClient_js_1.createOpenAIClient)();
        const model = (0, openaiClient_js_1.getModelName)();
        const response = await client.responses.create({
            model,
            instructions: ENHANCE_TASK_SYSTEM_PROMPT,
            input: `Role: ${input.role}\n` +
                `Repo path: ${input.repoPath}\n` +
                `User task: ${input.task}\n\n` +
                `Relevant repository context:\n${resolvedRepoContext}`,
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
exports.app.get("/api/check-access", async (req, res) => {
    if (shouldUseHostedInferenceProxy()) {
        await proxyHostedZoneRequest(req, res, "/api/check-access", {
            onNotFound: () => handleCheckAccess(req, res),
        });
        return;
    }
    await handleCheckAccess(req, res);
});
exports.app.get("/api/billing-summary", async (req, res) => {
    if (shouldUseHostedInferenceProxy()) {
        await proxyHostedZoneRequest(req, res, "/api/billing-summary", {
            onNotFound: () => handleBillingSummary(req, res),
        });
        return;
    }
    await handleBillingSummary(req, res);
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
    if (shouldUseHostedInferenceProxy()) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = typeof task === "string" && typeof repoPath === "string"
            ? await buildHostedDeveloperContext(task, repoPath)
            : undefined;
        await proxyHostedZoneRequest(req, res, "/api/patch", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        return;
    }
    const { task, repoPath, userId } = req.body;
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    const authorization = await ensureRunAuthorized(userId);
    if (!authorization.allowed) {
        res.status(authorization.status).json(authorization.body);
        return;
    }
    const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({ task, repoPath });
    res.json(result);
    if (result.ok) {
        const confidence = typeof result.developerConfidence === "number"
            ? result.developerConfidence
            : 0;
        queueRunLog({
            userId,
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
    if (shouldUseHostedInferenceProxy()) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = typeof task === "string" && typeof repoPath === "string"
            ? await buildHostedDeveloperContext(task, repoPath)
            : undefined;
        await proxyHostedZoneRequest(req, res, "/api/dry-run", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        return;
    }
    const { task, repoPath, userId } = req.body;
    const authorization = await ensureRunAuthorized(userId);
    if (!authorization.allowed) {
        res.status(authorization.status).json(authorization.body);
        return;
    }
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
    const confidence = typeof result.developerConfidence === "number"
        ? result.developerConfidence
        : 0;
    queueRunLog({
        userId,
        role: "developer",
        task,
        repoPath,
        decisionMode: result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
        confidence,
        creditsUsed: 0.1,
    });
});
exports.app.post("/api/apply", async (req, res) => {
    const { patches, repoPath } = req.body;
    const result = await (0, applyLlmPatches_js_1.applyLlmPatches)(patches, repoPath);
    res.json(result);
});
exports.app.post("/api/enhance-task", async (req, res) => {
    if (shouldUseHostedInferenceProxy()) {
        const { role, repoPath } = req.body ?? {};
        const hostedContext = typeof role === "string" && typeof repoPath === "string"
            ? await buildHostedEnhanceContext(role, repoPath)
            : undefined;
        await proxyHostedZoneRequest(req, res, "/api/enhance-task", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        return;
    }
    const { task, role, repoPath, hostedContext } = req.body;
    if (!task || !role || !repoPath) {
        res
            .status(400)
            .json({ ok: false, reason: "task, role, and repoPath are required" });
        return;
    }
    try {
        const result = await enhanceTask({ task, role, repoPath, hostedContext });
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
    if (shouldUseHostedInferenceProxy()) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = typeof task === "string" && typeof repoPath === "string"
            ? await buildHostedTestEngineerContext(task, repoPath)
            : undefined;
        await proxyHostedZoneRequest(req, res, "/api/test-engineer", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        return;
    }
    const { task, repoPath, runId, userId, hostedContext } = req.body;
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    const authorization = await ensureRunAuthorized(userId);
    if (!authorization.allowed) {
        res.status(authorization.status).json(authorization.body);
        return;
    }
    try {
        const result = await (0, runTestEngineerFlow_js_1.runTestEngineerFlow)({
            task,
            repoPath,
            onProgress: (stage) => emitProgress(runId, stage),
            hostedContext,
        });
        if (!result.ok && typeof result.reason === "string") {
            result.reason = getTestEngineerUserFacingReason(result.reason);
        }
        res.json(result);
        if (result.ok) {
            queueRunLog({
                userId,
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
    if (shouldUseHostedInferenceProxy()) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = typeof task === "string" && typeof repoPath === "string"
            ? await buildHostedDataAnalystContext(task, repoPath)
            : undefined;
        await proxyHostedZoneRequest(req, res, "/api/data-analyst", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        return;
    }
    const { task, repoPath, runId, userId, hostedContext } = req.body;
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    const authorization = await ensureRunAuthorized(userId);
    if (!authorization.allowed) {
        res.status(authorization.status).json(authorization.body);
        return;
    }
    try {
        const result = await (0, runDataAnalystFlow_js_1.runDataAnalystFlow)({
            task,
            repoPath,
            onProgress: (stage) => emitProgress(runId, stage),
            hostedContext,
        });
        if (!result.ok && typeof result.reason === "string") {
            result.reason = getDataAnalystUserFacingReason(result.reason);
        }
        res.json(result);
        if (result.ok) {
            queueRunLog({
                userId,
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
exports.app.use(express_1.default.static(zoneUiDir));
async function startServer(port = 3000) {
    logStartupDiagnostics();
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