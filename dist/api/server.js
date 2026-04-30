"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
exports.startServer = startServer;
const node_crypto_1 = __importDefault(require("node:crypto"));
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const supabase_js_1 = require("@supabase/supabase-js");
const runAgent_js_1 = require("../core/runAgent.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const taskIntentParser_js_1 = require("../core/taskIntentParser.js");
const applyLlmPatches_js_1 = require("../core/applyLlmPatches.js");
const detectVerificationCommand_js_1 = require("../core/detectVerificationCommand.js");
const runRuntimeVerification_js_1 = require("../core/runRuntimeVerification.js");
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
const openaiContext_js_1 = require("../llm/openaiContext.js");
const refinePrompt_js_1 = require("../llm/refinePrompt.js");
const detectIntent_js_1 = require("../llm/detectIntent.js");
const chatResponse_js_1 = require("../llm/chatResponse.js");
const conversationRepository_js_1 = require("../billing/conversationRepository.js");
const resolveBillingAction_js_1 = require("../billing/resolveBillingAction.js");
const colors_js_1 = require("../cli/colors.js");
const agentLifecycleEvents_js_1 = require("../core/agentLifecycleEvents.js");
const developerRunProgressSse_js_1 = require("../core/developerRunProgressSse.js");
const commandApprovals_js_1 = require("./commandApprovals.js");
const progressStageCodec_js_1 = require("../core/progressStageCodec.js");
const validateLlmOutput_js_1 = require("../core/validateLlmOutput.js");
const lemonsqueezyWebhook_js_1 = __importDefault(require("../routes/lemonsqueezyWebhook.js"));
const createLemonCheckout_js_1 = __importDefault(require("../routes/createLemonCheckout.js"));
const getLemonCustomerPortal_js_1 = __importDefault(require("../routes/getLemonCustomerPortal.js"));
const runLogging_js_1 = require("./runLogging.js");
const zoneApiPerf_js_1 = require("./zoneApiPerf.js");
const developerPatchJobs_js_1 = require("../jobs/developerPatchJobs.js");
const activeRunsRepository_js_1 = require("../billing/activeRunsRepository.js");
const indexRepository_js_1 = require("../embeddings/indexRepository.js");
const logger_js_1 = require("../utils/logger.js");
exports.app = (0, express_1.default)();
/** Active /api/patch runs — cancelled via POST /api/cancel (AbortSignal → runLlmPatchFlow). */
const activePatchRunAbortControllers = new Map();
const port = Number(process.env.PORT) || 3000;
let startedPort = null;
let startPromise = null;
const zoneUiDir = node_path_1.default.resolve(__dirname, "../ui");
const zoneUiIndexPath = node_path_1.default.join(zoneUiDir, "index.html");
/** Cached HTML shell in production only; dev re-reads from disk each request so UI edits apply without restart. */
let zoneUiHtmlTemplateCached = null;
function installConsoleLogFilter() {
    const globalState = globalThis;
    if (globalState.__zoneConsoleFilterInstalled) {
        return;
    }
    globalState.__zoneConsoleFilterInstalled = true;
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    globalState.__zoneConsoleLogOriginal = originalLog;
    globalState.__zoneConsoleWarnOriginal = originalWarn;
    if (logger_js_1.LOG_LEVEL === "debug") {
        return;
    }
    const allowedPrefixes = [
        "[patch-handler]",
        "[zone-flow-entry]",
        "[active-runs]",
        "[zone-rank-hybrid-debug]",
        "[zone-rank-rescue-check]",
        "[zone-rank-rescue-debug]",
        "[zone-rank-semantic-rescue]",
        "[zone-context-priority]",
        "[zone-plan",
        "[zone-plan-debug]",
        "[zone-patch-diagnostic]",
        "[zone-verification-start]",
        "[zone-runtime-verify]",
        "[zone-billing-debug]",
        "[debug-mem]",
        "[resume-debug]",
        "[zone-embed-query-debug]",
        "[zone-chat-debug]",
        "[zone-intent-classify]",
    ];
    const shouldAllowLog = (args) => {
        if (logger_js_1.LOG_LEVEL === "quiet")
            return false;
        const first = typeof args[0] === "string" ? args[0] : "";
        if (first.startsWith("[zone-api-perf]") &&
            args.some((arg) => typeof arg === "string" && /\bcomplete\b/i.test(arg))) {
            return true;
        }
        return allowedPrefixes.some((prefix) => first.startsWith(prefix));
    };
    console.log = (...args) => {
        if (shouldAllowLog(args)) {
            originalLog(...args);
        }
    };
    console.warn = (...args) => {
        if (logger_js_1.LOG_LEVEL !== "quiet") {
            originalWarn(...args);
        }
    };
}
installConsoleLogFilter();
function readZoneUiHtmlTemplate() {
    if (process.env.NODE_ENV === "production") {
        if (!zoneUiHtmlTemplateCached) {
            zoneUiHtmlTemplateCached = (0, node_fs_1.readFileSync)(zoneUiIndexPath, "utf8");
        }
        return zoneUiHtmlTemplateCached;
    }
    return (0, node_fs_1.readFileSync)(zoneUiIndexPath, "utf8");
}
const ENHANCE_TASK_SYSTEM_PROMPT = "You are a task optimizer for an AI code agent called Zone.\n" +
    "The user has written a vague or incomplete task description.\n" +
    "Rewrite it as a precise, actionable task that includes:\n" +
    "- The specific file or component to modify (if inferable from repo)\n" +
    "- The exact behavior or test scenario\n" +
    "- The framework/pattern already used in the repo\n" +
    "Keep it under 2 sentences. Return only the optimized task text, nothing else.";
const FREE_PLAN_RUN_LIMIT = 10;
const PRO_PLAN_RUN_LIMIT = 250;
/** True when the client sent an actual hosted file payload (not billing-only / empty). */
function hostedDeveloperContextRequestHasFiles(ctx) {
    if (!ctx || typeof ctx !== "object")
        return false;
    const o = ctx;
    const cf = o.contextFiles;
    const legacy = o.files;
    return ((Array.isArray(cf) && cf.length > 0) ||
        (Array.isArray(legacy) && legacy.length > 0));
}
exports.app.use((0, cors_1.default)({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
    ],
    exposedHeaders: ["Content-Length", "X-Request-Id"],
}));
exports.app.set('trust proxy', 1);
exports.app.use("/api/lemonsqueezy/webhook", express_1.default.raw({ type: "application/json" }), lemonsqueezyWebhook_js_1.default);
exports.app.use(body_parser_1.default.json({ limit: "10mb" }));
exports.app.use(body_parser_1.default.urlencoded({ extended: true, limit: "10mb" }));
exports.app.use(body_parser_1.default.urlencoded({ extended: true }));
exports.app.use("/api/lemonsqueezy/create-checkout", createLemonCheckout_js_1.default);
exports.app.use("/api/lemonsqueezy/customer-portal", getLemonCustomerPortal_js_1.default);
const developerRouteLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        reason: "rate_limited",
        message: "Too many requests. Please slow down.",
    },
});
exports.app.use("/api/analyze", developerRouteLimiter);
exports.app.use("/api/patch", developerRouteLimiter);
exports.app.use("/api/cancel", developerRouteLimiter);
exports.app.use("/api/approve-command", developerRouteLimiter);
exports.app.use("/api/dry-run", developerRouteLimiter);
// Increase timeouts for long-running patch operations & SSE.
exports.app.use("/api/patch", (_req, res, next) => {
    res.setTimeout(300000); // 5 minutes
    next();
});
exports.app.use("/api/progress", (_req, res, next) => {
    res.setTimeout(300000); // 5 minutes
    next();
});
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
    const currentUserId = typeof process.env.ZONE_USER_ID === "string"
        ? process.env.ZONE_USER_ID.trim()
        : "";
    const currentUserEmail = typeof process.env.ZONE_USER_EMAIL === "string"
        ? process.env.ZONE_USER_EMAIL.trim()
        : "";
    const debugFallbackUserId = typeof process.env.ZONE_DEBUG_FALLBACK_USER_ID === "string"
        ? process.env.ZONE_DEBUG_FALLBACK_USER_ID.trim()
        : "";
    const zoneApiBaseUrl = typeof process.env.ZONE_API_BASE_URL === "string"
        ? process.env.ZONE_API_BASE_URL.trim()
        : "";
    const currentUser = currentUserId
        ? {
            id: currentUserId,
            ...(currentUserEmail ? { email: currentUserEmail } : {}),
        }
        : null;
    const configScript = `<script>window.__ZONE_PUBLIC_CONFIG__=${JSON.stringify({
        posthogKey: typeof process.env.POSTHOG_KEY === "string"
            ? process.env.POSTHOG_KEY.trim()
            : "",
        posthogHost: typeof process.env.POSTHOG_HOST === "string"
            ? process.env.POSTHOG_HOST.trim()
            : "",
        currentUser,
        debugFallbackUserId,
        zoneApiBaseUrl,
        /** True when the server has OPENAI_API_KEY set in the environment.
         *  Used by the UI to decide whether to prompt for a user-supplied key.
         *  The key VALUE is never exposed. */
        serverHasOpenAIKey: !!(typeof process.env.OPENAI_API_KEY === "string" &&
            process.env.OPENAI_API_KEY.trim()),
    })};window.currentUser=window.currentUser||${JSON.stringify(currentUser)};</script>`;
    return readZoneUiHtmlTemplate().replace("</head>", `${configScript}</head>`);
}
function shouldUseHostedInferenceProxy() {
    return (0, openaiClient_js_1.getInferenceMode)() === "hosted";
}
function getHeaderUserApiKey(req) {
    return typeof req.headers["x-user-openai-key"] === "string"
        ? req.headers["x-user-openai-key"].trim()
        : "";
}
function maskApiKeyPrefix(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed.slice(0, 7) : "none";
}
function getRequestOrigin(req) {
    const forwardedProto = req.get("x-forwarded-proto");
    const forwardedHost = req.get("x-forwarded-host");
    const proto = (forwardedProto || req.protocol || "http").split(",")[0].trim();
    const host = (forwardedHost || req.get("host") || "").split(",")[0].trim();
    return host ? `${proto}://${host}`.toLowerCase() : "";
}
function shouldProxyHostedRequest(req, routePath) {
    if (!shouldUseHostedInferenceProxy()) {
        return false;
    }
    let targetOrigin = "";
    try {
        targetOrigin = new URL((0, openaiClient_js_1.getHostedInferenceBaseUrl)()).origin.toLowerCase();
    }
    catch {
        console.warn(`[zone] hosted proxy bypass: invalid hosted base URL for ${routePath}`);
        return false;
    }
    const requestOrigin = getRequestOrigin(req);
    if (requestOrigin && requestOrigin === targetOrigin) {
        console.warn(`[zone] self-proxy bypass: ${routePath} target ${targetOrigin} matches current request origin`);
        return false;
    }
    return true;
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
    if (typeof req.headers["x-user-openai-key"] === "string" &&
        req.headers["x-user-openai-key"].trim()) {
        forwardedHeaders["x-user-openai-key"] = req.headers["x-user-openai-key"].trim();
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
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    const billingMode = undefined;
    const repoPath = typeof req.query.repoPath === "string" ? req.query.repoPath : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    console.log("[zone-billing-debug] preflight check start", {
        routeName: "/api/check-access",
        userId: userId || null,
        billingMode: billingMode ?? null,
        repoPath: repoPath ?? null,
        role: role ?? null,
    });
    const authorization = await ensureRunAuthorized(userId, {
        conversationId,
        billingMode,
        repoPath,
        role,
    });
    if (authorization.allowed) {
        console.log("[zone-billing-debug] preflight check allowed", {
            routeName: "/api/check-access",
            userId: userId || null,
            billingMode: billingMode ?? null,
        });
        res.json({ ok: true });
        return;
    }
    console.log("[zone-billing-debug] preflight check blocked", {
        routeName: "/api/check-access",
        userId: userId || null,
        billingMode: billingMode ?? null,
        status: authorization.status,
        reason: authorization.body.reason,
    });
    res.status(authorization.status).json(authorization.body);
}
async function handleBillingSummary(req, res) {
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    console.log(`[zone] billing-summary: userId=${userId || "missing"}`);
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
    console.log(`[zone] billing-summary: querying profiles where clerk_user_id=${userId}`);
    const query = profilesTable
        .select?.("subscription_status,billing_mode,token_credits_used,token_credits_limit,token_credits_used_today,token_credits_daily_limit,daily_reset_at")
        ?.eq?.("clerk_user_id", userId);
    if (!query || typeof query.maybeSingle !== "function") {
        res.json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    try {
        const { data, error } = await query.maybeSingle();
        console.log("[zone-billing-summary-debug] raw profile row", {
            userId,
            data,
            error: error && typeof error === "object"
                ? {
                    message: "message" in error
                        ? error.message
                        : undefined,
                    code: "code" in error
                        ? error.code
                        : undefined,
                    details: "details" in error
                        ? error.details
                        : undefined,
                    hint: "hint" in error
                        ? error.hint
                        : undefined,
                }
                : error,
        });
        if (error || !data) {
            res.json({ ok: false, reason: "profile_unavailable" });
            return;
        }
        const status = normalizeSubscriptionStatus(data.subscription_status) || "free";
        const tokenCreditsUsed = typeof data.token_credits_used === "number"
            ? data.token_credits_used
            : Number(data.token_credits_used ?? 0);
        const tokenCreditsLimit = typeof data.token_credits_limit === "number"
            ? data.token_credits_limit
            : Number(data.token_credits_limit ?? 500000);
        const tokenCreditsRemaining = Math.max(0, tokenCreditsLimit - tokenCreditsUsed);
        const tokenCreditsUsedToday = typeof data.token_credits_used_today === "number"
            ? data.token_credits_used_today
            : Number(data.token_credits_used_today ?? 0);
        const tokenCreditsDailyLimit = typeof data.token_credits_daily_limit === "number"
            ? data.token_credits_daily_limit
            : Number(data.token_credits_daily_limit ?? 50000);
        const tokenCreditsDailyRemaining = Math.max(0, tokenCreditsDailyLimit - tokenCreditsUsedToday);
        const dailyResetAt = typeof data.daily_reset_at === "string" ? data.daily_reset_at : null;
        const dailyResetMs = dailyResetAt ? new Date(dailyResetAt).getTime() + 24 * 60 * 60 * 1000 : null;
        const billingMode = typeof data.billing_mode === "string" && data.billing_mode.trim()
            ? data.billing_mode.trim()
            : "hosted";
        const responsePayload = {
            ok: true,
            plan: hasPaidAccess(status) ? "Pro" : "Free",
            billingMode,
            tokenCreditsUsed,
            tokenCreditsLimit,
            tokenCreditsRemaining,
            tokenCreditsUsedToday,
            tokenCreditsDailyLimit,
            tokenCreditsDailyRemaining,
            dailyResetAt: dailyResetMs,
            subscriptionStatus: status,
            billing_mode: billingMode,
        };
        console.log("[zone-billing-summary-debug] resolved token credits", {
            userId,
            tokenCreditsUsed,
            tokenCreditsLimit,
            tokenCreditsRemaining,
            tokenCreditsUsedToday,
            tokenCreditsDailyLimit,
            tokenCreditsDailyRemaining,
            dailyResetAt: dailyResetMs,
            subscriptionStatus: status,
            billingMode,
        });
        console.log("[zone-billing-summary-debug] final response payload", responsePayload);
        res.json(responsePayload);
    }
    catch {
        res.json({ ok: false, reason: "profile_unavailable" });
    }
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
// ── DESKTOP DEVICE CODE AUTH ────────────────────────────────
const DESKTOP_TOKEN_SECRET = (process.env.ZONE_DESKTOP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "zone-desktop-fallback").trim();
const DESKTOP_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const deviceCodes = new Map();
function generateDesktopToken(userId) {
    const expiry = Date.now() + DESKTOP_TOKEN_EXPIRY_MS;
    const payload = `${userId}:${expiry}`;
    const hmac = node_crypto_1.default.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(payload).digest("base64url");
    return Buffer.from(payload).toString("base64url") + "." + hmac;
}
function verifyDesktopToken(token) {
    try {
        const [payloadB64, hmac] = token.split(".");
        if (!payloadB64 || !hmac)
            return null;
        const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
        const expectedHmac = node_crypto_1.default.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(payload).digest("base64url");
        if (hmac !== expectedHmac)
            return null;
        const [userId, expiryStr] = payload.split(":");
        if (!userId || Number(expiryStr) < Date.now())
            return null;
        return userId;
    }
    catch {
        return null;
    }
}
// Cleanup expired codes every 5 min
setInterval(() => {
    const now = Date.now();
    for (const [code, data] of deviceCodes) {
        if (now - data.createdAt > 10 * 60 * 1000)
            deviceCodes.delete(code);
    }
}, 5 * 60 * 1000);
async function ensureRunAuthorized(rawUserId, options) {
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
    try {
        const profileQuery = supabase.from("profiles");
        const { data: profileData } = await profileQuery
            .select("subscription_status,billing_mode,token_credits_used,token_credits_limit,token_credits_used_today,token_credits_daily_limit,daily_reset_at")
            .eq("clerk_user_id", authenticatedUserId)
            .maybeSingle();
        const subscriptionStatus = normalizeSubscriptionStatus(profileData?.subscription_status) || "free";
        const paidAccess = hasPaidAccess(subscriptionStatus);
        const resolvedBillingMode = typeof profileData?.billing_mode === "string" && profileData.billing_mode.trim()
            ? profileData.billing_mode.trim()
            : "hosted";
        const tokenCreditsUsed = typeof profileData?.token_credits_used === "number"
            ? profileData.token_credits_used
            : Number(profileData?.token_credits_used ?? 0);
        const tokenCreditsLimit = typeof profileData?.token_credits_limit === "number"
            ? profileData.token_credits_limit
            : Number(profileData?.token_credits_limit ?? 500000);
        const tokenCreditsUsedToday = typeof profileData?.token_credits_used_today === "number"
            ? profileData.token_credits_used_today
            : Number(profileData?.token_credits_used_today ?? 0);
        const tokenCreditsDailyLimit = typeof profileData?.token_credits_daily_limit === "number"
            ? profileData.token_credits_daily_limit
            : Number(profileData?.token_credits_daily_limit ?? 50000);
        const dailyResetAtRaw = typeof profileData?.daily_reset_at === "string" ? profileData.daily_reset_at : null;
        const dailyResetAt = dailyResetAtRaw ? new Date(dailyResetAtRaw).getTime() + 24 * 60 * 60 * 1000 : null;
        const billingAction = (0, resolveBillingAction_js_1.resolveBillingAction)({
            mode: "hosted",
            hasPaidAccess: paidAccess,
            runsUsedThisMonth: 0,
            credits: 0,
            tokenCreditsUsed,
            tokenCreditsLimit,
        });
        console.log("[zone-billing-debug] authorization resolved", {
            routeName: "ensureRunAuthorized",
            userId: authenticatedUserId,
            billingMode: resolvedBillingMode,
            subscriptionStatus,
            hasPaidAccess: paidAccess,
            billingAction,
            tokenCreditsUsed,
            tokenCreditsLimit,
            tokenCreditsUsedToday,
            tokenCreditsDailyLimit,
            dailyResetAt,
        });
        if (billingAction === "FREE")
            return { allowed: true };
        if (tokenCreditsDailyLimit < 999999999 && tokenCreditsUsedToday >= tokenCreditsDailyLimit) {
            return {
                allowed: false,
                status: 429,
                body: {
                    ok: false,
                    reason: "token_daily_limit_reached",
                    message: "Daily token limit reached. Try again after the daily reset.",
                    dailyResetAt,
                },
            };
        }
        if (billingAction === "LIMIT_EXCEEDED") {
            if (!paidAccess) {
                return {
                    allowed: false,
                    status: 402,
                    body: {
                        ok: false,
                        reason: "token_limit_reached",
                        message: "You've used all your tokens. Upgrade to Pro.",
                        upgradeUrl: "https://zonecli.dev/#pricing",
                    },
                };
            }
            return {
                allowed: false,
                status: 402,
                body: {
                    ok: false,
                    reason: "token_limit_reached",
                    message: "Token limit reached for this billing period.",
                    tokenCreditsUsed,
                    tokenCreditsLimit,
                },
            };
        }
        return { allowed: true };
    }
    catch {
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
}
function emitProgress(runId, update) {
    if (!runId)
        return;
    if (typeof update === "string") {
        (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runId, { stage: update });
    }
    else {
        const progress = update.progress && !update.progress.runId
            ? { ...update.progress, runId, ts: update.progress.ts ?? Date.now() }
            : update.progress;
        (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runId, {
            stage: update.stage,
            lifecycle: update.lifecycle,
            progress,
        });
    }
}
async function persistChatConversationMessage(input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return;
    await (0, conversationRepository_js_1.appendConversationMessages)(supabase, {
        userId: input.userId,
        threadId: input.threadId,
        repoPath: input.repoPath,
        appendMessages: [
            {
                type: "chat_response",
                runId: input.runId,
                ts: Date.now(),
                userText: input.userText,
                responseText: input.responseText,
                responseHtml: input.responseHtml,
                contextFiles: input.contextFiles.slice(0, 10),
            },
        ],
    });
}
async function runConversationalFlow(input) {
    emitProgress(input.runId, {
        stage: "chat_response",
        progress: {
            type: "chat_start",
            title: "Thinking...",
            runId: input.runId,
            ts: Date.now(),
            status: "active",
        },
        lifecycle: (0, agentLifecycleEvents_js_1.createAgentLifecycleEvent)({
            type: "run_started",
            message: "Conversational response started.",
            stage: "init",
            status: "active",
        }),
    });
    const chatResult = await (0, chatResponse_js_1.getChatResponseWithContext)({
        task: input.task,
        repoPath: input.repoPath,
        onChunk: async (delta) => {
            emitProgress(input.runId, {
                stage: "chat_response",
                progress: {
                    type: "chat_chunk",
                    title: "Streaming response",
                    delta,
                    runId: input.runId,
                    ts: Date.now(),
                    status: "active",
                },
            });
        },
    });
    emitProgress(input.runId, {
        stage: "chat_response",
        progress: {
            type: "chat_done",
            title: "Response ready",
            runId: input.runId,
            ts: Date.now(),
            status: "success",
            responseText: chatResult.responseText,
            responseHtml: chatResult.responseHtml,
            contextFiles: chatResult.contextFiles,
        },
        lifecycle: (0, agentLifecycleEvents_js_1.createAgentLifecycleEvent)({
            type: "run_completed",
            message: "Conversational response completed.",
            stage: "finalize",
            status: "success",
        }),
    });
    const finalConversationId = typeof input.conversationId === "string" && input.conversationId.trim()
        ? input.conversationId.trim()
        : input.runId;
    try {
        await persistChatConversationMessage({
            userId: input.userId,
            threadId: finalConversationId,
            repoPath: input.repoPath,
            runId: input.runId,
            userText: input.task,
            responseText: chatResult.responseText,
            responseHtml: chatResult.responseHtml,
            contextFiles: chatResult.contextFiles,
        });
    }
    catch (error) {
        console.warn("[zone-chat-debug]", JSON.stringify({
            stage: "conversation_persist_failed",
            error: error instanceof Error ? error.message : String(error),
        }));
    }
    return {
        ok: true,
        decisionMode: "chat",
        chatResponse: chatResult.responseText,
        responseHtml: chatResult.responseHtml,
        contextFiles: chatResult.contextFiles,
        messageType: input.messageType,
        conversationId: finalConversationId,
        applyPatches: [],
        fileDiffs: [],
    };
}
async function createDeveloperPatchJobPayload(input) {
    let hostedContext = input.hostedContext;
    if (!hostedContext &&
        shouldUseHostedInferenceProxy() &&
        typeof input.task === "string" &&
        typeof input.repoPath === "string") {
        hostedContext = await buildHostedDeveloperContext(input.task, input.repoPath);
    }
    return {
        task: input.task,
        repoPath: input.repoPath,
        userId: input.userId,
        conversationId: input.conversationId,
        billingMode: input.billingMode,
        hostedContext,
    };
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
        const client = (0, openaiClient_js_1.createOpenAIClient)(input.userApiKey);
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
    (0, developerRunProgressSse_js_1.attachDeveloperPatchProgressSseClient)(runId, res);
    const keepalive = setInterval(() => {
        try {
            res.write(": keepalive\n\n");
        }
        catch {
            clearInterval(keepalive);
        }
    }, 15000);
    req.on("close", () => {
        clearInterval(keepalive);
        (0, developerRunProgressSse_js_1.detachDeveloperPatchProgressSseClient)(runId, res);
    });
});
exports.app.get("/api/run-status/:runId", (req, res) => {
    const runId = typeof req.params?.runId === "string" ? req.params.runId.trim() : "";
    if (!runId) {
        res.status(400).json({ ok: false, reason: "missing_run_id" });
        return;
    }
    const buf = (0, developerRunProgressSse_js_1.getRunBuffer)(runId);
    if (!buf) {
        res.status(404).json({ ok: false, reason: "not_found" });
        return;
    }
    res.json({
        ok: true,
        runId,
        status: buf.status,
        task: buf.task ?? null,
        startedAt: buf.startedAt,
        completedAt: buf.completedAt ?? null,
        eventCount: buf.events.length,
    });
});
exports.app.get("/api/active-runs", async (req, res) => {
    const rawUserId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const userId = rawUserId || (process.env.NODE_ENV !== "production" ? "dev-user" : "");
    if (!userId) {
        res.status(401).json({
            ok: false,
            reason: "unauthorized",
            message: "Missing user session. Please open Zone from your dashboard.",
        });
        return;
    }
    try {
        const runs = await (0, activeRunsRepository_js_1.getActiveRunsByUser)(userId);
        logger_js_1.logger.info("[active-runs] poll, count=%d, staleCount=%d", runs.length, runs.filter((run) => run.status !== "running").length);
        console.log("[resume-debug] /api/active-runs", {
            rawUserId: rawUserId || null,
            effectiveUserId: userId,
            count: runs.length,
            runIds: runs.map((run) => run.runId),
            statuses: runs.map((run) => ({ runId: run.runId, status: run.status })),
        });
        res.json(runs.map((run) => ({
            runId: run.runId,
            task: run.task,
            repoPath: run.repoPath,
            threadId: run.threadId,
            status: run.status,
            startedAt: run.startedAt,
            lastChangedFiles: run.lastChangedFiles,
            lastAddedFunctions: run.lastAddedFunctions,
        })));
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "active_runs_lookup_failed",
        });
    }
});
exports.app.get("/api/run-replay/:runId", (req, res) => {
    const runId = typeof req.params?.runId === "string" ? req.params.runId.trim() : "";
    if (!runId) {
        res.status(400).end();
        return;
    }
    const buf = (0, developerRunProgressSse_js_1.getRunBuffer)(runId);
    if (!buf) {
        res.status(404).end();
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    // Replay buffered events first.
    try {
        for (const evt of buf.events) {
            res.write(`data: ${JSON.stringify(evt.payload)}\n\n`);
        }
    }
    catch {
        // ignore
    }
    // If still running, attach for live tail; otherwise close.
    if (buf.status !== "running") {
        try {
            res.end();
        }
        catch { }
        return;
    }
    (0, developerRunProgressSse_js_1.attachDeveloperPatchProgressSseClient)(runId, res);
    const keepalive = setInterval(() => {
        try {
            res.write(": keepalive\n\n");
        }
        catch {
            clearInterval(keepalive);
        }
    }, 15000);
    req.on("close", () => {
        clearInterval(keepalive);
        (0, developerRunProgressSse_js_1.detachDeveloperPatchProgressSseClient)(runId, res);
    });
});
exports.app.post("/api/cancel", (req, res) => {
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    if (!runId) {
        res.status(400).json({ ok: false, reason: "missing_run_id" });
        return;
    }
    const ac = activePatchRunAbortControllers.get(runId);
    if (!ac) {
        res.status(404).json({ ok: false, reason: "no_active_run" });
        return;
    }
    try {
        (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runId, {
            stage: "Cancelled",
            lifecycle: (0, agentLifecycleEvents_js_1.createAgentLifecycleEvent)({
                type: "run_cancelled",
                message: "Run cancelled by user.",
                stage: "finalize",
            }),
        });
    }
    catch {
        // best-effort
    }
    (0, developerRunProgressSse_js_1.closeDeveloperPatchProgressSseForRun)(runId);
    try {
        // If a command approval is pending, treat cancel as rejection.
        (0, commandApprovals_js_1.rejectPendingApprovalsForRun)(runId);
    }
    catch {
        // best-effort
    }
    try {
        ac.abort();
    }
    catch {
        // ignore
    }
    activePatchRunAbortControllers.delete(runId);
    try {
        (0, developerRunProgressSse_js_1.registerRunComplete)(runId, "cancelled");
    }
    catch { }
    void (0, activeRunsRepository_js_1.completeActiveRun)(runId, "cancelled").catch(() => undefined);
    res.json({ ok: true });
});
// Native OS folder-picker — returns the full filesystem path selected by the user.
// Uses PowerShell FolderBrowserDialog on Windows, osascript on macOS,
// zenity/kdialog on Linux. Falls back gracefully if none available.
exports.app.post("/api/browse-folder", (_req, res) => {
    const platform = process.platform;
    let command;
    if (platform === "win32") {
        command = [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            [
                "Add-Type -AssemblyName System.Windows.Forms;",
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
                "$d.Description = 'Select project folder';",
                "$d.ShowNewFolderButton = $true;",
                "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)",
                "{ Write-Output $d.SelectedPath }",
                "else { exit 1 }",
            ].join(" "),
        ].join(" ");
    }
    else if (platform === "darwin") {
        command =
            "osascript -e 'POSIX path of (choose folder with prompt \"Select project folder\")'";
    }
    else {
        // Linux: prefer zenity, fall back to kdialog
        command =
            "zenity --file-selection --directory --title='Select project folder' 2>/dev/null ||" +
                " kdialog --getexistingdirectory \"$HOME\" 2>/dev/null";
    }
    try {
        const result = (0, node_child_process_1.execSync)(command, { encoding: "utf8", timeout: 120_000 }).trim();
        if (!result) {
            res.json({ ok: false, cancelled: true });
            return;
        }
        const parts = result.replace(/\\/g, "/").split("/").filter(Boolean);
        const name = parts[parts.length - 1] || result;
        res.json({ ok: true, path: result, name });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Exit code 1 from zenity/kdialog/osascript = user cancelled — not an error.
        if (/exit code 1|status 1|exited with code 1/i.test(msg)) {
            res.json({ ok: false, cancelled: true });
        }
        else {
            res.json({ ok: false, error: "Folder picker unavailable on this system" });
        }
    }
});
exports.app.post("/api/approve-command", (req, res) => {
    const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const approved = !!req.body?.approved;
    if (!approvalId || !runId) {
        res.status(400).json({ ok: false, reason: "missing_approval_id_or_run_id" });
        return;
    }
    const r = (0, commandApprovals_js_1.resolveCommandApproval)({ approvalId, approved, runId });
    if (!r.ok) {
        res.status(404).json({ ok: false, reason: r.message || "not_found" });
        return;
    }
    res.json({ ok: true });
});
exports.app.post("/api/run-command", async (req, res) => {
    const { command: rawCommand, repoPath, runId } = req.body ?? {};
    const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
    const repo = typeof repoPath === "string" ? repoPath.trim() : "";
    const rid = typeof runId === "string" ? runId.trim() : "";
    if (!command || !repo || !rid) {
        res.status(400).json({ ok: false, reason: "missing_command_repoPath_or_runId" });
        return;
    }
    // Respond immediately; output will stream via SSE.
    res.json({ ok: true });
    const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const emitTerminalLine = (line, stream) => {
        emitProgress(rid, {
            stage: "terminal_output",
            progress: {
                runId: rid,
                ts: Date.now(),
                type: "terminal_output",
                title: line,
                status: "active",
                stream,
            },
        });
    };
    const emitDone = (exitCode) => {
        emitProgress(rid, {
            stage: "terminal_done",
            progress: {
                runId: rid,
                ts: Date.now(),
                type: "terminal_done",
                title: "terminal_done",
                status: exitCode === 0 ? "success" : "error",
                exitCode,
            },
        });
    };
    let killedByTimeout = false;
    const child = (0, node_child_process_1.exec)(command, { cwd: repo, timeout: 30000, windowsHide: true, shell });
    const bufs = { stdout: "", stderr: "" };
    const flush = (stream) => {
        const s = bufs[stream];
        const parts = s.split(/\r?\n/);
        bufs[stream] = parts.pop() ?? "";
        for (const p of parts) {
            if (p.trim().length === 0)
                continue;
            emitTerminalLine(p, stream);
        }
    };
    child.stdout?.on("data", (chunk) => {
        bufs.stdout += String(chunk ?? "");
        flush("stdout");
    });
    child.stderr?.on("data", (chunk) => {
        bufs.stderr += String(chunk ?? "");
        flush("stderr");
    });
    // `exec` handles timeout internally; detect it by error.killed/signal in callback.
    child.on("error", () => {
        // best-effort; callback will emit done
    });
    child.on("close", (code) => {
        flush("stdout");
        flush("stderr");
        const exitCode = typeof code === "number" ? code : (killedByTimeout ? 124 : 1);
        emitDone(exitCode);
        (0, developerRunProgressSse_js_1.closeDeveloperPatchProgressSseForRun)(rid);
    });
    child.once("exit", (_code, signal) => {
        if (signal && String(signal).toLowerCase().includes("sigterm"))
            killedByTimeout = true;
    });
});
// ── Desktop Auth Routes ──
exports.app.post("/api/desktop-auth/start", (_req, res) => {
    const code = node_crypto_1.default.randomBytes(3).toString("hex").toUpperCase(); // 6 char: "A1B2C3"
    deviceCodes.set(code, { createdAt: Date.now() });
    res.json({ ok: true, code, expiresIn: 600 });
});
exports.app.get("/api/desktop-auth/poll", (req, res) => {
    const code = String(req.query.code || "").trim().toUpperCase();
    const entry = deviceCodes.get(code);
    if (!entry) {
        res.json({ ok: false, status: "expired" });
        return;
    }
    if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
        deviceCodes.delete(code);
        res.json({ ok: false, status: "expired" });
        return;
    }
    if (!entry.userId) {
        res.json({ ok: false, status: "pending" });
        return;
    }
    const token = generateDesktopToken(entry.userId);
    deviceCodes.delete(code);
    res.json({ ok: true, status: "complete", token, userId: entry.userId });
});
exports.app.post("/api/desktop-auth/complete", (req, res) => {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const userId = String(req.body?.userId || "").trim();
    if (!code || !userId) {
        res.status(400).json({ ok: false, reason: "missing_code_or_user" });
        return;
    }
    const entry = deviceCodes.get(code);
    if (!entry) {
        res.status(404).json({ ok: false, reason: "code_expired" });
        return;
    }
    entry.userId = userId;
    res.json({ ok: true });
});
exports.app.get("/desktop-auth", (_req, res) => {
    res.type("html").send(renderDesktopAuthPage());
});
function renderDesktopAuthPage() {
    const clerkPubKey = process.env.CLERK_PUBLISHABLE_KEY || "";
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zone Desktop — Sign In</title>
<script
  async
  crossorigin="anonymous"
  data-clerk-publishable-key="${clerkPubKey}"
  src="https://good-rattler-59.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
  type="text/javascript"
></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0e0e0e;color:#d4d4d4;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#111;border:1px solid #1e1e1e;border-radius:16px;padding:32px;max-width:460px;width:100%;text-align:center}
h1{font-size:20px;color:#fff;margin-bottom:8px}
.sub{font-size:13px;color:#737373;margin-bottom:24px;line-height:1.6}
.code-display{font-size:28px;font-weight:700;letter-spacing:.25em;color:#4ec9b0;background:#0e0e0e;border:2px dashed #1d6b3a;border-radius:12px;padding:16px;margin-bottom:20px}
.status{font-size:14px;color:#9cdcfe;margin-bottom:16px;min-height:24px}
.status.error{color:#f44747}
.status.success{color:#4ec9b0}
#clerk-mount{min-height:40px;margin-bottom:16px}
.step{font-size:12px;color:#555;margin-top:16px;line-height:1.6}
</style>
</head><body>
<div class="card">
<h1>⚡ Zone Desktop</h1>
<div class="sub">Sign in to connect your desktop app</div>
<div class="code-display" id="codeDisplay">------</div>
<div id="clerk-mount"></div>
<div class="status" id="statusText">Loading sign-in...</div>
<div class="step">This window can be closed after your desktop app shows "Signed in".</div>
</div>
<script>
const params = new URLSearchParams(window.location.search);
const code = (params.get('code') || '').toUpperCase();
document.getElementById('codeDisplay').textContent = code || '------';
const statusEl = document.getElementById('statusText');

async function completeAuth(userId) {
  statusEl.textContent = 'Linking account...';
  statusEl.className = 'status';
  try {
    const r = await fetch('/api/desktop-auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userId })
    });
    const data = await r.json();
    if (data.ok) {
      statusEl.textContent = '✓ Desktop app connected! You can close this window.';
      statusEl.className = 'status success';
    } else {
      statusEl.textContent = 'Code expired. Please try again from the desktop app.';
      statusEl.className = 'status error';
    }
  } catch {
    statusEl.textContent = 'Connection failed. Please try again.';
    statusEl.className = 'status error';
  }
}

async function waitForClerk() {
  for (let i = 0; i < 50; i++) {
    if (window.Clerk && window.Clerk.load) return window.Clerk;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Clerk failed to load');
}

(async function init() {
  if (!code) {
    statusEl.textContent = 'Missing code parameter';
    statusEl.className = 'status error';
    return;
  }
  try {
    const clerk = await waitForClerk();
    await clerk.load();

    if (clerk.user) {
      await completeAuth(clerk.user.id);
      return;
    }

    statusEl.textContent = 'Please sign in below';
    clerk.mountSignIn(document.getElementById('clerk-mount'));

    clerk.addListener(({ user }) => {
      if (user) completeAuth(user.id);
    });
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.className = 'status error';
  }
})();
</script>
</body></html>`;
}
exports.app.get("/api/check-access", async (req, res) => {
    if (shouldProxyHostedRequest(req, "/api/check-access")) {
        await proxyHostedZoneRequest(req, res, "/api/check-access", {
            onNotFound: () => handleCheckAccess(req, res),
        });
        return;
    }
    await handleCheckAccess(req, res);
});
exports.app.get("/api/billing-summary", async (req, res) => {
    if (shouldProxyHostedRequest(req, "/api/billing-summary")) {
        await proxyHostedZoneRequest(req, res, "/api/billing-summary", {
            onNotFound: () => handleBillingSummary(req, res),
        });
        return;
    }
    await handleBillingSummary(req, res);
});
exports.app.post("/api/admin/reset-monthly-runs", async (req, res) => {
    const adminSecret = typeof process.env.ADMIN_SECRET === "string"
        ? process.env.ADMIN_SECRET.trim()
        : "";
    const providedSecret = typeof req.get("x-admin-secret") === "string"
        ? req.get("x-admin-secret").trim()
        : "";
    if (!adminSecret || providedSecret !== adminSecret) {
        res.status(401).json({ ok: false, reason: "unauthorized" });
        return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
        res.status(500).json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    const rpcResult = await supabase.rpc("reset_monthly_runs");
    if (rpcResult.error) {
        res.status(500).json({
            ok: false,
            reason: rpcResult.error.message || "reset_monthly_runs_failed",
        });
        return;
    }
    res.json({ ok: true });
});
exports.app.post("/api/analyze", async (req, res) => {
    const { task, repoPath, userId: rawUserId } = req.body ?? {};
    const userId = typeof rawUserId === "string" && rawUserId.trim()
        ? rawUserId.trim()
        : process.env.NODE_ENV !== "production"
            ? "dev-user"
            : null;
    if (!userId) {
        res.status(401).json({
            ok: false,
            reason: "unauthorized",
            message: "Missing user session. Please open Zone from your dashboard.",
        });
        return;
    }
    const result = await (0, runAgent_js_1.runAgent)({ task, role: "developer" });
    res.json({
        decision: result.decision,
        risk: result.risk,
        confidence: result.confidence,
    });
});
exports.app.post("/api/dev/index-repo", async (req, res) => {
    const userApiKey = getHeaderUserApiKey(req);
    const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath.trim() : "";
    if (!repoPath) {
        res.status(400).json({ ok: false, reason: "repoPath is required" });
        return;
    }
    const startedAt = Date.now();
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        try {
            const repoFiles = await (0, scanRepo_js_1.scanRepo)(repoPath);
            const files = await Promise.all(repoFiles.map(async (file) => ({
                path: file.path,
                content: await (0, promises_1.readFile)(file.absolutePath, "utf8").catch(() => ""),
            })));
            const indexResult = await (0, indexRepository_js_1.indexRepoFiles)({
                repoPath,
                files: files.filter((file) => typeof file.content === "string" && file.content.length > 0),
            });
            res.json({
                ok: true,
                ...indexResult,
                elapsedMs: Date.now() - startedAt,
            });
        }
        catch (error) {
            res.status(500).json({
                ok: false,
                reason: error instanceof Error ? error.message : "repo_index_failed",
            });
        }
    });
});
exports.app.post("/api/patch/jobs", async (req, res) => {
    const { task, repoPath, userId, hostedContext, conversationId, billingMode } = req.body ?? {};
    if (!task || !repoPath) {
        res.status(400).json({ ok: false, reason: "task and repoPath are required" });
        return;
    }
    const authorization = await ensureRunAuthorized(userId, {
        billingMode,
    });
    if (!authorization.allowed) {
        res.status(authorization.status).json(authorization.body);
        return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
        res.status(500).json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    try {
        const requestPayload = await createDeveloperPatchJobPayload({
            task,
            repoPath,
            userId,
            conversationId,
            billingMode,
            hostedContext,
        });
        const job = await (0, developerPatchJobs_js_1.createDeveloperPatchJob)(supabase, {
            userId,
            task,
            repoPath,
            requestPayload,
        });
        res.json({
            ok: true,
            runId: job.id,
            status: job.status,
        });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "job_enqueue_failed",
        });
    }
});
exports.app.get("/api/patch/jobs/:runId", async (req, res) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
        res.status(500).json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    try {
        const job = await (0, developerPatchJobs_js_1.getDeveloperPatchJob)(supabase, req.params.runId);
        if (!job) {
            res.status(404).json({ ok: false, reason: "job_not_found" });
            return;
        }
        const decoded = (0, progressStageCodec_js_1.decodeProgressStage)(job.progress_stage);
        res.json({
            ok: true,
            runId: job.id,
            status: job.status,
            progressStage: decoded.displayStage,
            ...(decoded.lastLifecycle
                ? { lastLifecycleEvent: decoded.lastLifecycle }
                : {}),
            errorMessage: job.error_message,
        });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "job_lookup_failed",
        });
    }
});
exports.app.get("/api/patch/jobs/:runId/result", async (req, res) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
        res.status(500).json({ ok: false, reason: "profile_unavailable" });
        return;
    }
    try {
        const job = await (0, developerPatchJobs_js_1.getDeveloperPatchJob)(supabase, req.params.runId);
        if (!job) {
            res.status(404).json({ ok: false, reason: "job_not_found" });
            return;
        }
        if (job.status === "completed" && job.result_payload) {
            res.json(job.result_payload);
            return;
        }
        if (job.status === "failed") {
            res.json({
                ok: false,
                reason: "job_failed",
                runId: job.id,
                status: job.status,
                errorMessage: job.error_message,
            });
            return;
        }
        const decodedNotReady = (0, progressStageCodec_js_1.decodeProgressStage)(job.progress_stage);
        res.json({
            ok: false,
            reason: "job_not_ready",
            runId: job.id,
            status: job.status,
            progressStage: decodedNotReady.displayStage,
            ...(decodedNotReady.lastLifecycle
                ? { lastLifecycleEvent: decodedNotReady.lastLifecycle }
                : {}),
        });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "job_result_lookup_failed",
        });
    }
});
function shouldForceExecuteTask(task) {
    const agentLoopPatterns = [
        /run .*(test|spec|build|install)/i,
        /npm (test|run|install)/i,
        /yarn (test|run|add)/i,
        /pytest/i,
        /cargo (test|build|run)/i,
        /check if .*(test|build|work)/i,
        /tell me if .*(pass|fail|work)/i,
        /does .*(test|build) pass/i,
    ];
    return (agentLoopPatterns.some((re) => re.test(String(task || ""))) ||
        /\b(?:run|verify|install|build)\b/i.test(String(task || "")));
}
exports.app.post("/api/classify-intent", async (req, res) => {
    const task = typeof req.body?.task === "string" ? req.body.task : "";
    const normalizedTask = task.trim();
    const userApiKey = getHeaderUserApiKey(req);
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        const forcedExecute = shouldForceExecuteTask(normalizedTask);
        const messageType = forcedExecute
            ? "patch_request"
            : await (0, detectIntent_js_1.detectMessageType)(normalizedTask, userApiKey || undefined);
        const intent = messageType === "patch_request" ? "execute" : "chat";
        res.json({
            ok: true,
            intent,
            messageType,
        });
    });
});
exports.app.post("/api/chat", async (req, res) => {
    const perf = (0, zoneApiPerf_js_1.startZoneApiPerfRun)("/api/chat");
    // BYOK: extract user-supplied OpenAI API key from the custom request header.
    const chatUserApiKey = getHeaderUserApiKey(req);
    await (0, openaiContext_js_1.withUserApiKey)(chatUserApiKey || undefined, async () => {
        const { task, repoPath, runId, userId: rawUserId, conversationId, threadId, } = req.body ?? {};
        const userId = typeof rawUserId === "string" && rawUserId.trim()
            ? rawUserId.trim()
            : process.env.NODE_ENV !== "production"
                ? "dev-user"
                : null;
        const normalizedTask = typeof task === "string" ? task.trim() : "";
        const normalizedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
        const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";
        const threadIdStr = typeof threadId === "string" && threadId.trim()
            ? threadId.trim()
            : typeof conversationId === "string" && conversationId.trim()
                ? conversationId.trim()
                : runIdStr;
        if (!normalizedTask || !normalizedRepoPath || !runIdStr) {
            perf.finish("bad request");
            res.status(400).json({
                ok: false,
                reason: "task, repoPath, and runId are required",
            });
            return;
        }
        if (!userId) {
            perf.finish("missing user");
            res.status(401).json({
                ok: false,
                reason: "unauthorized",
                message: "Missing user session. Please open Zone from your dashboard.",
            });
            return;
        }
        const authorization = await ensureRunAuthorized(userId, { billingMode: "hosted" });
        if (!authorization.allowed) {
            perf.finish("authorization blocked");
            res.status(authorization.status).json(authorization.body);
            return;
        }
        const forcedExecute = shouldForceExecuteTask(normalizedTask);
        const messageType = forcedExecute
            ? "patch_request"
            : await (0, detectIntent_js_1.detectMessageType)(normalizedTask, chatUserApiKey || undefined);
        if (messageType === "patch_request") {
            perf.finish("wrong route");
            res.status(409).json({
                ok: false,
                reason: "patch_request_detected",
                message: "This request should be sent to /api/patch.",
                intent: "execute",
                messageType,
            });
            return;
        }
        const conversationalMessageType = messageType;
        (0, developerRunProgressSse_js_1.registerRunStart)(runIdStr, { task: normalizedTask });
        const chatAbort = new AbortController();
        activePatchRunAbortControllers.set(runIdStr, chatAbort);
        try {
            const result = await runConversationalFlow({
                task: normalizedTask,
                repoPath: normalizedRepoPath,
                runId: runIdStr,
                userId,
                conversationId: threadIdStr,
                messageType: conversationalMessageType,
                userApiKey: chatUserApiKey || undefined,
            });
            (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "completed");
            (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runIdStr, {
                stage: "run_completed_with_result",
                progress: {
                    runId: runIdStr,
                    ts: Date.now(),
                    type: "chat_response",
                    title: result.chatResponse,
                    status: "success",
                    result,
                },
            });
            perf.finish("complete");
            res.json(result);
        }
        catch (error) {
            (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "cancelled");
            perf.finish("error");
            res.status(500).json({
                ok: false,
                reason: error instanceof Error ? error.message : "chat_flow_failed",
            });
        }
        finally {
            activePatchRunAbortControllers.delete(runIdStr);
        }
    });
});
exports.app.post("/api/patch", async (req, res) => {
    const perf = (0, zoneApiPerf_js_1.startZoneApiPerfRun)("/api/patch");
    perf.mark("route entered");
    const patchHandlerStartedAt = Date.now();
    const billingMode = "hosted";
    // BYOK: extract user-supplied OpenAI API key from the custom request header.
    // This header is set by the browser when the user has configured their own key in Settings.
    // The key is NEVER logged — only the source ("user" vs "env") is recorded inside createOpenAIClient.
    const userApiKey = getHeaderUserApiKey(req);
    // When the user provides their own key, skip the hosted-proxy path and run locally with that key.
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/patch")) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = req.body?.hostedContext ??
            (typeof task === "string" && typeof repoPath === "string"
                ? await buildHostedDeveloperContext(task, repoPath)
                : undefined);
        perf.mark("hosted context ready");
        await proxyHostedZoneRequest(req, res, "/api/patch", {
            bodyOverride: hostedContext
                ? {
                    ...(req.body ?? {}),
                    hostedContext,
                }
                : req.body,
        });
        perf.finish("proxied response sent");
        return;
    }
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        const { task, repoPath, runId, userId: rawUserId, hostedContext: hostedContextFromBody, conversationId, lastChangedFiles, lastAddedFunctions, } = req.body ?? {};
        console.log("[debug-mem] received lastChangedFiles:", lastChangedFiles);
        const hostedContext = process.env.NODE_ENV === "production"
            ? hostedContextFromBody
            : hostedDeveloperContextRequestHasFiles(hostedContextFromBody)
                ? hostedContextFromBody
                : undefined;
        const userId = typeof rawUserId === "string" && rawUserId.trim()
            ? rawUserId.trim()
            : process.env.NODE_ENV !== "production"
                ? "dev-user"
                : null;
        perf.mark("request normalized");
        logger_js_1.logger.info("[patch-handler] received: threadId=%s, runId=%s, ts=%s", typeof conversationId === "string" && conversationId.trim()
            ? conversationId.trim()
            : typeof runId === "string" && runId.trim()
                ? runId.trim()
                : "", typeof runId === "string" && runId.trim() ? runId.trim() : "", new Date(patchHandlerStartedAt).toISOString());
        if (!task || !repoPath) {
            perf.finish("bad request");
            res.status(400).json({ ok: false, reason: "task and repoPath are required" });
            return;
        }
        if (!userId) {
            perf.finish("missing user");
            res.status(401).json({
                ok: false,
                reason: "unauthorized",
                message: "Missing user session. Please open Zone from your dashboard.",
            });
            return;
        }
        const authorization = await ensureRunAuthorized(userId, {
            billingMode,
        });
        perf.mark("authorization complete");
        if (!authorization.allowed) {
            perf.finish("authorization blocked");
            res.status(authorization.status).json(authorization.body);
            return;
        }
        if (task === "__log_only__") {
            perf.finish("log-only request ignored");
            res.json({
                ok: true,
                reason: "log_only_noop",
                patchPreview: "[LOG_ONLY] Bookkeeping request ignored. Existing patch result remains authoritative.",
                warnings: [
                    "[LOG_ONLY] Bookkeeping request ignored. Existing patch result remains authoritative.",
                ],
                developerConfidence: 0,
                decisionMode: "blocked",
                finalState: "blocked",
                finalExecutionOutcome: "completed_with_issues",
                validationBlocked: true,
                applyPatches: [],
                patchResults: [],
                fileDiffs: [],
                contextFiles: [],
            });
            return;
        }
        const agentLoopPatterns = [
            /run .*(test|spec|build|install)/i,
            /npm (test|run|install)/i,
            /yarn (test|run|add)/i,
            /pytest/i,
            /cargo (test|build|run)/i,
            /check if .*(test|build|work)/i,
            /tell me if .*(pass|fail|work)/i,
            /does .*(test|build) pass/i,
        ];
        // Do not use bare \btest\b here — it false-positives on normal tasks ("latest", "contest", etc.).
        // Test-related execution is still covered by agentLoopPatterns (npm test, run tests, …).
        const shouldForceExecute = shouldForceExecuteTask(String(task || ""));
        const intent = shouldForceExecute
            ? "execute"
            : await (0, detectIntent_js_1.detectIntent)(String(task), userApiKey || undefined);
        if (intent === "chat") {
            try {
                emitProgress(runId, {
                    stage: "chat_response",
                    progress: {
                        type: "chat_start",
                        title: "Thinking...",
                        runId: String(runId || ""),
                        ts: Date.now(),
                        status: "active",
                    },
                });
            }
            catch { }
            const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";
            const messageType = await (0, detectIntent_js_1.detectMessageType)(String(task), userApiKey || undefined);
            const conversationalMessageType = messageType === "discussion" ? "discussion" : "question";
            try {
                if (runIdStr) {
                    (0, developerRunProgressSse_js_1.registerRunStart)(runIdStr, { task: String(task) });
                }
                const result = await runConversationalFlow({
                    task: String(task),
                    repoPath: String(repoPath),
                    runId: runIdStr,
                    userId,
                    conversationId: typeof conversationId === "string" && conversationId.trim()
                        ? conversationId.trim()
                        : runIdStr,
                    messageType: conversationalMessageType,
                });
                if (runIdStr) {
                    (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "completed");
                    (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runIdStr, {
                        stage: "run_completed_with_result",
                        progress: {
                            runId: runIdStr,
                            ts: Date.now(),
                            type: "chat_response",
                            title: result.chatResponse,
                            status: "success",
                            result,
                        },
                    });
                }
                perf.finish("chat response sent");
                res.json(result);
                return;
            }
            catch (error) {
                if (runIdStr) {
                    (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "cancelled");
                }
                perf.finish("chat response failed");
                res.status(500).json({
                    ok: false,
                    reason: error instanceof Error ? error.message : "chat_flow_failed",
                });
                return;
            }
        }
        const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";
        const threadIdForRun = typeof conversationId === "string" && conversationId.trim()
            ? conversationId.trim()
            : runIdStr;
        try {
            const existingRuns = await (0, activeRunsRepository_js_1.getActiveRunsByUser)(userId);
            const existingRun = existingRuns.find((run) => run.runId !== runIdStr &&
                run.threadId === threadIdForRun &&
                (run.status === "running" || run.status === "interrupted"));
            logger_js_1.logger.info("[patch-handler] active-run check: existingRunId=%s, blocked=%s, threadId=%s", existingRun?.runId ?? "", "false", threadIdForRun);
        }
        catch (error) {
            logger_js_1.logger.info("[patch-handler] active-run check: existingRunId=%s, blocked=%s, threadId=%s", "", "false", threadIdForRun);
            console.warn("[zone] active run diagnostic lookup failed", error instanceof Error ? error.message : String(error));
        }
        let patchAbort = null;
        if (runIdStr) {
            patchAbort = new AbortController();
            activePatchRunAbortControllers.set(runIdStr, patchAbort);
            try {
                (0, developerRunProgressSse_js_1.registerRunStart)(runIdStr, { task: typeof task === "string" ? task : undefined });
            }
            catch { }
            try {
                await (0, activeRunsRepository_js_1.upsertActiveRun)(runIdStr, {
                    userId,
                    threadId: threadIdForRun,
                    conversationId: typeof conversationId === "string" && conversationId.trim()
                        ? conversationId.trim()
                        : runIdStr,
                    repoPath: String(repoPath),
                    task: String(task),
                    status: "running",
                    lastChangedFiles: Array.isArray(lastChangedFiles)
                        ? lastChangedFiles
                        : null,
                    lastAddedFunctions: Array.isArray(lastAddedFunctions)
                        ? lastAddedFunctions
                        : null,
                });
                console.log("[resume-debug] upsertActiveRun running", {
                    runId: runIdStr,
                    userId,
                    threadId: threadIdForRun,
                    repoPath: String(repoPath),
                    task: String(task),
                });
            }
            catch (error) {
                console.warn("[zone] active run upsert failed", error instanceof Error ? error.message : String(error));
            }
        }
        try {
            logger_js_1.logger.info("[patch-handler] reached planner, ms since entry=%d", Date.now() - patchHandlerStartedAt);
            const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({
                task,
                repoPath,
                conversationId,
                userId,
                lastChangedFiles: Array.isArray(lastChangedFiles) ? lastChangedFiles : undefined,
                lastAddedFunctions: Array.isArray(lastAddedFunctions) ? lastAddedFunctions : undefined,
                hostedContext,
                runId: typeof runId === "string" ? runId : undefined,
                perfLabel: "/api/patch core",
                onProgress: (update) => emitProgress(runId, update),
                abortSignal: patchAbort?.signal,
                userApiKey: userApiKey || undefined,
            });
            perf.mark("core patch flow complete");
            // Best-effort: extract newly added function names from added diff lines.
            try {
                const diffs = Array.isArray(result.fileDiffs)
                    ? (result.fileDiffs || [])
                    : [];
                const addedLines = [];
                for (const fd of diffs) {
                    const lines = Array.isArray(fd?.diff) ? fd.diff : [];
                    for (const l of lines) {
                        if (l && l.type === "added" && typeof l.content === "string") {
                            addedLines.push(l.content);
                        }
                    }
                }
                const names = new Set();
                const patterns = [
                    /^\s*export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
                    /^\s*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
                    /^\s*async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
                    /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/,
                    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
                    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/,
                ];
                for (const line of addedLines) {
                    const s = String(line || "");
                    for (const re of patterns) {
                        const m = s.match(re);
                        if (m?.[1]) {
                            names.add(m[1]);
                            break;
                        }
                    }
                }
                result.addedFunctions = Array.from(names).slice(0, 10);
            }
            catch { }
            if (result.ok && result.applyPatches.length > 0) {
                const validation = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", result.applyPatches.map((p) => ({
                    filePath: p.filePath,
                    content: p.fullContent,
                })));
                perf.mark("output validation complete");
                if (validation.verdict === "block") {
                    perf.finish("validation blocked");
                    try {
                        if (runIdStr) {
                            await (0, activeRunsRepository_js_1.completeActiveRun)(runIdStr, "cancelled");
                        }
                    }
                    catch (error) {
                        console.warn("[zone] active run validation cleanup failed", error instanceof Error ? error.message : String(error));
                    }
                    res.status(422).json({
                        ok: false,
                        reason: "Output validation failed — patch blocked.",
                        validationIssues: validation.issues,
                    });
                    return;
                }
                if (validation.issues.length > 0) {
                    result.validationIssues = validation.issues;
                    result.validationVerdict = validation.verdict;
                }
            }
            if (result.ok) {
                const confidence = typeof result.developerConfidence === "number"
                    ? result.developerConfidence
                    : 0;
                console.log("[zone-billing-debug] execution success reached", {
                    routeName: "/api/patch",
                    userId: typeof userId === "string" ? userId.trim() : null,
                    billingMode: billingMode ?? null,
                });
                const loggedConversationId = await (0, runLogging_js_1.logRun)({
                    userId,
                    role: "developer",
                    task,
                    repoPath,
                    decisionMode: result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
                    confidence,
                    executionId: typeof runId === "string" ? runId : undefined,
                    creditsUsed: 1,
                    conversationId,
                    changedFiles: Array.isArray(result.applyPatches)
                        ? (result.applyPatches || [])
                            .map((p) => String(p?.filePath ?? "").trim())
                            .filter(Boolean)
                        : Array.isArray(result.fileDiffs)
                            ? (result.fileDiffs || [])
                                .map((d) => String(d?.filePath ?? "").trim())
                                .filter(Boolean)
                            : [],
                    billingMode,
                    routeName: "/api/patch",
                }).catch(() => null);
                if (loggedConversationId) {
                    result.conversationId = loggedConversationId;
                }
                perf.mark("successful accounting complete");
            }
            perf.mark("response ready");
            perf.finish("complete");
            logger_js_1.logger.info("[patch-handler] dispatched runId=%s, total ms=%d", runIdStr, Date.now() - patchHandlerStartedAt);
            try {
                if (runIdStr)
                    (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "completed");
            }
            catch { }
            try {
                if (runIdStr) {
                    await (0, activeRunsRepository_js_1.completeActiveRun)(runIdStr, "completed");
                }
            }
            catch (error) {
                console.warn("[zone] active run complete failed", error instanceof Error ? error.message : String(error));
            }
            // After refresh, the original HTTP response is orphaned. Emit the final result via SSE too.
            try {
                if (runIdStr) {
                    (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runIdStr, {
                        stage: "run_completed_with_result",
                        progress: {
                            runId: runIdStr,
                            ts: Date.now(),
                            type: "run_completed_with_result",
                            title: "Run completed",
                            status: "success",
                            result,
                        },
                    });
                }
            }
            catch { }
            res.json(result);
        }
        catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                perf.finish("cancelled");
                try {
                    if (runIdStr)
                        (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "cancelled");
                }
                catch { }
                try {
                    if (runIdStr) {
                        await (0, activeRunsRepository_js_1.completeActiveRun)(runIdStr, "cancelled");
                    }
                }
                catch (error) {
                    console.warn("[zone] active run cancel failed", error instanceof Error ? error.message : String(error));
                }
                const payload = {
                    ok: false,
                    cancelled: true,
                    reason: "cancelled",
                    message: "Run was cancelled.",
                    applyPatches: [],
                    fileDiffs: [],
                    decisionMode: "preview_only",
                    developerConfidence: 0,
                };
                try {
                    if (runIdStr) {
                        (0, developerRunProgressSse_js_1.emitDeveloperPatchProgress)(runIdStr, {
                            stage: "run_completed_with_result",
                            progress: {
                                runId: runIdStr,
                                ts: Date.now(),
                                type: "run_completed_with_result",
                                title: "Run cancelled",
                                status: "warning",
                                result: payload,
                            },
                        });
                    }
                }
                catch { }
                res.json(payload);
                return;
            }
            perf.finish("error");
            try {
                if (runIdStr)
                    (0, developerRunProgressSse_js_1.registerRunComplete)(runIdStr, "cancelled");
            }
            catch { }
            try {
                if (runIdStr) {
                    await (0, activeRunsRepository_js_1.completeActiveRun)(runIdStr, "cancelled");
                }
            }
            catch (error) {
                console.warn("[zone] active run error cleanup failed", error instanceof Error ? error.message : String(error));
            }
            res.status(500).json({
                ok: false,
                reason: err instanceof Error ? err.message : "patch_flow_failed",
            });
        }
        finally {
            if (runIdStr) {
                activePatchRunAbortControllers.delete(runIdStr);
            }
        }
    });
});
exports.app.post("/api/dry-run", async (req, res) => {
    const billingMode = "hosted";
    const userApiKey = getHeaderUserApiKey(req);
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/dry-run")) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = req.body?.hostedContext ??
            (typeof task === "string" && typeof repoPath === "string"
                ? await buildHostedDeveloperContext(task, repoPath)
                : undefined);
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
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        const { task, repoPath, runId, userId: rawUserId, hostedContext: hostedContextFromBodyDry, conversationId, } = req.body ?? {};
        const hostedContext = process.env.NODE_ENV === "production"
            ? hostedContextFromBodyDry
            : hostedDeveloperContextRequestHasFiles(hostedContextFromBodyDry)
                ? hostedContextFromBodyDry
                : undefined;
        const userId = typeof rawUserId === "string" && rawUserId.trim()
            ? rawUserId.trim()
            : process.env.NODE_ENV !== "production"
                ? "dev-user"
                : null;
        if (!userId) {
            res.status(401).json({
                ok: false,
                reason: "unauthorized",
                message: "Missing user session. Please open Zone from your dashboard.",
            });
            return;
        }
        const authorization = await ensureRunAuthorized(userId, {
            billingMode,
        });
        if (!authorization.allowed) {
            res.status(authorization.status).json(authorization.body);
            return;
        }
        const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({
            task,
            repoPath,
            dryRun: true,
            hostedContext,
            runId: typeof runId === "string" ? runId : undefined,
            onProgress: (update) => emitProgress(runId, update),
            userApiKey: userApiKey || undefined,
        });
        if (!result.ok) {
            res.status(500).json(result);
            return;
        }
        if (result.applyPatches.length > 0) {
            const validation = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", result.applyPatches.map((p) => ({
                filePath: p.filePath,
                content: p.fullContent,
            })));
            if (validation.verdict === "block") {
                res.status(422).json({
                    ok: false,
                    reason: "Output validation failed — patch blocked.",
                    validationIssues: validation.issues,
                });
                return;
            }
            if (validation.issues.length > 0) {
                result.validationIssues = validation.issues;
                result.validationVerdict = validation.verdict;
            }
        }
        const responseBody = {
            ok: true,
            fileDiffs: result.fileDiffs ?? [],
            patchPreview: result.patchPreview,
            warnings: result.warnings,
            patchResults: result.patchResults,
        };
        const confidence = typeof result.developerConfidence === "number"
            ? result.developerConfidence
            : 0;
        console.log("[zone-billing-debug] execution success reached", {
            routeName: "/api/dry-run",
            userId: typeof userId === "string" ? userId.trim() : null,
            billingMode: billingMode ?? null,
        });
        const loggedConversationId = await (0, runLogging_js_1.logRun)({
            userId,
            role: "developer",
            task,
            repoPath,
            decisionMode: result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
            confidence,
            executionId: typeof runId === "string" ? runId : undefined,
            creditsUsed: 1,
            conversationId,
            billingMode,
            routeName: "/api/dry-run",
        }).catch(() => null);
        if (loggedConversationId) {
            responseBody.conversationId = loggedConversationId;
        }
        res.json(responseBody);
    });
});
function getVerificationLabel(command) {
    return command === "npm run build" ? "Run build" : "Run tests";
}
async function buildSuggestedVerification(repoPath, options) {
    try {
        const repoFiles = (await (0, scanRepo_js_1.scanRepo)(repoPath)).map((file) => file.path);
        const command = (0, detectVerificationCommand_js_1.detectVerificationCommand)({ repoPath, repoFiles });
        return command
            ? {
                available: true,
                command: command.command,
                label: getVerificationLabel(command.command),
                ...(options?.includeRepoPath ? { repoPath } : {}),
            }
            : { available: false };
    }
    catch {
        return { available: false };
    }
}
exports.app.post("/api/apply", async (req, res) => {
    const { patches, repoPath } = req.body;
    console.log("[zone-apply-input]", {
        repoPath,
        patchCount: Array.isArray(patches) ? patches.length : null,
    });
    try {
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)(patches, repoPath);
        let suggestedVerification = { available: false };
        if (result.applied.length > 0 && typeof repoPath === "string") {
            suggestedVerification = await buildSuggestedVerification(repoPath);
            console.log(`[zone-verify-suggest] command="${suggestedVerification.command ?? ""}" available=${suggestedVerification.available}`);
        }
        const responseBody = {
            ...result,
            suggestedVerification,
        };
        console.log(`[zone-apply] suggestedVerification available=${suggestedVerification.available} command="${suggestedVerification.command ?? ""}"`);
        res.json(responseBody);
    }
    catch (err) {
        console.log("[zone-apply-error]", err?.message, err?.code, String(err?.stack || "").slice(0, 300));
        res.status(500).json({ ok: false, reason: "apply_failed" });
    }
});
exports.app.post("/api/suggest-verification", async (req, res) => {
    const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath : "";
    if (!repoPath) {
        res.status(400).json({
            ok: false,
            reason: "repoPath_required",
        });
        return;
    }
    const suggestedVerification = await buildSuggestedVerification(repoPath, {
        includeRepoPath: true,
    });
    console.log(`[zone-verify-suggest] command="${suggestedVerification.command ?? ""}" available=${suggestedVerification.available}`);
    res.json({ ok: true, suggestedVerification });
});
exports.app.post("/api/run-verification", async (req, res) => {
    const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath : "";
    const requestedCommand = typeof req.body?.command === "string" ? req.body.command.trim() : "";
    if (!repoPath || !requestedCommand) {
        res.status(400).json({
            ok: false,
            reason: "repoPath_and_command_required",
        });
        return;
    }
    try {
        const repoFiles = (await (0, scanRepo_js_1.scanRepo)(repoPath)).map((file) => file.path);
        const detectedCommand = (0, detectVerificationCommand_js_1.detectVerificationCommand)({ repoPath, repoFiles });
        if (!detectedCommand || detectedCommand.command !== requestedCommand) {
            res.status(403).json({
                ok: false,
                reason: "verification_command_not_allowed",
            });
            return;
        }
        const verification = await (0, runRuntimeVerification_js_1.runRuntimeVerification)({
            repoPath,
            command: detectedCommand,
        });
        console.log(`[zone-verify-run] command="${detectedCommand.command}" status=${verification.status}`);
        res.json({ ok: true, verification });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            reason: err instanceof Error ? err.message : "verification_failed",
        });
    }
});
exports.app.post("/api/refine-prompt", async (req, res) => {
    const billingMode = "hosted";
    const userApiKey = getHeaderUserApiKey(req);
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/refine-prompt")) {
        await proxyHostedZoneRequest(req, res, "/api/refine-prompt");
        return;
    }
    const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
    if (!task) {
        res.status(400).json({ ok: false, reason: "task_required" });
        return;
    }
    const role = typeof req.body?.role === "string" ? req.body.role : undefined;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const relevantFiles = Array.isArray(req.body?.relevantFiles)
        ? req.body.relevantFiles.filter((file) => typeof file === "string")
        : undefined;
    const plan = req.body?.plan && typeof req.body.plan === "object"
        ? req.body.plan
        : undefined;
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        try {
            const refinedPrompt = await (0, refinePrompt_js_1.refinePrompt)({
                task,
                role,
                reason,
                relevantFiles,
                plan,
            });
            console.log(`[zone-refine] prompt refined role=${role || "developer"} reason=${reason || "unspecified"}`);
            res.json({ ok: true, refinedPrompt });
        }
        catch {
            res.json({ ok: true, refinedPrompt: refinePrompt_js_1.PROMPT_REFINEMENT_FALLBACK });
        }
    });
});
exports.app.post("/api/enhance-task", async (req, res) => {
    const billingMode = "hosted";
    const userApiKey = getHeaderUserApiKey(req);
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/enhance-task")) {
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
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        try {
            const result = await enhanceTask({
                task,
                role,
                repoPath,
                hostedContext,
                userApiKey: userApiKey || undefined,
            });
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
});
exports.app.post("/api/test-engineer", async (req, res) => {
    const billingMode = "hosted";
    const userApiKey = getHeaderUserApiKey(req);
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/test-engineer")) {
        const { task, repoPath } = req.body ?? {};
        const hostedContext = req.body?.hostedContext ??
            (typeof task === "string" && typeof repoPath === "string"
                ? await buildHostedTestEngineerContext(task, repoPath)
                : undefined);
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
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        const { task, repoPath, runId, userId, hostedContext, conversationId } = req.body;
        if (!task || !repoPath) {
            res.status(400).json({ ok: false, reason: "task and repoPath are required" });
            return;
        }
        const authorization = await ensureRunAuthorized(userId, {
            billingMode,
        });
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
            // 1. ÖNCE reason mapping (!ok ise)
            if (!result.ok && typeof result.reason === "string") {
                result.reason = getTestEngineerUserFacingReason(result.reason);
            }
            // 2. SONRA validation (ok ise)
            if (result.ok && result.applyPatches) {
                const validation = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", result.applyPatches.map((p) => ({
                    filePath: p.filePath,
                    content: p.fullContent,
                })));
                if (validation.verdict === "block") {
                    res.status(422).json({
                        ok: false,
                        reason: "Output validation failed — patch blocked.",
                        validationIssues: validation.issues,
                    });
                    return;
                }
                if (validation.issues.length > 0) {
                    result.validationIssues = validation.issues;
                }
            }
            if (result.ok) {
                const normalizedUserId = typeof userId === "string" ? userId.trim() : null;
                console.log("[zone-billing-debug] execution success reached", {
                    routeName: "/api/test-engineer",
                    userId: normalizedUserId,
                    billingMode: billingMode ?? null,
                });
                const loggedConversationId = await (0, runLogging_js_1.logRun)({
                    userId,
                    role: "test_engineer",
                    task,
                    repoPath,
                    decisionMode: getDecisionModeFromResult(result, result.confidence),
                    confidence: result.confidence,
                    executionId: typeof runId === "string" ? runId : undefined,
                    creditsUsed: 1,
                    conversationId,
                    billingMode,
                    routeName: "/api/test-engineer",
                }).catch(() => null);
                if (loggedConversationId) {
                    result.conversationId = loggedConversationId;
                }
            }
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
});
exports.app.post("/api/data-analyst", async (req, res) => {
    const billingMode = "hosted";
    const userApiKey = getHeaderUserApiKey(req);
    if (!userApiKey && shouldProxyHostedRequest(req, "/api/data-analyst")) {
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
    await (0, openaiContext_js_1.withUserApiKey)(userApiKey || undefined, async () => {
        const { task, repoPath, runId, userId, hostedContext, conversationId } = req.body;
        if (!task || !repoPath) {
            res.status(400).json({ ok: false, reason: "task and repoPath are required" });
            return;
        }
        const authorization = await ensureRunAuthorized(userId, {
            billingMode,
        });
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
            if (result.ok && result.applyPatches) {
                const validation = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", result.applyPatches.map((p) => ({
                    filePath: p.filePath,
                    content: p.fullContent,
                })));
                if (validation.verdict === "block") {
                    res.status(422).json({
                        ok: false,
                        reason: "Output validation failed — patch blocked.",
                        validationIssues: validation.issues,
                    });
                    return;
                }
                if (validation.issues.length > 0) {
                    result.validationIssues = validation.issues;
                    result.validationVerdict = validation.verdict;
                }
            }
            if (!result.ok && typeof result.reason === "string") {
                result.reason = getDataAnalystUserFacingReason(result.reason);
            }
            if (result.ok) {
                const normalizedUserId = typeof userId === "string" ? userId.trim() : null;
                console.log("[zone-billing-debug] execution success reached", {
                    routeName: "/api/data-analyst",
                    userId: normalizedUserId,
                    billingMode: billingMode ?? null,
                });
                const loggedConversationId = await (0, runLogging_js_1.logRun)({
                    userId,
                    role: "data_analyst",
                    task,
                    repoPath,
                    decisionMode: getDecisionModeFromResult(result, result.confidence),
                    confidence: result.confidence,
                    executionId: typeof runId === "string" ? runId : undefined,
                    creditsUsed: 1,
                    conversationId,
                    billingMode,
                    routeName: "/api/data-analyst",
                }).catch(() => null);
                if (loggedConversationId) {
                    result.conversationId = loggedConversationId;
                }
            }
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
});
exports.app.use(express_1.default.static(zoneUiDir));
async function startServer(port = 3000) {
    if (startPromise) {
        return startPromise;
    }
    startedPort = port;
    logStartupDiagnostics();
    startPromise = new Promise((resolve) => {
        exports.app.listen(port, () => {
            console.log((0, colors_js_1.colorize)(`Zone UI running on http://localhost:${port}`, "\x1b[32m", "\x1b[1m"));
            console.log((0, colors_js_1.colorize)("Press Ctrl+C to stop", "\x1b[2m", "\x1b[90m"));
            resolve();
        });
    });
    await startPromise;
}
if (process.env.VITEST !== "true" &&
    process.env.ZONE_SERVER_MANUAL_START !== "1") {
    void startServer(startedPort ?? Number(port));
}
//# sourceMappingURL=server.js.map