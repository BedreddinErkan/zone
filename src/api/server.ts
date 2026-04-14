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
import { resolveBillingAction } from "../billing/resolveBillingAction.js";
import type { Response } from "express";
import { c, colorize } from "../cli/colors.js";
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
const progressStreams = new Map<string, Set<Response>>();
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
      "X-User-OpenAI-Key",
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
  const billingMode =
    typeof req.query.billingMode === "string" ? req.query.billingMode : undefined;
  const repoPath =
    typeof req.query.repoPath === "string" ? req.query.repoPath : undefined;
  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  console.log("[zone-billing-debug] preflight check start", {
    routeName: "/api/check-access",
    userId: userId || null,
    billingMode: billingMode ?? null,
    isByok: isTruthyByok(req.query.isByok),
    repoPath: repoPath ?? null,
    role: role ?? null,
  });
  const authorization = await ensureRunAuthorized(
      userId,
    isTruthyByok(req.query.isByok),
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
            credits?: number | string | null;
runs_used_this_month?: number | string | null;
free_limit?: number | string | null;
subscription_status?: string | null;
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
    .select?.("credits,runs_used_this_month,free_limit,subscription_status")
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
    const credits =
      typeof data.credits === "number"
        ? data.credits
        : Number(data.credits ?? 0);
    const runsUsedThisMonth =
      typeof data.runs_used_this_month === "number"
        ? data.runs_used_this_month
        : Number(data.runs_used_this_month ?? 0);
    const freeLimit =
      typeof data.free_limit === "number"
        ? data.free_limit
        : Number(data.free_limit ?? FREE_PLAN_RUN_LIMIT);
    const status = normalizeSubscriptionStatus(data.subscription_status) || "free";
    const legacyDerivedRemaining = hasPaidAccess(status)
      ? Math.max(
          0,
          PRO_PLAN_RUN_LIMIT - (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : 0)
        )
      : Math.max(
          0,
          (Number.isFinite(freeLimit) ? freeLimit : FREE_PLAN_RUN_LIMIT) -
            (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : 0)
        );
    const responsePayload = {
      ok: true,
      plan: hasPaidAccess(status) ? "Pro" : "Free",
      credits: Number.isFinite(credits) ? Math.max(0, credits) : 0,
      subscriptionStatus: status,
    };
    console.log("[zone-billing-summary-debug] resolved credits", {
      userId,
      credits,
      legacyDerivedRemaining,
      runsUsedThisMonth,
      freeLimit,
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

function isTruthyByok(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

async function ensureRunAuthorized(
  rawUserId: unknown,
  isByok = false,
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
            reason: "no_free_runs";
            message: "You've used all your free runs. Upgrade to Pro.";
            upgradeUrl: "https://zonecli.dev/#pricing";
          }
        | {
            ok: false;
            reason: "no_free_runs";
            message: "You've used all 250 monthly runs. Resets next month.";
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

  const resolvedBillingMode =
    options?.billingMode === "hosted" || options?.billingMode === "byok"
      ? options.billingMode
      : isByok
        ? "byok"
        : "hosted";

  const profilesTable = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
      eq?: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: {
            runs_used_this_month?: number | string | null;
            free_limit?: number | string | null;
            subscription_status?: string | null;
          } | null;
          error?: unknown;
        }>;
      };
    };
  };

  if (typeof profilesTable.select !== "function") {
    return { allowed: true };
  }

  const query = profilesTable
    .select("credits,runs_used_this_month,free_limit,subscription_status")
    ?.eq?.("clerk_user_id", authenticatedUserId);

  if (!query || typeof query.maybeSingle !== "function") {
    return { allowed: true };
  }

  try {
    const { data, error } = await query.maybeSingle();
    if (error) {
      return { allowed: true };
    }
    if (!data) {
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

    const runsUsedThisMonth =
      typeof data.runs_used_this_month === "number"
        ? data.runs_used_this_month
        : Number(data.runs_used_this_month ?? 0);
    const freeLimit =
      typeof data.free_limit === "number"
        ? data.free_limit
        : Number(data.free_limit ?? FREE_PLAN_RUN_LIMIT);

    const subscriptionStatus = normalizeSubscriptionStatus(data.subscription_status);
    const paidAccess = hasPaidAccess(subscriptionStatus);
    const billingAction = resolveBillingAction({
      mode: resolvedBillingMode,
      hasPaidAccess: paidAccess,
    });
    console.log("[zone-billing-debug] authorization resolved", {
      routeName: "ensureRunAuthorized",
      userId: authenticatedUserId,
      billingMode: resolvedBillingMode,
      subscriptionStatus,
      hasPaidAccess: paidAccess,
      billingAction,
      runsUsedThisMonth,
      freeLimit,
    });
    const credits =
      typeof data.credits === "number"
        ? data.credits
        : Number(data.credits ?? -1);
    if (Number.isFinite(credits) && credits > 0) {
      return { allowed: true };
    }

    if (billingAction === "FREE") {
      return { allowed: true };
    }

    if (paidAccess) {
      if (
        (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : 0) >=
        PRO_PLAN_RUN_LIMIT
      ) {
        return {
          allowed: false,
          status: 402,
          body: {
            ok: false,
            reason: "no_free_runs",
            message: "You've used all 250 monthly runs. Resets next month.",
          },
        };
      }

      return { allowed: true };
    }

    if (
      (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : FREE_PLAN_RUN_LIMIT) <
      (Number.isFinite(freeLimit) ? freeLimit : FREE_PLAN_RUN_LIMIT)
    ) {
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
  } catch {
    return { allowed: true };
  }
}
function emitProgress(runId: string | undefined, stage: string): void {
  if (!runId) return;
  const listeners = progressStreams.get(runId);
  if (!listeners) return;

  const payload = `data: ${JSON.stringify({ stage })}\n\n`;
  for (const res of listeners) {
    res.write(payload);
  }
}

async function createDeveloperPatchJobPayload(input: {
  task: string;
  repoPath: string;
  userId: string;
  conversationId?: string;
  billingMode?: "hosted" | "byok";
  hostedContext?: HostedDeveloperContextPayload;
  userOpenAiKey?: string;
  isByok: boolean;
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
    userOpenAiKey: input.userOpenAiKey,
    isByok: input.isByok,
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
  userOpenAiKey?: string;
  isByok?: boolean;
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

    const client = createOpenAIClient(input.userOpenAiKey);
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

  const listeners = progressStreams.get(runId) ?? new Set<Response>();
  listeners.add(res);
  progressStreams.set(runId, listeners);

  req.on("close", () => {
    const current = progressStreams.get(runId);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) {
      progressStreams.delete(runId);
    }
  });
});

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
    const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
    const isByok = Boolean(userOpenAiKey);
    const { task, repoPath, userId, hostedContext, conversationId, billingMode } =
      req.body ?? {};

  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }

  const authorization = await ensureRunAuthorized(userId, isByok, {
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
      userOpenAiKey,
      isByok,
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

    res.json({
      ok: true,
      runId: job.id,
      status: job.status,
      progressStage: job.progress_stage,
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

    res.json({
      ok: false,
      reason: "job_not_ready",
      runId: job.id,
      status: job.status,
      progressStage: job.progress_stage,
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
  const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
  const isByok = Boolean(userOpenAiKey);
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

  const { task, repoPath, userId, hostedContext, conversationId, billingMode } =
    req.body;
  perf.mark("request normalized");

  if (!task || !repoPath) {
    perf.finish("bad request");
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }

  const authorization = await ensureRunAuthorized(userId, isByok, {
    billingMode,
  });
  perf.mark("authorization complete");
  if (!authorization.allowed) {
    perf.finish("authorization blocked");
    res.status(authorization.status).json(authorization.body);
    return;
  }

const result = await runLlmPatchFlow({
  task,
  repoPath,
  hostedContext,
  userOpenAiKey,
  perfLabel: "/api/patch core",
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
      isByok,
    });

    const loggedConversationId = await logRun({
      userId,
      role: "developer",
      task,
      repoPath,
      decisionMode:
        result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
      confidence,
      creditsUsed: 1,
      conversationId,
      billingMode,
      isByok,
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
  const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
  const isByok = Boolean(userOpenAiKey);
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

  const { task, repoPath, userId, hostedContext, conversationId, billingMode } =
    req.body;

  const authorization = await ensureRunAuthorized(userId, isByok, {
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
  userOpenAiKey,
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
    isByok,
  });

  const loggedConversationId = await logRun({
    userId,
    role: "developer",
    task,
    repoPath,
    decisionMode:
      result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
    confidence,
    creditsUsed: 1,
    conversationId,
    billingMode,
    isByok,
    routeName: "/api/dry-run",
  }).catch(() => null);

  if (loggedConversationId) {
    responseBody.conversationId = loggedConversationId;
  }

res.json(responseBody);
});

app.post("/api/apply", async (req, res) => {
  const { patches, repoPath } = req.body;
  const result = await applyLlmPatches(patches, repoPath);
  res.json(result);
});

app.post("/api/enhance-task", async (req, res) => {
  const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
  const isByok = Boolean(userOpenAiKey);
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
      userOpenAiKey,
      isByok,
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
const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
  const isByok = Boolean(userOpenAiKey);
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
const { task, repoPath, runId, userId, hostedContext, conversationId, billingMode } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId, isByok, {
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
  userOpenAiKey,
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
  isByok,
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
  creditsUsed: 1,
  conversationId,
  billingMode,
  isByok,
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
const userOpenAiKey = req.headers["x-user-openai-key"] as string | undefined;
  const isByok = Boolean(userOpenAiKey);
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
const { task, repoPath, runId, userId, hostedContext, conversationId, billingMode } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId, isByok, {
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
  userOpenAiKey,
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
    isByok,
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
  creditsUsed: 1,
  conversationId,
  billingMode,
  isByok,
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
