import crypto from "node:crypto";
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runAgent } from "../core/runAgent.js";
import {
  isIrrelevantDeveloperContextPath,
  runLlmPatchFlow,
} from "../core/runLlmPatchFlow.js";
import { parseTaskIntent } from "../core/taskIntentParser.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import { detectVerificationCommand } from "../core/detectVerificationCommand.js";
import { runRuntimeVerification } from "../core/runRuntimeVerification.js";
import {
  readExampleContents,
  readFeatureExampleContents,
  runTestEngineerFlow,
} from "../roles/runTestEngineerFlow.js";
import { detectTestFramework } from "../roles/detectTestFramework.js";
import { buildTestEngineerContext } from "../roles/testEngineerContext.js";
import { runDataAnalystFlow } from "../roles/runDataAnalystFlow.js";
import {
  detectDataSchema,
  type DetectedDataSchema,
} from "../roles/detectDataSchema.js";
import { buildDataAnalystContext } from "../roles/dataAnalystContext.js";
import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import {
  createOpenAIClient,
  getHostedInferenceBaseUrl,
  getInferenceMode,
  getModelName,
} from "../llm/openaiClient.js";
import {
  PROMPT_REFINEMENT_FALLBACK,
  refinePrompt,
} from "../llm/refinePrompt.js";
import { getUserQuota } from "../billing/conversationRepository.js";
import { resolveBillingAction } from "../billing/resolveBillingAction.js";
import { c, colorize } from "../cli/colors.js";
import type {
  AgentLifecycleEvent,
  ZoneStructuredProgressEvent,
} from "../core/agentLifecycleEvents.js";
import {
  attachDeveloperPatchProgressSseClient,
  detachDeveloperPatchProgressSseClient,
  emitDeveloperPatchProgress,
} from "../core/developerRunProgressSse.js";
import { decodeProgressStage } from "../core/progressStageCodec.js";
import { validateLlmOutput } from "../core/validateLlmOutput.js";
import lemonWebhookRouter from "../routes/lemonsqueezyWebhook.js";
import createLemonCheckoutRouter from "../routes/createLemonCheckout.js";
import customerPortalRouter from "../routes/getLemonCustomerPortal.js";
import { logRun } from "./runLogging.js";
import { startZoneApiPerfRun } from "./zoneApiPerf.js";
import {
  createDeveloperPatchJob,
  getDeveloperPatchJob,
  type DeveloperPatchJobRequestPayload,
} from "../jobs/developerPatchJobs.js";
export const app = express();
const port = Number(process.env.PORT) || 3000;
let startedPort: number | null = null;
let startPromise: Promise<void> | null = null;
const zoneUiDir = path.resolve(__dirname, "../ui");
const zoneUiHtmlTemplate = readFileSync(path.join(zoneUiDir, "index.html"), "utf8");
const ENHANCE_TASK_SYSTEM_PROMPT =
  "You are a task optimizer for an AI code agent called Zone.\n" +
  "The user has written a vague or incomplete task description.\n" +
  "Rewrite it as a precise, actionable task that includes:\n" +
  "- The specific file or component to modify (if inferable from repo)\n" +
  "- The exact behavior or test scenario\n" +
  "- The framework/pattern already used in the repo\n" +
  "Keep it under 2 sentences. Return only the optimized task text, nothing else.";

const FREE_PLAN_RUN_LIMIT = 10;
const PRO_PLAN_RUN_LIMIT = 250;

type HostedDeveloperContextPayload = {
  repoSummary: string;
  projectNotes?: string[];
  existingFilesSummary: string;
  availableFiles: Array<{
    path: string;
    category: string;
    extension: string;
  }>;
  contextFiles: Array<{
    path: string;
    action: string;
    reason: string;
    content: string;
  }>;
  originalContents: Record<string, string>;
};

type HostedEnhanceContextPayload = {
  contextFiles: Array<{
    path: string;
    content: string;
  }>;
};

type HostedTestEngineerContextPayload = {
  availableFiles: Array<{
    path: string;
    category: "frontend" | "backend" | "shared" | "unknown";
    extension: string;
  }>;
  pageObjectContents: Array<{ path: string; content: string }>;
  stepDefinitionContents: Array<{ path: string; content: string }>;
  featureContents: Array<{ path: string; content: string }>;
  existingTestContents: Array<{ path: string; content: string }>;
  appSourceContents?: Array<{ path: string; content: string }>;
};

type HostedDataAnalystContextPayload = {
  availableFiles: Array<{
    path: string;
    category: "frontend" | "backend" | "shared" | "unknown";
    extension: string;
  }>;
  schema: DetectedDataSchema;
  existingSqlContents: Array<{ path: string; content: string }>;
};

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
    ],
    exposedHeaders: ["Content-Length", "X-Request-Id"],
  })
);
app.set('trust proxy', 1);
app.use(
  "/api/lemonsqueezy/webhook",
  express.raw({ type: "application/json" }),
  lemonWebhookRouter
);
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api/lemonsqueezy/create-checkout", createLemonCheckoutRouter);
app.use("/api/lemonsqueezy/customer-portal", customerPortalRouter);

const developerRouteLimiter = rateLimit({
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

app.use("/api/analyze", developerRouteLimiter);
app.use("/api/patch", developerRouteLimiter);
app.use("/api/dry-run", developerRouteLimiter);

app.get("/", (_req, res) => {
  res.type("html").send(renderZoneUiHtml());
});

app.get("/index.html", (_req, res) => {
  res.type("html").send(renderZoneUiHtml());
});

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function renderZoneUiHtml(): string {
  const currentUserId =
    typeof process.env.ZONE_USER_ID === "string"
      ? process.env.ZONE_USER_ID.trim()
      : "";
  const currentUserEmail =
    typeof process.env.ZONE_USER_EMAIL === "string"
      ? process.env.ZONE_USER_EMAIL.trim()
      : "";
  const debugFallbackUserId =
    typeof process.env.ZONE_DEBUG_FALLBACK_USER_ID === "string"
      ? process.env.ZONE_DEBUG_FALLBACK_USER_ID.trim()
      : "";
  const zoneApiBaseUrl =
    typeof process.env.ZONE_API_BASE_URL === "string"
      ? process.env.ZONE_API_BASE_URL.trim()
      : "";
  const currentUser = currentUserId
    ? {
        id: currentUserId,
        ...(currentUserEmail ? { email: currentUserEmail } : {}),
      }
    : null;
  const configScript = `<script>window.__ZONE_PUBLIC_CONFIG__=${JSON.stringify({
    posthogKey:
      typeof process.env.POSTHOG_KEY === "string"
        ? process.env.POSTHOG_KEY.trim()
        : "",
    posthogHost:
      typeof process.env.POSTHOG_HOST === "string"
        ? process.env.POSTHOG_HOST.trim()
        : "",
    currentUser,
    debugFallbackUserId,
    zoneApiBaseUrl,
  })};window.currentUser=window.currentUser||${JSON.stringify(currentUser)};</script>`;
  return zoneUiHtmlTemplate.replace("</head>", `${configScript}</head>`);
}

function shouldUseHostedInferenceProxy(): boolean {
  return getInferenceMode() === "hosted";
}

function maskApiKeyPrefix(value?: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, 7) : "none";
}

function getRequestOrigin(req: express.Request): string {
  const forwardedProto = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const proto = (forwardedProto || req.protocol || "http").split(",")[0].trim();
  const host = (forwardedHost || req.get("host") || "").split(",")[0].trim();
  return host ? `${proto}://${host}`.toLowerCase() : "";
}

function shouldProxyHostedRequest(
  req: express.Request,
  routePath: string
): boolean {
  if (!shouldUseHostedInferenceProxy()) {
    return false;
  }

  let targetOrigin = "";
  try {
    targetOrigin = new URL(getHostedInferenceBaseUrl()).origin.toLowerCase();
  } catch {
    console.warn(
      `[zone] hosted proxy bypass: invalid hosted base URL for ${routePath}`
    );
    return false;
  }
  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin && requestOrigin === targetOrigin) {
    console.warn(
      `[zone] self-proxy bypass: ${routePath} target ${targetOrigin} matches current request origin`
    );
    return false;
  }

  return true;
}

function logStartupDiagnostics(): void {
  const mode = getInferenceMode();
  console.log(`[zone] inference mode: ${mode}`);

  if (mode === "hosted") {
    const hostedBaseUrl = getHostedInferenceBaseUrl();
    console.log(`[zone] hosted inference base URL: ${hostedBaseUrl}`);
    if (hostedBaseUrl === "https://zonecli.dev") {
      console.warn(
        "[zone] Warning: default hosted target https://zonecli.dev must serve the real Zone product API routes for full hosted role support."
      );
    }
    return;
  }

  const hasOpenAiKey =
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.trim().length > 0;
  console.log(
    `[zone] local inference OPENAI_API_KEY: ${hasOpenAiKey ? "present" : "missing"}`
  );

  const explicitMode = (process.env.ZONE_INFERENCE_MODE || "")
    .trim()
    .toLowerCase();
  if (explicitMode === "local" && !hasOpenAiKey) {
    console.warn(
      "[zone] Warning: ZONE_INFERENCE_MODE=local requires OPENAI_API_KEY for local inference."
    );
  }
}

async function proxyHostedZoneRequest(
  req: express.Request,
  res: express.Response,
  routePath: string,
  options?: {
    onNotFound?: () => Promise<void> | void;
    bodyOverride?: unknown;
  }
): Promise<void> {
  const baseUrl = getHostedInferenceBaseUrl();
  const targetUrl = new URL(routePath, `${baseUrl}/`);
  const forwardedUserId =
    typeof req.body?.userId === "string"
      ? req.body.userId.trim()
      : typeof req.query.userId === "string"
        ? req.query.userId.trim()
        : "";
  const forwardedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-zone-client": "local-ui",
  };

  if (typeof req.headers.authorization === "string" && req.headers.authorization) {
    forwardedHeaders.authorization = req.headers.authorization;
  }

  if (typeof req.headers.cookie === "string" && req.headers.cookie) {
    forwardedHeaders.cookie = req.headers.cookie;
  }

  if (
    typeof req.headers["x-user-openai-key"] === "string" &&
    req.headers["x-user-openai-key"].trim()
  ) {
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
      body:
        req.method === "GET"
          ? undefined
          : JSON.stringify(options?.bodyOverride ?? req.body ?? {}),
    });

    if (response.status === 404 && options?.onNotFound) {
      await options.onNotFound();
      return;
    }

    const responseText = await response.text();
    const contentType =
      response.headers.get("content-type") ?? "application/json; charset=utf-8";

    res.status(response.status);
    res.setHeader("Content-Type", contentType);
    res.send(responseText);
  } catch (error) {
    res.status(502).json({
      ok: false,
      reason: "hosted_inference_unavailable",
      message:
        error instanceof Error
          ? `Zone hosted inference is unavailable: ${error.message}`
          : "Zone hosted inference is unavailable.",
    });
  }
}

async function buildHostedDeveloperContext(
  task: string,
  repoPath: string
): Promise<HostedDeveloperContextPayload> {
  const allFiles = await scanRepo(repoPath);
  const developerContextFiles = allFiles.filter(
    (file) => !isIrrelevantDeveloperContextPath(file.path)
  );
  const structure = detectProjectStructure(developerContextFiles);
  const taskIntent = parseTaskIntent(task);
  const relevantFiles = rankRelevantFiles({
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
    .filter((filePath): filePath is string => typeof filePath === "string");
  const contentMap = contextPaths.length > 0 ? await readProjectFiles(contextPaths) : {};
  const originalContents = Object.fromEntries(
    contextFileRecords.map((file) => [
      file.path,
      file.absolutePath ? contentMap[file.absolutePath] ?? "" : "",
    ])
  );
  const existingFilesSummary =
    relevantFiles.length > 0
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

async function buildHostedEnhanceContext(
  role: string,
  repoPath: string
): Promise<HostedEnhanceContextPayload> {
  const repoFiles = await scanRepo(repoPath);
  const contextFiles = selectEnhanceContextFiles(role, repoFiles);
  const contents =
    contextFiles.length > 0
      ? await readProjectFiles(contextFiles.map((file) => file.absolutePath))
      : {};

  return {
    contextFiles: contextFiles.map((file) => ({
      path: file.path,
      content: contents[file.absolutePath] ?? "",
    })),
  };
}

async function buildHostedTestEngineerContext(
  task: string,
  repoPath: string
): Promise<HostedTestEngineerContextPayload> {
  const allFiles = await scanRepo(repoPath);
  const framework = detectTestFramework(allFiles);
  const context = buildTestEngineerContext(task, framework, allFiles);

  return {
    availableFiles: allFiles.map((file) => ({
      path: file.path,
      category: file.category,
      extension: file.extension,
    })),
    pageObjectContents: await readExampleContents(context.pageObjectFiles, allFiles, 3),
    stepDefinitionContents: await readExampleContents(
      context.stepDefinitionFiles,
      allFiles,
      2
    ),
    featureContents: await readFeatureExampleContents(
      context.featureFiles,
      allFiles,
      framework
    ),
    existingTestContents: await readExampleContents(
      context.existingTestFiles,
      allFiles,
      3
    ),
  };
}

async function buildHostedDataAnalystContext(
  task: string,
  repoPath: string
): Promise<HostedDataAnalystContextPayload> {
  const allFiles = await scanRepo(repoPath);
  const schema = detectDataSchema(allFiles);
  const context = buildDataAnalystContext(task, schema, allFiles);
  const existingSqlFiles = context.existingSqlFiles.slice(0, 3);
  const sqlPaths = existingSqlFiles
    .map((file: { absolutePath?: string }) => file.absolutePath)
    .filter((filePath: unknown): filePath is string => typeof filePath === "string");
  const contents = sqlPaths.length > 0 ? await readProjectFiles(sqlPaths) : {};

  return {
    availableFiles: allFiles.map((file) => ({
      path: file.path,
      category: file.category,
      extension: file.extension,
    })),
    schema,
    existingSqlContents: existingSqlFiles.map((file: { path: string; absolutePath?: string }) => ({
      path: file.path,
      content: file.absolutePath ? contents[file.absolutePath] ?? "" : "",
    })),
  };
}

async function handleCheckAccess(req: express.Request, res: express.Response): Promise<void> {
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const conversationId =
    typeof req.query.conversationId === "string" ? req.query.conversationId : "";
  const billingMode = undefined;
  const repoPath =
    typeof req.query.repoPath === "string" ? req.query.repoPath : undefined;
  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  console.log("[zone-billing-debug] preflight check start", {
    routeName: "/api/check-access",
    userId: userId || null,
    billingMode: billingMode ?? null,
    repoPath: repoPath ?? null,
    role: role ?? null,
  });
  const authorization = await ensureRunAuthorized(
      userId,
    {
      conversationId,
      billingMode,
      repoPath,
      role,
    }
  );
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

async function handleBillingSummary(
  req: express.Request,
  res: express.Response
): Promise<void> {
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
  const profilesTable = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
        eq?: (column: string, value: string) => {
          maybeSingle?: () => Promise<{
            data: {
              billing_mode?: string | null;
              subscription_status?: string | null;
              token_credits_used?: number | string | null;
              token_credits_limit?: number | string | null;
              token_credits_used_today?: number | string | null;
              token_credits_daily_limit?: number | string | null;
              daily_reset_at?: string | null;
            } | null;
          error?: unknown;
        }>;
      };
    };
  };
    console.log(
      `[zone] billing-summary: querying profiles where clerk_user_id=${userId}`
    );
    const query = profilesTable
      .select?.(
        "subscription_status,billing_mode,token_credits_used,token_credits_limit,token_credits_used_today,token_credits_daily_limit,daily_reset_at"
      )
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
      error:
        error && typeof error === "object"
          ? {
              message:
                "message" in error
                  ? (error as { message?: unknown }).message
                  : undefined,
              code:
                "code" in error
                  ? (error as { code?: unknown }).code
                  : undefined,
              details:
                "details" in error
                  ? (error as { details?: unknown }).details
                  : undefined,
              hint:
                "hint" in error
                  ? (error as { hint?: unknown }).hint
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
    const billingMode =
      typeof data.billing_mode === "string" && data.billing_mode.trim()
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
  } catch {
    res.json({ ok: false, reason: "profile_unavailable" });
  }
}

function getDecisionModeFromResult(
  result: Record<string, unknown>,
  confidence: number
): string {
  const decisionMode = result["decisionMode"];
  if (typeof decisionMode === "string" && decisionMode.length > 0) {
    return decisionMode;
  }
  return confidence < 70 ? "preview_only" : "safe_to_apply";
}

function getTestEngineerUserFacingReason(reason: string): string {
  if (reason.includes("Could not detect a test framework")) {
    return (
      "No supported test setup detected\n\n" +
      "Zone Test Engineer needs an existing supported test setup in this folder.\n" +
      "Supported: Playwright, Cypress, Cucumber+Java, Selenium (Java/Python), TestNG, or pytest."
    );
  }

  return reason;
}

function getDataAnalystUserFacingReason(reason: string): string {
  if (
    reason.includes("detectDataSchema failed") ||
    reason.includes("buildDataAnalystContext failed")
  ) {
    return (
      "No database context detected\n\n" +
      "Zone Data Analyst needs existing schema or migration context in this folder.\n" +
      "Supported signals include SQL migrations, Alembic, Flyway, Liquibase, or existing database files."
    );
  }

  return reason;
}

function normalizeSubscriptionStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasPaidAccess(subscriptionStatus: unknown): boolean {
  const normalized = normalizeSubscriptionStatus(subscriptionStatus);
  return normalized === "pro";
}

// ── DESKTOP DEVICE CODE AUTH ────────────────────────────────
const DESKTOP_TOKEN_SECRET =
  (process.env.ZONE_DESKTOP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "zone-desktop-fallback").trim();
const DESKTOP_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const deviceCodes = new Map<string, { userId?: string; createdAt: number }>();

function generateDesktopToken(userId: string): string {
  const expiry = Date.now() + DESKTOP_TOKEN_EXPIRY_MS;
  const payload = `${userId}:${expiry}`;
  const hmac = crypto.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + hmac;
}

function verifyDesktopToken(token: string): string | null {
  try {
    const [payloadB64, hmac] = token.split(".");
    if (!payloadB64 || !hmac) return null;
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const expectedHmac = crypto.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(payload).digest("base64url");
    if (hmac !== expectedHmac) return null;
    const [userId, expiryStr] = payload.split(":");
    if (!userId || Number(expiryStr) < Date.now()) return null;
    return userId;
  } catch { return null; }
}

// Cleanup expired codes every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of deviceCodes) {
    if (now - data.createdAt > 10 * 60 * 1000) deviceCodes.delete(code);
  }
}, 5 * 60 * 1000);
async function ensureRunAuthorized(
  rawUserId: unknown,
  options?: {
    conversationId?: string;
    billingMode?: string;
    repoPath?: string;
    role?: string;
  }
): Promise<
  | { allowed: true }
  | {
      allowed: false;
      status: number;
      body:
        | {
            ok: false;
            reason: "unauthorized";
            message: "Missing user session. Please open Zone from your dashboard.";
          }
        | {
            ok: false;
            reason: "token_limit_reached";
            message: "You've used all your tokens. Upgrade to Pro.";
            upgradeUrl: "https://zonecli.dev/#pricing";
          }
        | {
            ok: false;
            reason: "token_limit_reached" | "token_daily_limit_reached";
            message: string;
            dailyResetAt?: number | null;
          }
        | {
            ok: false;
            reason: "token_limit_reached";
            tokenCreditsUsed: number;
            tokenCreditsLimit: number;
          };
    }
> {
  const authenticatedUserId =
    typeof rawUserId === "string" ? rawUserId.trim() : "";

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
    const profileQuery = supabase.from("profiles") as unknown as {
      select: (columns: string) => {
        eq: (column: string, value: string) => {
          maybeSingle: () => Promise<{
            data?: {
              subscription_status?: string | null;
              billing_mode?: string | null;
              token_credits_used?: number | string | null;
              token_credits_limit?: number | string | null;
              token_credits_used_today?: number | string | null;
              token_credits_daily_limit?: number | string | null;
              daily_reset_at?: string | null;
            } | null;
            error?: { message?: string } | null;
          }>;
        };
      };
    };
    const { data: profileData } = await profileQuery
      .select(
        "subscription_status,billing_mode,token_credits_used,token_credits_limit,token_credits_used_today,token_credits_daily_limit,daily_reset_at"
      )
      .eq("clerk_user_id", authenticatedUserId)
      .maybeSingle();

    const subscriptionStatus = normalizeSubscriptionStatus(profileData?.subscription_status) || "free";
    const paidAccess = hasPaidAccess(subscriptionStatus);
    const resolvedBillingMode =
      typeof profileData?.billing_mode === "string" && profileData.billing_mode.trim()
        ? profileData.billing_mode.trim()
        : "hosted";

    const tokenCreditsUsed =
      typeof profileData?.token_credits_used === "number"
        ? profileData.token_credits_used
        : Number(profileData?.token_credits_used ?? 0);
    const tokenCreditsLimit =
      typeof profileData?.token_credits_limit === "number"
        ? profileData.token_credits_limit
        : Number(profileData?.token_credits_limit ?? 500000);
    const tokenCreditsUsedToday =
      typeof profileData?.token_credits_used_today === "number"
        ? profileData.token_credits_used_today
        : Number(profileData?.token_credits_used_today ?? 0);
    const tokenCreditsDailyLimit =
      typeof profileData?.token_credits_daily_limit === "number"
        ? profileData.token_credits_daily_limit
        : Number(profileData?.token_credits_daily_limit ?? 50000);
    const dailyResetAtRaw =
      typeof profileData?.daily_reset_at === "string" ? profileData.daily_reset_at : null;
    const dailyResetAt =
      dailyResetAtRaw ? new Date(dailyResetAtRaw).getTime() + 24 * 60 * 60 * 1000 : null;

    const billingAction = resolveBillingAction({
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

    if (billingAction === "FREE") return { allowed: true };

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
  } catch {
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
function emitProgress(
  runId: string | undefined,
  update:
    | string
    | {
        stage: string;
        lifecycle?: AgentLifecycleEvent;
        progress?: ZoneStructuredProgressEvent;
      }
): void {
  if (!runId) return;
  if (typeof update === "string") {
    emitDeveloperPatchProgress(runId, { stage: update });
  } else {
    const progress =
      update.progress && !update.progress.runId
        ? { ...update.progress, runId, ts: update.progress.ts ?? Date.now() }
        : update.progress;
    emitDeveloperPatchProgress(runId, {
      stage: update.stage,
      lifecycle: update.lifecycle,
      progress,
    });
  }
}

async function createDeveloperPatchJobPayload(input: {
  task: string;
  repoPath: string;
  userId: string;
  conversationId?: string;
  billingMode?: "hosted";
  hostedContext?: HostedDeveloperContextPayload;
}): Promise<DeveloperPatchJobRequestPayload> {
  let hostedContext = input.hostedContext;
  if (
    !hostedContext &&
    shouldUseHostedInferenceProxy() &&
    typeof input.task === "string" &&
    typeof input.repoPath === "string"
  ) {
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

function selectEnhanceContextFiles(
  role: string,
  files: Array<{ path: string; absolutePath?: string }>
): Array<{ path: string; absolutePath: string }> {
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const roleMatchers: Record<string, (path: string) => boolean> = {
    test_engineer: (filePath) =>
      /\.(spec|test)\.[jt]sx?$/i.test(filePath.replace(/\\/g, "/")),
    developer: (filePath) =>
      /^src\/.*\.ts$/i.test(filePath.replace(/\\/g, "/")),
    data_analyst: (filePath) => {
      const normalized = filePath.replace(/\\/g, "/");
      return normalized.endsWith(".sql") || normalized.includes("/migrations/");
    },
  };

  const match = roleMatchers[role] ?? (() => false);
  return sortedFiles
    .filter(
      (file): file is { path: string; absolutePath: string } =>
        Boolean(file.absolutePath) && match(file.path)
    )
    .slice(0, 3);
}

async function enhanceTask(input: {
  task: string;
  role: string;
  repoPath: string;
  hostedContext?: HostedEnhanceContextPayload;
}): Promise<string> {
  try {
    const repoContext =
      input.hostedContext?.contextFiles && input.hostedContext.contextFiles.length > 0
        ? input.hostedContext.contextFiles
            .map((file) => {
              return `FILE: ${file.path}\n${file.content ?? ""}`;
            })
            .join("\n\n")
        : (() => {
            const repoFiles = scanRepo(input.repoPath);
            return repoFiles.then(async (files) => {
              const contextFiles = selectEnhanceContextFiles(input.role, files);
              const contents =
                contextFiles.length > 0
                  ? await readProjectFiles(
                      contextFiles.map((file) => file.absolutePath)
                    )
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
    const resolvedRepoContext =
      typeof repoContext === "string" ? repoContext : await repoContext;

    const client = createOpenAIClient();
    const model = getModelName();
    const response = await client.responses.create({
      model,
      instructions: ENHANCE_TASK_SYSTEM_PROMPT,
      input:
        `Role: ${input.role}\n` +
        `Repo path: ${input.repoPath}\n` +
        `User task: ${input.task}\n\n` +
        `Relevant repository context:\n${resolvedRepoContext}`,
    });

    return String(response.output_text || "").trim();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

app.get("/api/progress", (req, res) => {
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

  attachDeveloperPatchProgressSseClient(runId, res);

  req.on("close", () => {
    detachDeveloperPatchProgressSseClient(runId, res);
  });
});
// ── Desktop Auth Routes ──
app.post("/api/desktop-auth/start", (_req, res) => {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 char: "A1B2C3"
  deviceCodes.set(code, { createdAt: Date.now() });
  res.json({ ok: true, code, expiresIn: 600 });
});

app.get("/api/desktop-auth/poll", (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  const entry = deviceCodes.get(code);
  if (!entry) { res.json({ ok: false, status: "expired" }); return; }
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    deviceCodes.delete(code);
    res.json({ ok: false, status: "expired" });
    return;
  }
  if (!entry.userId) { res.json({ ok: false, status: "pending" }); return; }
  const token = generateDesktopToken(entry.userId);
  deviceCodes.delete(code);
  res.json({ ok: true, status: "complete", token, userId: entry.userId });
});

app.post("/api/desktop-auth/complete", (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const userId = String(req.body?.userId || "").trim();
  if (!code || !userId) { res.status(400).json({ ok: false, reason: "missing_code_or_user" }); return; }
  const entry = deviceCodes.get(code);
  if (!entry) { res.status(404).json({ ok: false, reason: "code_expired" }); return; }
  entry.userId = userId;
  res.json({ ok: true });
});

app.get("/desktop-auth", (_req, res) => {
  res.type("html").send(renderDesktopAuthPage());
});
function renderDesktopAuthPage(): string {
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
app.get("/api/check-access", async (req, res) => {
  if (shouldProxyHostedRequest(req, "/api/check-access")) {
    await proxyHostedZoneRequest(req, res, "/api/check-access", {
      onNotFound: () => handleCheckAccess(req, res),
    });
    return;
  }

  await handleCheckAccess(req, res);
});

app.get("/api/billing-summary", async (req, res) => {
  if (shouldProxyHostedRequest(req, "/api/billing-summary")) {
    await proxyHostedZoneRequest(req, res, "/api/billing-summary", {
      onNotFound: () => handleBillingSummary(req, res),
    });
    return;
  }

  await handleBillingSummary(req, res);
});

app.post("/api/admin/reset-monthly-runs", async (req, res) => {
  const adminSecret =
    typeof process.env.ADMIN_SECRET === "string"
      ? process.env.ADMIN_SECRET.trim()
      : "";
  const providedSecret =
    typeof req.get("x-admin-secret") === "string"
      ? req.get("x-admin-secret")!.trim()
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

app.post("/api/analyze", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runAgent({ task, role: "developer" });
  res.json({
    decision: result.decision,
    risk: result.risk,
    confidence: result.confidence,
  });
});

app.post("/api/patch/jobs", async (req, res) => {
    const { task, repoPath, userId, hostedContext, conversationId, billingMode } =
      req.body ?? {};

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
    const job = await createDeveloperPatchJob(supabase, {
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "job_enqueue_failed",
    });
  }
});

app.get("/api/patch/jobs/:runId", async (req, res) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    res.status(500).json({ ok: false, reason: "profile_unavailable" });
    return;
  }

  try {
    const job = await getDeveloperPatchJob(supabase, req.params.runId);
    if (!job) {
      res.status(404).json({ ok: false, reason: "job_not_found" });
      return;
    }

    const decoded = decodeProgressStage(job.progress_stage);
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "job_lookup_failed",
    });
  }
});

app.get("/api/patch/jobs/:runId/result", async (req, res) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    res.status(500).json({ ok: false, reason: "profile_unavailable" });
    return;
  }

  try {
    const job = await getDeveloperPatchJob(supabase, req.params.runId);
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

    const decodedNotReady = decodeProgressStage(job.progress_stage);
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "job_result_lookup_failed",
    });
  }
});

app.post("/api/patch", async (req, res) => {
  const perf = startZoneApiPerfRun("/api/patch");
  perf.mark("route entered");
  const billingMode = "hosted";
  if (shouldProxyHostedRequest(req, "/api/patch")) {
    const { task, repoPath } = req.body ?? {};
    const hostedContext =
      req.body?.hostedContext ??
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

  const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;
  perf.mark("request normalized");

  if (!task || !repoPath) {
    perf.finish("bad request");
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
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
      patchPreview:
        "[LOG_ONLY] Bookkeeping request ignored. Existing patch result remains authoritative.",
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

const result = await runLlmPatchFlow({
  task,
  repoPath,
  hostedContext,
  runId: typeof runId === "string" ? runId : undefined,
  perfLabel: "/api/patch core",
  onProgress: (update) => emitProgress(runId, update),
});
perf.mark("core patch flow complete");

if (result.ok && result.applyPatches.length > 0) {
  const validation = validateLlmOutput(
    "developer",
    result.applyPatches.map((p) => ({
      filePath: p.filePath,
      content: p.fullContent,
    }))
  );
  perf.mark("output validation complete");
  if (validation.verdict === "block") {
    perf.finish("validation blocked");
    res.status(422).json({
      ok: false,
      reason: "Output validation failed — patch blocked.",
      validationIssues: validation.issues,
    });
    return;
  }
  if (validation.issues.length > 0) {
    (result as Record<string, unknown>).validationIssues = validation.issues;
    (result as Record<string, unknown>).validationVerdict = validation.verdict;
  }
}

  if (result.ok) {
    const confidence =
      typeof result.developerConfidence === "number"
        ? result.developerConfidence
        : 0;

    console.log("[zone-billing-debug] execution success reached", {
      routeName: "/api/patch",
      userId: typeof userId === "string" ? userId.trim() : null,
      billingMode: billingMode ?? null,
    });

    const loggedConversationId = await logRun({
      userId,
      role: "developer",
      task,
      repoPath,
      decisionMode:
        result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
      confidence,
      executionId: typeof runId === "string" ? runId : undefined,
      creditsUsed: 1,
      conversationId,
      billingMode,
      routeName: "/api/patch",
    }).catch(() => null);

    if (loggedConversationId) {
      (result as Record<string, unknown>).conversationId = loggedConversationId;
    }
    perf.mark("successful accounting complete");
  }

perf.mark("response ready");
perf.finish("complete");
res.json(result);
});
app.post("/api/dry-run", async (req, res) => {
  const billingMode = "hosted";
  if (shouldProxyHostedRequest(req, "/api/dry-run")) {
    const { task, repoPath } = req.body ?? {};
    const hostedContext =
      req.body?.hostedContext ??
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

  const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;

  const authorization = await ensureRunAuthorized(userId, {
    billingMode,
  });
  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }

const result = await runLlmPatchFlow({
  task,
  repoPath,
  dryRun: true,
  hostedContext,
  runId: typeof runId === "string" ? runId : undefined,
  onProgress: (update) => emitProgress(runId, update),
});
if (!result.ok) {
  res.status(500).json(result);
  return;
}

if (result.applyPatches.length > 0) {
  const validation = validateLlmOutput(
    "developer",
    result.applyPatches.map((p) => ({
      filePath: p.filePath,
      content: p.fullContent,
    }))
  );
  if (validation.verdict === "block") {
    res.status(422).json({
      ok: false,
      reason: "Output validation failed — patch blocked.",
      validationIssues: validation.issues,
    });
    return;
  }
  if (validation.issues.length > 0) {
    (result as Record<string, unknown>).validationIssues = validation.issues;
    (result as Record<string, unknown>).validationVerdict = validation.verdict;
  }
}

  const responseBody: Record<string, unknown> = {
  ok: true,
  fileDiffs: result.fileDiffs ?? [],
  patchPreview: result.patchPreview,
  warnings: result.warnings,
  patchResults: result.patchResults,
};

  const confidence =
    typeof result.developerConfidence === "number"
      ? result.developerConfidence
      : 0;

  console.log("[zone-billing-debug] execution success reached", {
    routeName: "/api/dry-run",
    userId: typeof userId === "string" ? userId.trim() : null,
    billingMode: billingMode ?? null,
  });

  const loggedConversationId = await logRun({
    userId,
    role: "developer",
    task,
    repoPath,
    decisionMode:
      result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
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

type SuggestedVerification = {
  available: boolean;
  command?: string;
  label?: string;
  repoPath?: string;
};

function getVerificationLabel(command: string): string {
  return command === "npm run build" ? "Run build" : "Run tests";
}

async function buildSuggestedVerification(
  repoPath: string,
  options?: { includeRepoPath?: boolean }
): Promise<SuggestedVerification> {
  try {
    const repoFiles = (await scanRepo(repoPath)).map((file) => file.path);
    const command = detectVerificationCommand({ repoPath, repoFiles });
    return command
      ? {
          available: true,
          command: command.command,
          label: getVerificationLabel(command.command),
          ...(options?.includeRepoPath ? { repoPath } : {}),
        }
      : { available: false };
  } catch {
    return { available: false };
  }
}

app.post("/api/apply", async (req, res) => {
  const { patches, repoPath } = req.body;
  const result = await applyLlmPatches(patches, repoPath);
  let suggestedVerification: SuggestedVerification = { available: false };
  if (result.applied.length > 0 && typeof repoPath === "string") {
    suggestedVerification = await buildSuggestedVerification(repoPath);
    console.log(
      `[zone-verify-suggest] command="${suggestedVerification.command ?? ""}" available=${suggestedVerification.available}`
    );
  }
  const responseBody = {
    ...result,
    suggestedVerification,
  };
  console.log(
    `[zone-apply] suggestedVerification available=${suggestedVerification.available} command="${suggestedVerification.command ?? ""}"`
  );
  res.json(responseBody);
});

app.post("/api/suggest-verification", async (req, res) => {
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
  console.log(
    `[zone-verify-suggest] command="${suggestedVerification.command ?? ""}" available=${suggestedVerification.available}`
  );
  res.json({ ok: true, suggestedVerification });
});

app.post("/api/run-verification", async (req, res) => {
  const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath : "";
  const requestedCommand =
    typeof req.body?.command === "string" ? req.body.command.trim() : "";

  if (!repoPath || !requestedCommand) {
    res.status(400).json({
      ok: false,
      reason: "repoPath_and_command_required",
    });
    return;
  }

  try {
    const repoFiles = (await scanRepo(repoPath)).map((file) => file.path);
    const detectedCommand = detectVerificationCommand({ repoPath, repoFiles });
    if (!detectedCommand || detectedCommand.command !== requestedCommand) {
      res.status(403).json({
        ok: false,
        reason: "verification_command_not_allowed",
      });
      return;
    }

    const verification = await runRuntimeVerification({
      repoPath,
      command: detectedCommand,
    });
    console.log(
      `[zone-verify-run] command="${detectedCommand.command}" status=${verification.status}`
    );
    res.json({ ok: true, verification });
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "verification_failed",
    });
  }
});

app.post("/api/refine-prompt", async (req, res) => {
  const billingMode = "hosted";
  if (shouldProxyHostedRequest(req, "/api/refine-prompt")) {
    await proxyHostedZoneRequest(req, res, "/api/refine-prompt");
    return;
  }

  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!task) {
    res.status(400).json({ ok: false, reason: "task_required" });
    return;
  }

  const role = typeof req.body?.role === "string" ? req.body.role : undefined;
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const relevantFiles = Array.isArray(req.body?.relevantFiles)
    ? req.body.relevantFiles.filter((file: unknown): file is string => typeof file === "string")
    : undefined;
  const plan =
    req.body?.plan && typeof req.body.plan === "object"
      ? req.body.plan
      : undefined;

  try {
    const refinedPrompt = await refinePrompt({
      task,
      role,
      reason,
      relevantFiles,
      plan,
    });
    console.log(
      `[zone-refine] prompt refined role=${role || "developer"} reason=${reason || "unspecified"}`
    );
    res.json({ ok: true, refinedPrompt });
  } catch {
    res.json({ ok: true, refinedPrompt: PROMPT_REFINEMENT_FALLBACK });
  }
});

app.post("/api/enhance-task", async (req, res) => {
  const billingMode = "hosted";
  if (shouldProxyHostedRequest(req, "/api/enhance-task")) {
    const { role, repoPath } = req.body ?? {};
    const hostedContext =
      typeof role === "string" && typeof repoPath === "string"
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
    const result = await enhanceTask({
      task,
      role,
      repoPath,
      hostedContext,
    });
    res
      .type("application/json")
      .send(JSON.stringify({ ok: true, enhancedTask: result }));
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/test-engineer", async (req, res) => {
  const billingMode = "hosted";
if (shouldProxyHostedRequest(req, "/api/test-engineer")) {
    const { task, repoPath } = req.body ?? {};
    const hostedContext =
      req.body?.hostedContext ??
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
const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId, {
  billingMode,
});  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }
  try {
const result = await runTestEngineerFlow({
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
  const validation = validateLlmOutput(
    "test_engineer",
    result.applyPatches.map((p: { filePath: string; fullContent: string }) => ({
      filePath: p.filePath,
      content: p.fullContent,
    }))
  );
  if (validation.verdict === "block") {
    res.status(422).json({
      ok: false,
      reason: "Output validation failed — patch blocked.",
      validationIssues: validation.issues,
    });
    return;
  }
  if (validation.issues.length > 0) {
    (result as Record<string, unknown>).validationIssues = validation.issues;
  }
}
    if (result.ok) {
const normalizedUserId = typeof userId === "string" ? userId.trim() : null;
console.log("[zone-billing-debug] execution success reached", {
  routeName: "/api/test-engineer",
  userId: normalizedUserId,
  billingMode: billingMode ?? null,
});
const loggedConversationId = await logRun({
  userId,
  role: "test_engineer",
  task,
  repoPath,
  decisionMode: getDecisionModeFromResult(
    result as unknown as Record<string, unknown>,
    result.confidence
  ),
  confidence: result.confidence,
  executionId: typeof runId === "string" ? runId : undefined,
  creditsUsed: 1,
  conversationId,
  billingMode,
  routeName: "/api/test-engineer",
}).catch(() => null);

      if (loggedConversationId) {
        (result as Record<string, unknown>).conversationId = loggedConversationId;
      }
    }
    res.json(result);
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/data-analyst", async (req, res) => {
  const billingMode = "hosted";
if (shouldProxyHostedRequest(req, "/api/data-analyst")) {
    const { task, repoPath } = req.body ?? {};
    const hostedContext =
      typeof task === "string" && typeof repoPath === "string"
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
const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId, {
  billingMode,
});  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }
  try {
const result = await runDataAnalystFlow({
  task,
  repoPath,
  onProgress: (stage) => emitProgress(runId, stage),
  hostedContext,
});
    if (result.ok && result.applyPatches) {
      const validation = validateLlmOutput(
        "data_analyst",
        result.applyPatches.map((p: { filePath: string; fullContent: string }) => ({
          filePath: p.filePath,
          content: p.fullContent,
        }))
      );
      if (validation.verdict === "block") {
        res.status(422).json({
          ok: false,
          reason: "Output validation failed — patch blocked.",
          validationIssues: validation.issues,
        });
        return;
      }
      if (validation.issues.length > 0) {
        (result as Record<string, unknown>).validationIssues = validation.issues;
        (result as Record<string, unknown>).validationVerdict = validation.verdict;
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
  const loggedConversationId = await logRun({
  userId,
  role: "data_analyst",
  task,
  repoPath,
  decisionMode: getDecisionModeFromResult(
    result as unknown as Record<string, unknown>,
    result.confidence
  ),
  confidence: result.confidence,
  executionId: typeof runId === "string" ? runId : undefined,
  creditsUsed: 1,
  conversationId,
  billingMode,
  routeName: "/api/data-analyst",
}).catch(() => null);

      if (loggedConversationId) {
        (result as Record<string, unknown>).conversationId = loggedConversationId;
      }
    }
    res.json(result);
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.use(express.static(zoneUiDir));

export async function startServer(port = 3000): Promise<void> {
  if (startPromise) {
    return startPromise;
  }

  startedPort = port;
  logStartupDiagnostics();
  startPromise = new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(
        colorize(`Zone UI running on http://localhost:${port}`, c.green, c.bold)
      );
      console.log(colorize("Press Ctrl+C to stop", c.dim, c.gray));
      resolve();
    });
  });

  await startPromise;
}

if (
  process.env.VITEST !== "true" &&
  process.env.ZONE_SERVER_MANUAL_START !== "1"
) {
  void startServer(startedPort ?? Number(port));
}
