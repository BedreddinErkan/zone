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
import type { Response } from "express";
import { c, colorize } from "../cli/colors.js";
import { validateLlmOutput } from "../core/validateLlmOutput.js";
import lemonWebhookRouter from "../routes/lemonsqueezyWebhook.js";
import createLemonCheckoutRouter from "../routes/createLemonCheckout.js";
import customerPortalRouter from "../routes/getLemonCustomerPortal.js";
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

type RunLogInput = {
  userId: string;
  role: string;
  task: string;
  repoPath: string;
  decisionMode: string;
  confidence: number;
  creditsUsed: number;
};

const FREE_PLAN_RUN_LIMIT = 10;
const PRO_PLAN_RUN_LIMIT = 1000;

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

app.use(cors());
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
  const authorization = await ensureRunAuthorized(userId);
  if (authorization.allowed) {
    res.json({ ok: true });
    return;
  }
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
    console.log(
      `[zone] billing-summary: supabase result=${JSON.stringify({
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
      })}`
    );
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
    const remainingRuns = hasPaidAccess(status)
      ? Math.max(
          0,
          PRO_PLAN_RUN_LIMIT - (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : 0)
        )
      : Math.max(
          0,
          (Number.isFinite(freeLimit) ? freeLimit : FREE_PLAN_RUN_LIMIT) -
            (Number.isFinite(runsUsedThisMonth) ? runsUsedThisMonth : 0)
        );
    res.json({
      ok: true,
      plan: hasPaidAccess(status) ? "Pro" : "Free",
      credits: remainingRuns,
      subscriptionStatus: status,
    });
  } catch {
    res.json({ ok: false, reason: "profile_unavailable" });
  }
}

async function logRun(input: RunLogInput): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const effectiveUserId =
    typeof input.userId === "string" ? input.userId.trim() : "";

  const userEmail =
    typeof process.env.ZONE_USER_EMAIL === "string"
      ? process.env.ZONE_USER_EMAIL.trim()
      : "";

  console.log(
    `[zone] logRun: effectiveUserId=${effectiveUserId || "missing"}`
  );

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
    console.log(
      `[zone] logRun: run_logs insert error=${insertResult.error.message}`
    );
  } else {
    console.log("[zone] logRun: run_logs insert ok");
  }

  const profilesRead = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
      eq?: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: {
            credits?: number | string | null;
            total_runs?: number | string | null;
            subscription_status?: string | null;
          } | null;
          error?: unknown;
        }>;
      };
    };
  };

  const profileQuery = profilesRead
    .select?.("credits,total_runs,subscription_status")
    ?.eq?.("clerk_user_id", effectiveUserId);

if (profileQuery && typeof profileQuery.maybeSingle === "function") {
  try {
    const { data, error } = await profileQuery.maybeSingle();

    if (!error && data) {
      const normalizedStatus = normalizeSubscriptionStatus(
        data.subscription_status
      );

      console.log(
        `[zone] logRun: subscription_status=${normalizedStatus || "missing"}`
      );
    } else {
      console.log("[zone] logRun: profile read failed, defaulting debit=1");
    }
  } catch {
    console.log("[zone] logRun: profile read threw, defaulting debit=1");
  }
}
  const freeRunDebit = 1;
  const rpcName = "deduct_credits_and_increment_runs";
  const rpcPayload = {
    p_user_id: effectiveUserId,
    p_credits: freeRunDebit,
  };
  console.log(`[zone] logRun: rpc debit=${freeRunDebit}`);
  console.log(
    `[zone] logRun: rpc call ${rpcName} payload=${JSON.stringify(rpcPayload)}`
  );

  const rpcResult = await supabase.rpc(rpcName, rpcPayload);
  console.log(
    `[zone] logRun: rpc response=${JSON.stringify({
      data: "data" in rpcResult ? rpcResult.data : undefined,
      error:
        rpcResult.error && typeof rpcResult.error === "object"
          ? {
              message:
                "message" in rpcResult.error
                  ? (rpcResult.error as { message?: unknown }).message
                  : undefined,
              code:
                "code" in rpcResult.error
                  ? (rpcResult.error as { code?: unknown }).code
                  : undefined,
              details:
                "details" in rpcResult.error
                  ? (rpcResult.error as { details?: unknown }).details
                  : undefined,
              hint:
                "hint" in rpcResult.error
                  ? (rpcResult.error as { hint?: unknown }).hint
                  : undefined,
            }
          : rpcResult.error,
    })}`
  );

  if (rpcResult.error) {
    console.log(`[zone] logRun: rpc error=${rpcResult.error.message}`);
  } else {
    console.log("[zone] logRun: rpc ok");
  }
}
function queueRunLog(input: RunLogInput): void {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) return;
  void logRun(input).catch(() => undefined);
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

async function ensureRunAuthorized(
  rawUserId: unknown
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

  const profilesTable = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
      eq?: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: {
            credits?: number | string | null;
            total_runs?: number | string | null;
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
    .select("credits,total_runs,subscription_status")
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

    const credits =
      typeof data.credits === "number"
        ? data.credits
        : Number(data.credits ?? 0);

    const subscriptionStatus = normalizeSubscriptionStatus(
      data.subscription_status
    );

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

app.post("/api/analyze", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runAgent({ task, role: "developer" });
  res.json({
    decision: result.decision,
    risk: result.risk,
    confidence: result.confidence,
  });
});

app.post("/api/patch", async (req, res) => {
  if (shouldProxyHostedRequest(req, "/api/patch")) {
    const { task, repoPath } = req.body ?? {};
    const hostedContext =
      req.body?.hostedContext ??
      (typeof task === "string" && typeof repoPath === "string"
        ? await buildHostedDeveloperContext(task, repoPath)
        : undefined);
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

  const { task, repoPath, userId, hostedContext } = req.body;

  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }

  const authorization = await ensureRunAuthorized(userId);
  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }

const result = await runLlmPatchFlow({ task, repoPath, hostedContext });

if (result.ok && result.applyPatches.length > 0) {
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

res.json(result);

  if (result.ok) {
    const confidence =
      typeof result.developerConfidence === "number"
        ? result.developerConfidence
        : 0;

    queueRunLog({
      userId,
      role: "developer",
      task,
      repoPath,
      decisionMode:
        result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
      confidence,
      creditsUsed: 0.1,
    });
  }
});
app.post("/api/dry-run", async (req, res) => {
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

  const { task, repoPath, userId, hostedContext } = req.body;

  const authorization = await ensureRunAuthorized(userId);
  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }

const result = await runLlmPatchFlow({ task, repoPath, dryRun: true, hostedContext });
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

res.json({
  ok: true,
  fileDiffs: result.fileDiffs ?? [],
  patchPreview: result.patchPreview,
  warnings: result.warnings,
  patchResults: result.patchResults,
});

  const confidence =
    typeof result.developerConfidence === "number"
      ? result.developerConfidence
      : 0;

  queueRunLog({
    userId,
    role: "developer",
    task,
    repoPath,
    decisionMode:
      result.decisionMode ?? (confidence < 70 ? "preview_only" : "safe_to_apply"),
    confidence,
    creditsUsed: 0.1,
  });
});

app.post("/api/apply", async (req, res) => {
  const { patches, repoPath } = req.body;
  const result = await applyLlmPatches(patches, repoPath);
  res.json(result);
});

app.post("/api/enhance-task", async (req, res) => {
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
    const result = await enhanceTask({ task, role, repoPath, hostedContext });
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
const { task, repoPath, runId, userId, hostedContext } = req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId);  if (!authorization.allowed) {
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
    res.json(result);
    if (result.ok) {
queueRunLog({
  userId,
  role: "test_engineer",
  task,
  repoPath,
  decisionMode: getDecisionModeFromResult(
    result as unknown as Record<string, unknown>,
    result.confidence
  ),
  confidence: result.confidence,
  creditsUsed: 0.08,
});
    }
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/data-analyst", async (req, res) => {
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
const { task, repoPath, runId, userId, hostedContext } = req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
const authorization = await ensureRunAuthorized(userId);  if (!authorization.allowed) {
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
    res.json(result);
    if (result.ok) {
  queueRunLog({
  userId,
  role: "data_analyst",
  task,
  repoPath,
  decisionMode: getDecisionModeFromResult(
    result as unknown as Record<string, unknown>,
    result.confidence
  ),
  confidence: result.confidence,
  creditsUsed: 0.06,
});
    }
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
