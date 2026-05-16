import crypto from "node:crypto";
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import { exec, execSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runAgent } from "../core/runAgent.js";
import { getUsage, getRunCost, readRecords } from "../usage/usageTracker.js";
import { aggregateMetrics, type RunRecord } from "../llm/metricsAggregator.js";
import { loadOrgPolicy, validatePolicy } from "../llm/policyLoader.js";
import { aggregatorToPrometheus } from "../llm/prometheusFormatter.js";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import { getPatchUserFacingReason } from "../llm/patchUserFacingReason.js";
import { UpstreamUnavailableError } from "../llm/withExponentialBackoff.js";
import { routeCapGate } from "../llm/checkDailyCap.js";
import { loadLimitConfig, saveLimitConfig, checkUsageLimit } from "./usageLimits.js";
import {
  loadVisualSettings,
  saveVisualSettings,
  getVisualSettingsDefaults,
} from "../visual/visualSettings.js";
import { readTierSettings, writeTierSettings, readAutoAuditSetting, writeAutoAuditSetting } from "../visual/tierSettings.js";
import { TIER_LIMITS } from "../llm/tierLimits.js";
import { buildDashboardData } from "./sweepResultsApi.js";
import { invalidateDevServerCache } from "../visual/devServerProbe.js";
import {
  isIrrelevantDeveloperContextPath,
  runLlmPatchFlow,
  toPublicLlmPatchResponse,
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
  listBranches,
  switchBranch,
  createBranch,
} from "../repo/gitBranches.js";
import {
  getHostedInferenceBaseUrl,
  getInferenceMode,
  getModelName,
} from "../llm/openaiClient.js";
import { createLLMClient } from "../llm/factory.js";
import { withRequestContext, getRequestContext, attachRunIdentity } from "../llm/openaiContext.js";
import type { LLMProvider } from "../llm/types.js";
import {
  PROMPT_REFINEMENT_FALLBACK,
  refinePrompt,
} from "../llm/refinePrompt.js";
import {
  detectIntent,
  detectMessageType,
  shouldUseInvestigationMode,
} from "../llm/detectIntent.js";
import { getChatResponseWithContext } from "../llm/chatResponse.js";
import { runChatAgentFlow, runInvestigationFlow } from "../llm/investigationFlow.js";
import {
  appendConversationMessages,
  getUserQuota,
} from "../billing/conversationRepository.js";
import { resolveBillingAction } from "../billing/resolveBillingAction.js";
import { c, colorize } from "../cli/colors.js";
import {
  createAgentLifecycleEvent,
  type AgentLifecycleEvent,
  type ZoneStructuredProgressEvent,
} from "../core/agentLifecycleEvents.js";
import {
  attachDeveloperPatchProgressSseClient,
  closeDeveloperPatchProgressSseForRun,
  detachDeveloperPatchProgressSseClient,
  emitDeveloperPatchProgress,
  getRunBuffer,
  registerRunComplete,
  registerRunStart,
} from "../core/developerRunProgressSse.js";
import {
  clearTrustedCommandsForRun,
  rejectPendingApprovalsForRun,
  resolveCommandApproval,
  setTrustAllForRun,
} from "./commandApprovals.js";
import {
  resolveRevisionApproval,
  rejectPendingRevisionsForRun,
  requestRevisionApproval,
  type RevisionProposal,
} from "../llm/revisionApprovals.js";
import { investigateScope } from "../llm/investigationFlow.js";
import { runScopeJudge } from "../llm/scopeJudge.js";
import { classifyTask, type TaskClassification } from "../llm/taskClassifier.js";
import { preparePlanContext } from "../core/preparePlanContext.js";
import { generateExecutionPlan } from "../llm/executionPlan.js";
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
import {
  completeActiveRun as completeActiveRunRecord,
  getActiveRunsByUser,
  markAllRunningAsInterrupted,
  upsertActiveRun,
} from "../billing/activeRunsRepository.js";
import { indexRepoFiles } from "../embeddings/indexRepository.js";
import { LOG_LEVEL, logger, log, debugLog, errorLog } from "../utils/logger.js";
import { parseMode, MODES, type Mode } from "../types/mode.js";
export const app = express();
/** Active /api/patch runs — cancelled via POST /api/cancel (AbortSignal → runLlmPatchFlow). */
const activePatchRunAbortControllers = new Map<string, AbortController>();
const port = Number(process.env.PORT) || 3000;

async function completeActiveRun(runId: string, status: "completed" | "cancelled"): Promise<void> {
  try {
    clearTrustedCommandsForRun(runId);
  } catch {
    // best-effort
  }
  await completeActiveRunRecord(runId, status);
}
let startedPort: number | null = null;
let startPromise: Promise<void> | null = null;
const zoneUiDir = path.resolve(__dirname, "../ui");
const zoneUiIndexPath = path.join(zoneUiDir, "index.html");
/** Cached HTML shell in production only; dev re-reads from disk each request so UI edits apply without restart. */
let zoneUiHtmlTemplateCached: string | null = null;

function installConsoleLogFilter(): void {
  const globalState = globalThis as typeof globalThis & {
    __zoneConsoleFilterInstalled?: boolean;
    __zoneConsoleLogOriginal?: typeof console.log;
    __zoneConsoleWarnOriginal?: typeof console.warn;
  };
  if (globalState.__zoneConsoleFilterInstalled) {
    return;
  }
  globalState.__zoneConsoleFilterInstalled = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  globalState.__zoneConsoleLogOriginal = originalLog;
  globalState.__zoneConsoleWarnOriginal = originalWarn;

  if (LOG_LEVEL === "debug") {
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

  const shouldAllowLog = (args: unknown[]): boolean => {
    if (LOG_LEVEL === "quiet") return false;
    const first = typeof args[0] === "string" ? args[0] : "";
    if (
      first.startsWith("[zone-api-perf]") &&
      args.some(
        (arg) => typeof arg === "string" && /\bcomplete\b/i.test(arg)
      )
    ) {
      return true;
    }
    return allowedPrefixes.some((prefix) => first.startsWith(prefix));
  };

  console.log = (...args: unknown[]): void => {
    if (shouldAllowLog(args)) {
      originalLog(...args);
    }
  };

  console.warn = (...args: unknown[]): void => {
    if (LOG_LEVEL !== "quiet") {
      originalWarn(...args);
    }
  };
}

installConsoleLogFilter();

function readZoneUiHtmlTemplate(): string {
  if (process.env.NODE_ENV === "production") {
    if (!zoneUiHtmlTemplateCached) {
      zoneUiHtmlTemplateCached = readFileSync(zoneUiIndexPath, "utf8");
    }
    return zoneUiHtmlTemplateCached;
  }
  return readFileSync(zoneUiIndexPath, "utf8");
}
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

/** True when the client sent an actual hosted file payload (not billing-only / empty). */
function hostedDeveloperContextRequestHasFiles(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  const o = ctx as Record<string, unknown>;
  const cf = o.contextFiles;
  const legacy = o.files;
  return (
    (Array.isArray(cf) && cf.length > 0) ||
    (Array.isArray(legacy) && legacy.length > 0)
  );
}

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
      "X-Zone-LLM-Key",
      "X-Zone-Provider",
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
app.use("/api/cancel", developerRouteLimiter);
app.use("/api/approve-command", developerRouteLimiter);
app.use("/api/dry-run", developerRouteLimiter);

// Increase timeouts for long-running patch operations & SSE.
// 30 minutes covers worst-case agent runs (multi-file refactors with self-correction
// loops). Below 5–10 min the response socket dies mid-run and the browser auto-retries
// the POST, causing a same-runId double-invocation (Tur 3 re-trigger bug).
// AbortController + /api/cancel still terminate runs sooner on user request.
app.use("/api/patch", (_req, res, next) => {
  res.setTimeout(30 * 60 * 1000); // 30 minutes
  next();
});
app.use("/api/progress", (_req, res, next) => {
  res.setTimeout(30 * 60 * 1000); // 30 minutes
  next();
});

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
    /** True when the server has OPENAI_API_KEY set in the environment.
     *  Used by the UI to decide whether to prompt for a user-supplied key.
     *  The key VALUE is never exposed. */
    serverHasOpenAIKey: !!(
      typeof process.env.OPENAI_API_KEY === "string" &&
      process.env.OPENAI_API_KEY.trim()
    ),
  })};window.currentUser=window.currentUser||${JSON.stringify(currentUser)};</script>`;
  return readZoneUiHtmlTemplate().replace("</head>", `${configScript}</head>`);
}

function shouldUseHostedInferenceProxy(): boolean {
  return getInferenceMode() === "hosted";
}

// Removed Tur 5a: legacy X-User-OpenAI-Key header was a Tur 0-2 backward-compat
// shim. All clients (UI + zone-cli) now use X-Zone-LLM-Key + X-Zone-Provider.

export function getRequestContextFromHeaders(req: express.Request): {
  apiKey: string;
  provider: LLMProvider | undefined;
  modelHigh?: string;
  modelStandard?: string;
} {
  const newKey =
    typeof req.headers["x-zone-llm-key"] === "string"
      ? req.headers["x-zone-llm-key"].trim()
      : "";
  const providerRaw =
    typeof req.headers["x-zone-provider"] === "string"
      ? req.headers["x-zone-provider"].trim().toLowerCase()
      : "";
  const provider: LLMProvider | undefined =
    providerRaw === "openai" || providerRaw === "anthropic"
      ? (providerRaw as LLMProvider)
      : undefined;

  const modelHighRaw =
    typeof req.headers["x-zone-llm-model-high"] === "string"
      ? req.headers["x-zone-llm-model-high"].trim()
      : "";
  const modelStandardRaw =
    typeof req.headers["x-zone-llm-model-standard"] === "string"
      ? req.headers["x-zone-llm-model-standard"].trim()
      : "";
  const modelHigh = modelHighRaw || undefined;
  const modelStandard = modelStandardRaw || undefined;

  return { apiKey: newKey, provider, modelHigh, modelStandard };
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
  log(`[zone] inference mode: ${mode}`);

  if (mode === "hosted") {
    const hostedBaseUrl = getHostedInferenceBaseUrl();
    log(`[zone] hosted inference base URL: ${hostedBaseUrl}`);
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
  log(
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
    typeof req.headers["x-zone-llm-key"] === "string" &&
    req.headers["x-zone-llm-key"].trim()
  ) {
    forwardedHeaders["x-zone-llm-key"] = req.headers["x-zone-llm-key"].trim();
  }
  if (
    typeof req.headers["x-zone-provider"] === "string" &&
    req.headers["x-zone-provider"].trim()
  ) {
    forwardedHeaders["x-zone-provider"] = req.headers["x-zone-provider"].trim();
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
  const readContentForRanker = async (relPath: string): Promise<string | null> => {
    try {
      return await fs.promises.readFile(path.join(repoPath, relPath), "utf8");
    } catch {
      return null;
    }
  };
  const relevantFiles = (
    await rankRelevantFiles({
      task,
      files: developerContextFiles,
      intent: taskIntent,
      readContent: readContentForRanker,
    })
  ).slice(0, 8);
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
  debugLog("[zone-billing-debug] preflight check start", {
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
    debugLog("[zone-billing-debug] preflight check allowed", {
      routeName: "/api/check-access",
      userId: userId || null,
      billingMode: billingMode ?? null,
    });
    res.json({ ok: true });
    return;
  }
  debugLog("[zone-billing-debug] preflight check blocked", {
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
  debugLog(`[zone] billing-summary: userId=${userId || "missing"}`);
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
    debugLog(
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
    debugLog("[zone-billing-summary-debug] raw profile row", {
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
    debugLog("[zone-billing-summary-debug] resolved token credits", {
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
    debugLog("[zone-billing-summary-debug] final response payload", responsePayload);
    res.json(responsePayload);
  } catch {
    res.json({ ok: false, reason: "profile_unavailable" });
  }
}

function getDecisionModeFromResult(
  result: Record<string, unknown>,
  _confidence: number
): string {
  // Phase J.1: trust the upstream-declared decision verbatim. The previous
  // confidence < 70 / weak-verification → preview_only fallbacks (Bug 46)
  // are gone — those heuristics no longer gate apply. Real security blocks
  // come through as result.decisionMode === "blocked"; everything else is
  // safe_to_apply by default.
  const decisionMode = result["decisionMode"];
  if (typeof decisionMode === "string" && decisionMode.length > 0) {
    return decisionMode;
  }
  return "safe_to_apply";
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

function derivePatchTerminationReason(result: Record<string, unknown>): string {
  if (typeof result.terminationReason === "string" && result.terminationReason) {
    return result.terminationReason;
  }
  if (result.loopDetected) return "loop_detected";
  if (result.tokenBudgetExceeded) return "token_budget_exceeded";
  if (result.decisionMode === "rolled_back") return "APPLY_ROLLED_BACK";
  return "natural_completion";
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
    debugLog("[zone-billing-debug] authorization resolved", {
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

async function persistChatConversationMessage(input: {
  userId: string;
  threadId: string;
  repoPath: string;
  runId: string;
  userText: string;
  responseText: string;
  responseHtml: string;
  contextFiles: string[];
}): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  await appendConversationMessages(supabase, {
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

async function runConversationalFlow(input: {
  task: string;
  repoPath: string;
  runId: string;
  userId: string;
  conversationId?: string;
  messageType: "question" | "discussion";
  /** BYOK: user-supplied OpenAI API key forwarded from the browser header. */
  userApiKey?: string;
  lastChangedFiles?: string[];
  attachments?: import("./imageUpload.js").ImageAttachment[];
}): Promise<{
  ok: true;
  decisionMode: "chat";
  chatResponse: string;
  responseHtml: string;
  contextFiles: string[];
  messageType: "question" | "discussion";
  conversationId: string;
  applyPatches: [];
  fileDiffs: [];
}> {
  emitProgress(input.runId, {
    stage: "chat_response",
    progress: {
      type: "chat_start",
      title: "Thinking...",
      runId: input.runId,
      ts: Date.now(),
      status: "active",
    },
    lifecycle: createAgentLifecycleEvent({
      type: "run_started",
      message: "Conversational response started.",
      stage: "init",
      status: "active",
    }),
  });

  const chatResult = await getChatResponseWithContext({
    task: input.task,
    repoPath: input.repoPath,
    lastChangedFiles: input.lastChangedFiles,
    attachments: input.attachments,
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
    lifecycle: createAgentLifecycleEvent({
      type: "run_completed",
      message: "Conversational response completed.",
      stage: "finalize",
      status: "success",
    }),
  });

  const finalConversationId =
    typeof input.conversationId === "string" && input.conversationId.trim()
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
  } catch (error) {
    console.warn(
      "[zone-chat-debug]",
      JSON.stringify({
        stage: "conversation_persist_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
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
  userApiKey?: string;
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

    const client = createLLMClient({ apiKey: input.userApiKey });
    const enhanceCtx = getRequestContext();
    const model = getModelName("standard", client.provider, enhanceCtx?.modelOverride);
    const response = await client.createChatCompletion({
      model,
      messages: [
        { role: "system", content: ENHANCE_TASK_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Role: ${input.role}\n` +
            `Repo path: ${input.repoPath}\n` +
            `User task: ${input.task}\n\n` +
            `Relevant repository context:\n${resolvedRepoContext}`,
        },
      ],
    });

    return String(response.choices[0]?.message?.content ?? "").trim();
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

  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    detachDeveloperPatchProgressSseClient(runId, res);
  });
});

app.get("/api/run-status/:runId", (req, res) => {
  const runId = typeof req.params?.runId === "string" ? req.params.runId.trim() : "";
  if (!runId) {
    res.status(400).json({ ok: false, reason: "missing_run_id" });
    return;
  }
  const buf = getRunBuffer(runId);
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

app.get("/api/active-runs", async (req, res) => {
  const rawUserId =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  const userId =
    rawUserId || (process.env.NODE_ENV !== "production" ? "dev-user" : "");

  if (!userId) {
    res.status(401).json({
      ok: false,
      reason: "unauthorized",
      message: "Missing user session. Please open Zone from your dashboard.",
    });
    return;
  }

  try {
    const runs = await getActiveRunsByUser(userId);
    logger.info("[active-runs] poll, count=%d, staleCount=%d", runs.length, runs.filter((run) => run.status !== "running").length);
    debugLog("[resume-debug] /api/active-runs", {
      rawUserId: rawUserId || null,
      effectiveUserId: userId,
      count: runs.length,
      runIds: runs.map((run) => run.runId),
      statuses: runs.map((run) => ({ runId: run.runId, status: run.status })),
    });
    res.json(
      runs.map((run) => ({
        runId: run.runId,
        task: run.task,
        repoPath: run.repoPath,
        threadId: run.threadId,
        status: run.status,
        startedAt: run.startedAt,
        lastChangedFiles: run.lastChangedFiles,
        lastAddedFunctions: run.lastAddedFunctions,
      }))
    );
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "active_runs_lookup_failed",
    });
  }
});

app.get("/api/run-replay/:runId", (req, res) => {
  const runId = typeof req.params?.runId === "string" ? req.params.runId.trim() : "";
  if (!runId) {
    res.status(400).end();
    return;
  }
  const buf = getRunBuffer(runId);
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
  } catch {
    // ignore
  }

  // If still running, attach for live tail; otherwise close.
  if (buf.status !== "running") {
    try {
      res.end();
    } catch {}
    return;
  }

  attachDeveloperPatchProgressSseClient(runId, res);

  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    detachDeveloperPatchProgressSseClient(runId, res);
  });
});

app.post("/api/cancel", (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
  if (!runId) {
    res.status(400).json({ ok: false, reason: "missing_run_id" });
    return;
  }
  debugLog("[zone-cancel-trigger]", {
    runId,
    hasController: activePatchRunAbortControllers.has(runId),
    controllerCount: activePatchRunAbortControllers.size,
    timestamp: new Date().toISOString(),
  });
  const ac = activePatchRunAbortControllers.get(runId);
  if (!ac) {
    res.status(404).json({ ok: false, reason: "no_active_run" });
    return;
  }
  try {
    emitDeveloperPatchProgress(runId, {
      stage: "Cancelled",
      lifecycle: createAgentLifecycleEvent({
        type: "run_cancelled",
        message: "Run cancelled by user.",
        stage: "finalize",
      }),
    });
  } catch {
    // best-effort
  }
  closeDeveloperPatchProgressSseForRun(runId);
  try {
    // If a command or revision approval is pending, treat cancel as rejection.
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    clearTrustedCommandsForRun(runId);
  } catch {
    // best-effort
  }
  try {
    ac.abort();
  } catch {
    // ignore
  }
  debugLog("[zone-cancel-aborted]", {
    runId,
    signalState: ac?.signal?.aborted ?? null,
    timestamp: new Date().toISOString(),
  });
  activePatchRunAbortControllers.delete(runId);
  try {
    registerRunComplete(runId, "cancelled");
  } catch {}
  void completeActiveRun(runId, "cancelled").catch(() => undefined);
  res.json({ ok: true });
});

// Zone Undo Tur 2a: restore the snapshot captured at the end of a
// safe_to_apply run. Body: { repoPath: string }. Status codes:
//   200 → reverted; 400 → bad input; 404 → no snapshot; 410 → already undone.
app.post("/api/runs/:runId/undo", async (req, res) => {
  const runId = String(req.params.runId || "").trim();
  const repoPath =
    typeof req.body?.repoPath === "string" ? req.body.repoPath.trim() : "";
  if (!runId) {
    res.status(400).json({ error: "runId required" });
    return;
  }
  if (!repoPath) {
    res.status(400).json({ error: "repoPath required in body" });
    return;
  }
  try {
    const { restoreSnapshot } = await import("../snapshots/snapshotStore.js");
    const result = await restoreSnapshot(runId, repoPath);
    if (result.alreadyUndone) {
      res.status(410).json({
        error: "already undone",
        reverted: 0,
        files: [],
        alreadyUndone: true,
      });
      return;
    }
    res.json({
      reverted: result.reverted,
      files: result.files,
      alreadyUndone: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invalid runId")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      res.status(404).json({ error: "no snapshot for this run" });
      return;
    }
    errorLog("[zone-undo-error]", msg);
    res.status(500).json({ error: "undo failed", detail: msg });
  }
});

// Native OS folder-picker — returns the full filesystem path selected by the user.
// Uses PowerShell FolderBrowserDialog on Windows, osascript on macOS,
// zenity/kdialog on Linux. Falls back gracefully if none available.
app.post("/api/browse-folder", (_req, res) => {
  const platform = process.platform;
  let command: string;

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
  } else if (platform === "darwin") {
    command =
      "osascript -e 'POSIX path of (choose folder with prompt \"Select project folder\")'";
  } else {
    // Linux: prefer zenity, fall back to kdialog
    command =
      "zenity --file-selection --directory --title='Select project folder' 2>/dev/null ||" +
      " kdialog --getexistingdirectory \"$HOME\" 2>/dev/null";
  }

  try {
    const result = execSync(command, { encoding: "utf8", timeout: 120_000 }).trim();
    if (!result) {
      res.json({ ok: false, cancelled: true });
      return;
    }
    const parts = result.replace(/\\/g, "/").split("/").filter(Boolean);
    const name = parts[parts.length - 1] || result;
    res.json({ ok: true, path: result, name });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Exit code 1 from zenity/kdialog/osascript = user cancelled — not an error.
    if (/exit code 1|status 1|exited with code 1/i.test(msg)) {
      res.json({ ok: false, cancelled: true });
    } else {
      res.json({ ok: false, error: "Folder picker unavailable on this system" });
    }
  }
});

app.post("/api/approve-command", (req, res) => {
  const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const approved = action === "approve" || !!req.body?.approved;
  const trust = !!req.body?.trust;
  if (!approvalId || !runId) {
    res.status(400).json({ ok: false, reason: "missing_approval_id_or_run_id" });
    return;
  }
  if (action === "trust_all") {
    const r = resolveCommandApproval({ approvalId, approved: true, runId });
    if (!r.ok) {
      res.status(404).json({ ok: false, reason: r.message || "not_found" });
      return;
    }
    setTrustAllForRun(runId);
    res.json({ ok: true, action: "trust_all" });
    return;
  }
  const r = resolveCommandApproval({ approvalId, approved, runId, trust });
  if (!r.ok) {
    res.status(404).json({ ok: false, reason: r.message || "not_found" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/approve-revision", (req, res) => {
  const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId.trim() : "";
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
  const decision = typeof req.body?.decision === "string" ? req.body.decision.trim() : "";

  if (!revisionId || !runId) {
    res.status(400).json({ ok: false, reason: "missing_revision_id_or_run_id" });
    return;
  }
  if (!["approve", "reject"].includes(decision)) {
    res.status(400).json({ ok: false, reason: "invalid_decision" });
    return;
  }

  const r = resolveRevisionApproval({
    revisionId,
    runId,
    decision: decision as "approve" | "reject",
  });
  if (!r.ok) {
    res.status(404).json({ ok: false, reason: r.message || "not_found" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/run-command", async (req, res) => {
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

  const emitTerminalLine = (line: string, stream: "stdout" | "stderr") => {
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

  const emitDone = (exitCode: number) => {
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
  const child = exec(command, { cwd: repo, timeout: 30000, windowsHide: true, shell });

  const bufs: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const flush = (stream: "stdout" | "stderr") => {
    const s = bufs[stream];
    const parts = s.split(/\r?\n/);
    bufs[stream] = parts.pop() ?? "";
    for (const p of parts) {
      if (p.trim().length === 0) continue;
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
    closeDeveloperPatchProgressSseForRun(rid);
  });

  child.once("exit", (_code, signal) => {
    if (signal && String(signal).toLowerCase().includes("sigterm")) killedByTimeout = true;
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

// Usage-tracker Tur: BYOK estimated spend, sourced from per-iter token logs
// × pricing.ts. Local-only — no hosted-proxy fallback because each instance
// owns its own JSONL. period=month|all (default month).
app.get("/api/usage", async (req, res) => {
  const userIdRaw =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  const userId = userIdRaw || "local-dev";
  const periodRaw =
    typeof req.query.period === "string" ? req.query.period.trim() : "";
  const period: "day" | "week" | "month" | "all" =
    periodRaw === "all" || periodRaw === "day" || periodRaw === "week" || periodRaw === "month"
      ? periodRaw
      : "month";
  try {
    const usage = await getUsage(userId, period);
    res.json(usage);
  } catch (err) {
    errorLog("[zone] /api/usage failed", err);
    res.status(500).json({ ok: false, reason: "usage_read_failed" });
  }
});

// K.3 — /api/metrics endpoint.
// Keyed on "userId:period". TTL = 60 s.
const metricsCache = new Map<string, { result: ReturnType<typeof aggregateMetrics>; expiresAt: number }>();

/**
 * Build per-run summaries from raw UsageRecord JSONL.
 * Groups by runId, summing cost + cache tokens so each run appears once.
 * latencyMs and terminationReason come from the K.3.C3 terminal run-summary
 * record (model: "__run_summary__") appended by agentLoop on completion.
 */
function buildRunRecords(userId: string): RunRecord[] {
  const records = readRecords(userId);
  const runMap = new Map<string, {
    costUsd: number;
    cacheTokens: number;
    totalTokens: number;
    ts: number;
    latencyMs?: number;
    terminationReason?: string;
  }>();

  for (const r of records) {
    const key = r.runId || `__anon_${r.timestamp}`;
    const tokens =
      (r.input_uncached || 0) +
      (r.cache_write || 0) +
      (r.cache_read || 0) +
      (r.output || 0);
    const cacheTokens = r.cache_read || 0;
    const ts = new Date(r.timestamp).getTime();
    const existing = runMap.get(key);
    if (existing) {
      existing.costUsd += r.est_cost_usd || 0;
      existing.cacheTokens += cacheTokens;
      existing.totalTokens += tokens;
      if (!Number.isNaN(ts)) existing.ts = Math.min(existing.ts, ts);
      // Take from whichever record carries them (only the summary record will).
      if (r.latencyMs !== undefined) existing.latencyMs = r.latencyMs;
      if (r.terminationReason !== undefined) existing.terminationReason = r.terminationReason;
    } else {
      runMap.set(key, {
        costUsd: r.est_cost_usd || 0,
        cacheTokens,
        totalTokens: tokens,
        ts: Number.isNaN(ts) ? Date.now() : ts,
        latencyMs: r.latencyMs,
        terminationReason: r.terminationReason,
      });
    }
  }

  return Array.from(runMap.entries()).map(([runId, data]) => ({
    runId,
    costUsd: data.costUsd,
    cacheTokens: data.cacheTokens,
    totalTokens: data.totalTokens,
    ts: data.ts,
    latencyMs: data.latencyMs,
    terminationReason: data.terminationReason,
  }));
}

const METRICS_VALID_PERIODS = new Set<string>(["day", "week", "month"]);
const METRICS_CACHE_TTL_MS = 60_000;

// K.3: metrics scrape endpoint. Auth-gated when ADMIN_SECRET is configured;
// open in self-hosted mode (no ADMIN_SECRET) consistent with /api/usage.
app.get("/api/metrics", (req, res) => {
  const adminSecret =
    typeof process.env.ADMIN_SECRET === "string"
      ? process.env.ADMIN_SECRET.trim()
      : "";
  const providedSecret =
    typeof req.get("x-admin-secret") === "string"
      ? req.get("x-admin-secret")!.trim()
      : "";
  if (adminSecret && providedSecret !== adminSecret) {
    res.status(403).json({ ok: false, reason: "unauthorized" });
    return;
  }

  const periodRaw =
    typeof req.query.period === "string" ? req.query.period.trim() : "";
  if (periodRaw && !METRICS_VALID_PERIODS.has(periodRaw)) {
    res.status(400).json({ ok: false, reason: "invalid_period" });
    return;
  }
  const period = (METRICS_VALID_PERIODS.has(periodRaw) ? periodRaw : "day") as
    | "day"
    | "week"
    | "month";

  const userIdRaw =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  const userId = userIdRaw || "local-dev";

  const cacheKey = `${userId}:${period}`;
  const cached = metricsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.result);
    return;
  }

  try {
    const runs = buildRunRecords(userId);
    const result = aggregateMetrics({ userId, period, runs });
    metricsCache.set(cacheKey, { result, expiresAt: Date.now() + METRICS_CACHE_TTL_MS });
    res.json(result);
  } catch (err) {
    errorLog("[zone] /api/metrics failed", err);
    res.status(500).json({ ok: false, reason: "metrics_aggregation_failed" });
  }
});

// L.2: Prometheus text format endpoint. Auth mirrors /api/metrics (Pattern A).
// Reuses metricsCache — both /api/metrics (JSON) and this endpoint hit the same
// aggregation result within the 60 s TTL.
app.get("/api/metrics/prometheus", (req, res) => {
  const adminSecret =
    typeof process.env.ADMIN_SECRET === "string"
      ? process.env.ADMIN_SECRET.trim()
      : "";
  const providedSecret =
    typeof req.get("x-admin-secret") === "string"
      ? req.get("x-admin-secret")!.trim()
      : "";
  if (adminSecret && providedSecret !== adminSecret) {
    res.status(403).json({ ok: false, reason: "unauthorized" });
    return;
  }

  const periodRaw =
    typeof req.query.period === "string" ? req.query.period.trim() : "";
  if (periodRaw && !METRICS_VALID_PERIODS.has(periodRaw)) {
    res.status(400).json({ ok: false, reason: "invalid_period" });
    return;
  }
  const period = (METRICS_VALID_PERIODS.has(periodRaw) ? periodRaw : "day") as
    | "day"
    | "week"
    | "month";

  const userIdRaw =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  const userId = userIdRaw || "local-dev";

  const cacheKey = `${userId}:${period}`;
  const cached = metricsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(aggregatorToPrometheus(cached.result));
    return;
  }

  try {
    const runs = buildRunRecords(userId);
    const result = aggregateMetrics({ userId, period, runs });
    metricsCache.set(cacheKey, { result, expiresAt: Date.now() + METRICS_CACHE_TTL_MS });
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(aggregatorToPrometheus(result));
  } catch (err) {
    errorLog("[zone] /api/metrics/prometheus failed", err);
    res.status(500).json({ ok: false, reason: "metrics_aggregation_failed" });
  }
});

app.get("/api/sweep-results", (_req, res) => {
  try {
    res.json(buildDashboardData());
  } catch (err) {
    errorLog("[zone] /api/sweep-results failed", err);
    res.status(500).json({ ok: false, reason: "sweep_results_read_failed" });
  }
});

app.get("/api/usage-limits", (_req, res) => {
  res.json(loadLimitConfig());
});

app.put("/api/usage-limits", (req, res) => {
  const { dailyLimit, monthlyLimit } = req.body ?? {};
  const daily =
    dailyLimit === null || dailyLimit === undefined
      ? null
      : typeof dailyLimit === "number" && dailyLimit >= 0
        ? dailyLimit
        : null;
  const monthly =
    monthlyLimit === null || monthlyLimit === undefined
      ? null
      : typeof monthlyLimit === "number" && monthlyLimit >= 0
        ? monthlyLimit
        : null;
  try {
    saveLimitConfig({ dailyLimit: daily, monthlyLimit: monthly });
    res.json({ ok: true, dailyLimit: daily, monthlyLimit: monthly });
  } catch (err) {
    res.status(500).json({ ok: false, reason: "save_failed" });
  }
});

// Phase I.2: visual verification settings (dev server URL, viewport,
// auto-verify toggle). Persisted to ~/.zone/visual-verification.json. The
// devServerProbe cache is invalidated on save so the next verify_visual
// call picks up the new URL without needing a server restart.
app.get("/api/settings/visual-verification", (_req, res) => {
  try {
    const settings = loadVisualSettings();
    res.json({
      ok: true,
      settings,
      defaults: getVisualSettingsDefaults(),
      envOverride:
        typeof process.env.ZONE_DEV_SERVER_URL === "string" &&
        process.env.ZONE_DEV_SERVER_URL.trim()
          ? process.env.ZONE_DEV_SERVER_URL.trim()
          : null,
    });
  } catch (err) {
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/settings/visual-verification", (req, res) => {
  try {
    const { devServerBaseUrl, defaultViewport, autoVerifyAfterPatch } =
      req.body ?? {};
    const saved = saveVisualSettings({
      devServerBaseUrl,
      defaultViewport,
      autoVerifyAfterPatch,
    });
    invalidateDevServerCache();
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res
      .status(400)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase L.3: per-tier execution limit overrides. Persisted to
// ~/.zone/tier-limits.json. ZONE_FORCE_TIER env override always takes priority
// over these settings (testing bypass). taskToolAllowed is system-level and
// is not surfaced in the response — the UI must not expose it as editable.
app.get("/api/settings/tier-limits", (_req, res) => {
  try {
    const userOverrides = readTierSettings();
    const merged = (["simple", "medium", "complex"] as const).reduce(
      (acc, tier) => {
        const base = TIER_LIMITS[tier];
        const ov = userOverrides[tier] ?? {};
        acc[tier] = {
          taskToolAllowed: base.taskToolAllowed,
          maxSubagentCalls: ov.maxSubagentCalls ?? base.maxSubagentCalls,
          tokenBudgetCap: ov.tokenBudgetCap ?? base.tokenBudgetCap,
          iterCap: ov.iterCap ?? base.iterCap,
        };
        return acc;
      },
      {} as typeof TIER_LIMITS
    );
    res.json({ ok: true, settings: merged, defaults: TIER_LIMITS, userOverrides });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/settings/tier-limits", (req, res) => {
  try {
    const saved = writeTierSettings((req.body as { userOverrides?: unknown })?.userOverrides ?? {});
    res.json({ ok: true, userOverrides: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/settings/tier-limits/reset", (_req, res) => {
  try {
    writeTierSettings({});
    res.json({ ok: true, defaults: TIER_LIMITS });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/settings/scope-audit", (_req, res) => {
  try {
    res.json({ ok: true, autoAuditComplexTasks: readAutoAuditSetting() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/settings/scope-audit", (req, res) => {
  const value = req.body?.autoAuditComplexTasks;
  if (typeof value !== "boolean") {
    res.status(400).json({ ok: false, reason: "autoAuditComplexTasks must be a boolean" });
    return;
  }
  try {
    writeAutoAuditSetting(value);
    res.json({ ok: true, autoAuditComplexTasks: value });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase I.5: serve verify_visual / auto-verify screenshots back to the UI for
// inline thumbnails and the modal viewer. Files are written by runVerifyVisual
// to <cwd>/.zone/screenshots/<runId>-<timestamp>.png. The strict regex below
// is the primary path-traversal defense; the resolved-path containment check
// is defense-in-depth for any future filename mutation.
const SCREENSHOT_FILENAME_RE = /^[a-z0-9][a-z0-9_-]*\.png$/i;
app.get("/api/screenshots/:filename", (req, res) => {
  const filename = String(req.params.filename || "");
  if (!SCREENSHOT_FILENAME_RE.test(filename)) {
    res.status(400).json({ ok: false, error: "Invalid filename" });
    return;
  }
  const screenshotsDir = path.join(process.cwd(), ".zone", "screenshots");
  const fullPath = path.join(screenshotsDir, filename);
  if (!fullPath.startsWith(screenshotsDir + path.sep)) {
    res.status(400).json({ ok: false, error: "Invalid path" });
    return;
  }
  fs.access(fullPath, (err) => {
    if (err) {
      res.status(404).json({ ok: false, error: "Screenshot not found" });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(fullPath);
  });
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

// L.1: org policy read/write. Pattern B auth — secret always required (write endpoint,
// never open in self-hosted mode). policyLoader.validatePolicy is the single schema source.
app.get("/api/admin/policy", (req, res) => {
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

  const policyPath = process.env.ZONE_ORG_POLICY_PATH?.trim() ?? "";
  if (!policyPath) {
    res.json({ ok: true, policy: null, source: "absent" });
    return;
  }

  const result = loadOrgPolicy(policyPath);
  if (!result.ok) {
    if (result.reason === "missing_file") {
      res.json({ ok: true, policy: null, source: "missing_file" });
      return;
    }
    res.status(500).json({ ok: false, reason: result.reason, detail: result.detail });
    return;
  }
  res.json({ ok: true, policy: result.policy, source: result.source });
});

app.put("/api/admin/policy", (req, res) => {
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

  const policyPath = process.env.ZONE_ORG_POLICY_PATH?.trim() ?? "";
  if (!policyPath) {
    res.status(400).json({ ok: false, reason: "ZONE_ORG_POLICY_PATH_not_set" });
    return;
  }

  const validation = validatePolicy(req.body);
  if (!validation.valid) {
    res.status(400).json({ ok: false, reason: "schema_invalid", detail: validation.detail });
    return;
  }

  try {
    atomicWriteFileSync(policyPath, JSON.stringify(validation.policy, null, 2));
    res.json({ ok: true, policy: validation.policy, path: policyPath });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, reason: "write_failed", detail });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { task, repoPath, userId: rawUserId } = req.body ?? {};
  const userId =
    typeof rawUserId === "string" && rawUserId.trim()
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
  const result = await runAgent({ task, role: "developer" });
  res.json({
    decision: result.decision,
    risk: result.risk,
    confidence: result.confidence,
  });
});

app.post("/api/dev/index-repo", async (req, res) => {
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
  const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath.trim() : "";
  if (!repoPath) {
    res.status(400).json({ ok: false, reason: "repoPath is required" });
    return;
  }

  const startedAt = Date.now();
  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
    try {
      const repoFiles = await scanRepo(repoPath);
      const files = await Promise.all(
        repoFiles.map(async (file) => ({
          path: file.path,
          content: await readFile(file.absolutePath, "utf8").catch(() => ""),
        }))
      );
      const indexResult = await indexRepoFiles({
        repoPath,
        files: files.filter((file) => typeof file.content === "string" && file.content.length > 0),
      });
      res.json({
        ok: true,
        ...indexResult,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        reason: error instanceof Error ? error.message : "repo_index_failed",
      });
    }
  });
});

// Project memory: <repo>/.zone/memory.md, populated by the agent's update_memory tool.
app.get("/api/memory", async (req, res) => {
  const repo = String(req.query.repo ?? "").trim();
  if (!repo) {
    return res.status(400).json({ ok: false, error: "missing_repo" });
  }
  try {
    const { readMemory } = await import("../memory/projectMemory.js");
    const entries = await readMemory(repo);
    res.json({ ok: true, entries });
  } catch (err) {
    errorLog("[zone] /api/memory failed", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

app.delete("/api/memory/entry", async (req, res) => {
  const repo = String(req.query.repo ?? "").trim();
  const indexRaw = req.query.index;
  const index = Number.parseInt(String(indexRaw ?? ""), 10);
  if (!repo) {
    return res.status(400).json({ ok: false, error: "missing_repo" });
  }
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ ok: false, error: "missing_index" });
  }
  try {
    const { deleteMemoryEntry } = await import("../memory/projectMemory.js");
    const ok = await deleteMemoryEntry(repo, index);
    if (!ok) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    res.json({ ok: true });
  } catch (err) {
    errorLog("[zone] /api/memory/entry DELETE failed", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

app.get("/api/branches", async (req, res) => {
  const repo = String(req.query.repo ?? "").trim();
  if (!repo) {
    return res.status(400).json({ error: "missing_repo" });
  }
  try {
    const result = await listBranches(repo);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "internal",
      message: String((err as Error).message ?? err),
    });
  }
});

app.post("/api/branches/switch", async (req, res) => {
  const repo = String(req.body?.repo ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  if (!repo || !branch) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }
  try {
    const result = await switchBranch(repo, branch);
    if (result.ok) return res.json(result);
    const status =
      result.error === "uncommitted_changes"
        ? 409
        : result.error === "not_found"
        ? 404
        : result.error === "not_a_repo"
        ? 400
        : 500;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "internal",
      message: String((err as Error).message ?? err),
    });
  }
});

app.post("/api/branches/create", async (req, res) => {
  const repo = String(req.body?.repo ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const baseBranch = req.body?.baseBranch
    ? String(req.body.baseBranch).trim()
    : undefined;
  if (!repo || !name) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }
  try {
    const result = await createBranch(repo, name, baseBranch);
    if (result.ok) return res.json(result);
    const status =
      result.error === "invalid_name"
        ? 400
        : result.error === "exists"
        ? 409
        : result.error === "not_a_repo"
        ? 400
        : 500;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "internal",
      message: String((err as Error).message ?? err),
    });
  }
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

function shouldForceExecuteTask(task: string): boolean {
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

  return (
    agentLoopPatterns.some((re) => re.test(String(task || ""))) ||
    /\b(?:run|verify|install|build)\b/i.test(String(task || ""))
  );
}

function intentFromExplicitMode(mode: Exclude<Mode, "auto">): "execute" | "chat" | "investigation" {
  if (mode === "patch") return "execute";
  if (mode === "investigate") return "investigation";
  return "chat";
}

app.post("/api/classify-intent", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task : "";
  const normalizedTask = task.trim();
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);

  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
    const forcedExecute = shouldForceExecuteTask(normalizedTask);
    const messageType = forcedExecute
      ? "patch_request"
      : await detectMessageType(normalizedTask, userApiKey || undefined);
    const intent = forcedExecute
      ? "execute"
      : shouldUseInvestigationMode(normalizedTask, messageType)
        ? "investigation"
        : messageType === "patch_request"
          ? "execute"
          : "chat";

    res.json({
      ok: true,
      intent,
      messageType,
    });
  });
});

app.post("/api/chat", async (req, res) => {
  const perf = startZoneApiPerfRun("/api/chat");
  // BYOK: extract user-supplied LLM API key + provider + model overrides from request headers.
  const { apiKey: chatUserApiKey, provider: chatByokProvider, modelHigh: chatModelHigh, modelStandard: chatModelStandard } = getRequestContextFromHeaders(req);

  await withRequestContext({ userApiKey: chatUserApiKey || undefined, provider: chatByokProvider, modelOverride: { high: chatModelHigh, standard: chatModelStandard } }, async () => {
    const {
      task,
      repoPath,
      runId,
      userId: rawUserId,
      conversationId,
      threadId,
      lastChangedFiles: rawLastChangedFiles,
      attachments: rawAttachments,
    } = req.body ?? {};
    const lastChangedFiles = Array.isArray(rawLastChangedFiles)
      ? rawLastChangedFiles.filter(
          (x: unknown): x is string => typeof x === "string" && x.trim().length > 0
        )
      : undefined;

    const { validateAttachments } = await import("./imageUpload.js");
    const attachValidation = validateAttachments(rawAttachments);
    if (!attachValidation.ok) {
      perf.finish("bad request");
      res.status(400).json({ ok: false, reason: attachValidation.error });
      return;
    }
    const attachments = attachValidation.attachments;

    const userId =
      typeof rawUserId === "string" && rawUserId.trim()
        ? rawUserId.trim()
        : process.env.NODE_ENV !== "production"
          ? "dev-user"
          : null;
    const normalizedTask = typeof task === "string" ? task.trim() : "";
    const normalizedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
    const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";
    const threadIdStr =
      typeof threadId === "string" && threadId.trim()
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
    attachRunIdentity({ userId, runId: runIdStr });

    const authorization = await ensureRunAuthorized(userId, { billingMode: "hosted" });
    if (!authorization.allowed) {
      perf.finish("authorization blocked");
      res.status(authorization.status).json(authorization.body);
      return;
    }

    const _chatCapCheck = await routeCapGate(userId, runIdStr);
    if (!_chatCapCheck.allowed) {
      perf.finish("daily cap exceeded");
      res.status(429).json({
        ok: false,
        terminationReason: "daily_usd_cap_exceeded",
        userFacingMessage: _chatCapCheck.outcome.userFacingMessage,
        canResume: _chatCapCheck.outcome.canResume,
        resumeHint: _chatCapCheck.outcome.resumeHint,
      });
      return;
    }

    const forcedExecute = shouldForceExecuteTask(normalizedTask);
    const messageType = forcedExecute
      ? "patch_request"
      : await detectMessageType(normalizedTask, chatUserApiKey || undefined);
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
    const conversationalMessageType = messageType as "question" | "discussion";

    registerRunStart(runIdStr, { task: normalizedTask });
    const chatAbort = new AbortController();
    const _priorChatController = activePatchRunAbortControllers.get(runIdStr);
    if (_priorChatController) {
      console.warn(
        "[zone] duplicate runId on /api/chat — aborting previous controller before overwrite",
        JSON.stringify({ runId: runIdStr })
      );
      try { _priorChatController.abort(); } catch {}
    }
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
        lastChangedFiles,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      registerRunComplete(runIdStr, "completed");
      const chatCostUsd = getRunCost(userId, runIdStr);
      const chatResultWithCost = { ...(result as Record<string, unknown>), costUsd: chatCostUsd };
      emitDeveloperPatchProgress(runIdStr, {
        stage: "run_completed_with_result",
        progress: {
          runId: runIdStr,
          ts: Date.now(),
          type: "chat_response",
          title: result.chatResponse,
          status: "success",
          result: chatResultWithCost,
          costUsd: chatCostUsd,
        } as any,
      });
      perf.finish("complete");
      res.json(chatResultWithCost);
    } catch (error) {
      registerRunComplete(runIdStr, "cancelled");
      perf.finish("error");
      res.status(500).json({
        ok: false,
        reason: error instanceof Error ? error.message : "chat_flow_failed",
      });
    } finally {
      activePatchRunAbortControllers.delete(runIdStr);
      try {
        const { killAllForRun } = await import(
          "../tools/backgroundProcessRegistry.js"
        );
        await killAllForRun(runIdStr);
      } catch {
        // best-effort, orchestrator hook is primary
      }
    }
  });
});

app.post("/api/investigate", async (req, res) => {
  const perf = startZoneApiPerfRun("/api/investigate");
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } =
    getRequestContextFromHeaders(req);
  await withRequestContext(
    { userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } },
    async () => {
      const { task, repoPath, runId, userId: rawUserId, conversationId } = req.body ?? {};
      const userId =
        typeof rawUserId === "string" && rawUserId.trim()
          ? rawUserId.trim()
          : process.env.NODE_ENV !== "production"
            ? "dev-user"
            : null;
      const normalizedTask = typeof task === "string" ? task.trim() : "";
      const normalizedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
      const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";

      if (!normalizedTask || !normalizedRepoPath) {
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
      attachRunIdentity({ userId, runId: runIdStr });

      const authorization = await ensureRunAuthorized(userId, { billingMode: "hosted" });
      if (!authorization.allowed) {
        perf.finish("authorization blocked");
        res.status(authorization.status).json(authorization.body);
        return;
      }

      const _investigateCapCheck = await routeCapGate(userId, runIdStr);
      if (!_investigateCapCheck.allowed) {
        perf.finish("daily cap exceeded");
        res.status(429).json({
          ok: false,
          terminationReason: "daily_usd_cap_exceeded",
          userFacingMessage: _investigateCapCheck.outcome.userFacingMessage,
          canResume: _investigateCapCheck.outcome.canResume,
          resumeHint: _investigateCapCheck.outcome.resumeHint,
        });
        return;
      }

      let investigateAbort: AbortController | null = null;
      if (runIdStr) {
        investigateAbort = new AbortController();
        activePatchRunAbortControllers.set(runIdStr, investigateAbort);
        try { registerRunStart(runIdStr, { task: normalizedTask }); } catch {}
      }

      try {
        const result = await runInvestigationFlow({
          task: normalizedTask,
          repoPath: normalizedRepoPath,
          mode: "investigate",
          runId: runIdStr,
          userId,
          userApiKey: userApiKey || undefined,
          abortSignal: investigateAbort?.signal,
          onProgress: (update) => emitProgress(runIdStr, update as any),
        });
        if (runIdStr) registerRunComplete(runIdStr, "completed");
        const costUsd = runIdStr ? getRunCost(userId, runIdStr) : 0;
        await logRun({
          userId,
          role: "developer",
          task: normalizedTask,
          repoPath: normalizedRepoPath,
          decisionMode: "investigation",
          confidence: 80,
          executionId: runIdStr || undefined,
          creditsUsed: 1,
          conversationId: typeof conversationId === "string" ? conversationId : runIdStr,
          changedFiles: [],
          billingMode: "hosted",
          routeName: "/api/investigate",
        }).catch(() => null);
        perf.finish("complete");
        res.json({ ...(result as Record<string, unknown>), costUsd });
      } catch (error) {
        if (runIdStr) registerRunComplete(runIdStr, "cancelled");
        perf.finish("error");
        res.status(500).json({
          ok: false,
          reason: error instanceof Error ? error.message : "investigation_failed",
        });
      } finally {
        if (runIdStr) activePatchRunAbortControllers.delete(runIdStr);
      }
    }
  );
});

app.post("/api/patch", async (req, res) => {
  const perf = startZoneApiPerfRun("/api/patch");
  perf.mark("route entered");
  const patchHandlerStartedAt = Date.now();
  debugLog("[zone-route-trigger] /api/patch invoked", {
    runId: req.body?.runId,
    threadId: req.body?.threadId ?? req.body?.conversationId,
    hasResumePayload: !!(req.body?.resumeFromCommandResult ?? req.body?.resumeData),
    taskPreview: typeof req.body?.task === "string" ? req.body.task.slice(0, 80) : null,
    timestamp: new Date().toISOString(),
    ip: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 80) : null,
    referer: typeof req.headers.referer === "string" ? req.headers.referer.slice(0, 120) : null,
  });
  const billingMode = "hosted";
  // BYOK: extract user-supplied OpenAI API key from the custom request header.
  // This header is set by the browser when the user has configured their own key in Settings.
  // The key is NEVER logged — only the source ("user" vs "env") is recorded inside createOpenAIClient.
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
  // When the user provides their own key, skip the hosted-proxy path and run locally with that key.
  if (!userApiKey && shouldProxyHostedRequest(req, "/api/patch")) {
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

  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
  const {
    task,
    repoPath,
    runId,
    userId: rawUserId,
    hostedContext: hostedContextFromBody,
    conversationId,
    lastChangedFiles,
    lastAddedFunctions,
    forceTier: rawForceTier,
    mode: rawMode,
  } = req.body ?? {};
  const autoApproveRevisions: boolean = req.body?.autoApproveRevisions === true;
  const revisionApprovalTimeoutMsOverride: number | undefined = (() => {
    const raw = req.body?.revisionApprovalTimeoutMs;
    return typeof raw === "number" && raw > 0 ? raw : undefined;
  })();

  const requestedMode = rawMode == null ? "auto" : parseMode(rawMode);
  if (!requestedMode) {
    perf.finish("bad request");
    res.status(400).json({
      ok: false,
      reason: "invalid_mode",
      message: `mode must be one of ${MODES.join(", ")}`,
    });
    return;
  }
  const VALID_TIERS = ["simple", "medium", "complex"] as const;
  const forceTier = typeof rawForceTier === "string" && (VALID_TIERS as readonly string[]).includes(rawForceTier)
    ? (rawForceTier as "simple" | "medium" | "complex")
    : undefined;
  debugLog("[debug-mem] received lastChangedFiles:", lastChangedFiles);
  const hostedContext =
    process.env.NODE_ENV === "production"
      ? hostedContextFromBody
      : hostedDeveloperContextRequestHasFiles(hostedContextFromBody)
        ? hostedContextFromBody
        : undefined;
  const userId =
    typeof rawUserId === "string" && rawUserId.trim()
      ? rawUserId.trim()
      : process.env.NODE_ENV !== "production"
        ? "dev-user"
        : null;
  perf.mark("request normalized");
  logger.info(
    "[patch-handler] received: threadId=%s, runId=%s, ts=%s",
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : typeof runId === "string" && runId.trim()
        ? runId.trim()
        : "",
    typeof runId === "string" && runId.trim() ? runId.trim() : "",
    new Date(patchHandlerStartedAt).toISOString()
  );

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

  // Pre-register the run buffer BEFORE detectIntent (async LLM call, 300–1500 ms)
  // so the SSE /api/run-replay/:runId endpoint can accept connections during
  // intent detection. The frontend opens SSE before POSTing, gets a 404, then
  // retries once after 600 ms. If detectIntent takes >600 ms (always true for
  // investigation tasks, which are never short-circuited by shouldForceExecute)
  // the retry also 404s and SSE is permanently abandoned for this run, causing
  // the "frozen UI" bug. registerRunStart is idempotent for running buffers.
  const _preRunId = typeof runId === "string" && runId.trim() ? runId.trim() : "";
  if (_preRunId) {
    try {
      registerRunStart(_preRunId, { task: typeof task === "string" ? task.trim() : undefined });
    } catch {}
  }

  const _patchCapCheck = await routeCapGate(userId, typeof runId === "string" && runId.trim() ? runId.trim() : undefined);
  if (!_patchCapCheck.allowed) {
    perf.finish("daily cap exceeded");
    res.status(429).json({
      ok: false,
      terminationReason: "daily_usd_cap_exceeded",
      userFacingMessage: _patchCapCheck.outcome.userFacingMessage,
      canResume: _patchCapCheck.outcome.canResume,
      resumeHint: _patchCapCheck.outcome.resumeHint,
    });
    return;
  }

  // Usage limit check — block new runs if the user has exceeded their daily or monthly threshold.
  try {
    const [dayUsage, monthUsage] = await Promise.all([
      getUsage(userId ?? "local-dev", "day"),
      getUsage(userId ?? "local-dev", "month"),
    ]);
    const limitCheck = checkUsageLimit({
      today: dayUsage.totalCostUsd,
      thisMonth: monthUsage.totalCostUsd,
    });
    if (limitCheck.blocked) {
      perf.finish("usage limit exceeded");
      res.status(429).json({
        ok: false,
        error: "usage_limit_exceeded",
        reason: limitCheck.reason,
        limit: limitCheck.limit,
        used: limitCheck.used,
      });
      return;
    }
  } catch {
    // Non-blocking: if limit check fails (e.g. disk error), allow the run.
  }

  const intent =
    requestedMode === "auto"
      ? shouldForceExecute
        ? "execute"
        : await detectIntent(String(task), userApiKey || undefined)
      : intentFromExplicitMode(requestedMode);
  if (intent === "investigation") {
    const investigationRunId =
      typeof runId === "string" && runId.trim() ? runId.trim() : "";
    const threadIdForInvestigation =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : investigationRunId;
    let investigationAbort: AbortController | null = null;
    if (investigationRunId) {
      investigationAbort = new AbortController();
      activePatchRunAbortControllers.set(investigationRunId, investigationAbort);
      try {
        registerRunStart(investigationRunId, { task: String(task) });
      } catch {}
      try {
        await upsertActiveRun(investigationRunId, {
          userId,
          threadId: threadIdForInvestigation,
          conversationId: threadIdForInvestigation,
          repoPath: String(repoPath),
          task: String(task),
          status: "running",
          lastChangedFiles: Array.isArray(lastChangedFiles) ? lastChangedFiles : null,
          lastAddedFunctions: Array.isArray(lastAddedFunctions) ? lastAddedFunctions : null,
        });
      } catch (error) {
        console.warn(
          "[zone] investigation active run upsert failed",
          error instanceof Error ? error.message : String(error)
        );
      }
      emitProgress(investigationRunId, {
        stage: "investigation",
        lifecycle: createAgentLifecycleEvent({
          type: "run_started",
          message: "Investigation started.",
          stage: "init",
          status: "active",
        }),
      });
    }
    // TODO: extend plan-first to investigate mode after Phase D investigation flow consolidates plan generation
    // runInvestigationFlow has its own handler and no preGeneratedPlan input; integration is non-trivial.
    try {
      const result = await runInvestigationFlow({
        task: String(task),
        repoPath: String(repoPath),
        mode: requestedMode === "investigate" ? "investigate" : undefined,
        runId: investigationRunId,
        userId,
        userApiKey: userApiKey || undefined,
        abortSignal: investigationAbort?.signal,
        onProgress: (update) => emitProgress(investigationRunId, update as any),
      });
      if (investigationRunId) {
        registerRunComplete(investigationRunId, "completed");
        try {
          await completeActiveRun(investigationRunId, "completed");
        } catch {}
      }
      const confidence = 80;
      const loggedConversationId = await logRun({
        userId,
        role: "developer",
        task: String(task),
        repoPath: String(repoPath),
        decisionMode: "investigation",
        confidence,
        executionId: investigationRunId || undefined,
        creditsUsed: 1,
        conversationId,
        changedFiles: [],
        billingMode,
        routeName: "/api/patch",
      }).catch(() => null);
      if (loggedConversationId) {
        (result as Record<string, unknown>).conversationId = loggedConversationId;
      }
      const costUsd = investigationRunId ? getRunCost(userId ?? "", investigationRunId) : 0;
      const resultWithCost = { ...(result as Record<string, unknown>), costUsd };
      if (investigationRunId) {
        emitProgress(investigationRunId, {
          stage: "investigation",
          lifecycle: createAgentLifecycleEvent({
            type: "run_completed",
            message: "Investigation completed.",
            stage: "finalize",
            status: "success",
          }),
          progress: {
            type: "run_completed_with_result",
            title: "Investigation completed",
            status: "success",
            result: resultWithCost,
          } as any,
        });
      }
      perf.finish("investigation response sent");
      res.json(resultWithCost);
      return;
    } catch (error) {
      if (investigationRunId) {
        registerRunComplete(investigationRunId, "cancelled");
        try {
          await completeActiveRun(investigationRunId, "cancelled");
        } catch {}
      }
      perf.finish("investigation failed");
      res.status(500).json({
        ok: false,
        reason: error instanceof Error ? error.message : "investigation_flow_failed",
      });
      return;
    } finally {
      if (investigationRunId) activePatchRunAbortControllers.delete(investigationRunId);
    }
  }
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
    } catch {}

    const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim() : "";
    attachRunIdentity({ userId: userId ?? "local-dev", runId: runIdStr });
    const messageType =
      requestedMode === "auto"
        ? await detectMessageType(String(task), userApiKey || undefined)
        : "question";
    const conversationalMessageType =
      messageType === "discussion" ? "discussion" : "question";
    try {
      if (runIdStr) {
        registerRunStart(runIdStr, { task: String(task) });
      }
      const result =
        requestedMode === "chat"
          ? {
              ...(await runChatAgentFlow({
                task: String(task),
                repoPath: String(repoPath),
                runId: runIdStr,
                userId,
                userApiKey: userApiKey || undefined,
                onProgress: (update) => emitProgress(runIdStr, update as any),
              })),
              messageType: conversationalMessageType,
              conversationId:
                typeof conversationId === "string" && conversationId.trim()
                  ? conversationId.trim()
                  : runIdStr,
            }
          : await runConversationalFlow({
              task: String(task),
              repoPath: String(repoPath),
              runId: runIdStr,
              userId,
              conversationId:
                typeof conversationId === "string" && conversationId.trim()
                  ? conversationId.trim()
                  : runIdStr,
              messageType: conversationalMessageType,
              lastChangedFiles: Array.isArray(lastChangedFiles) ? lastChangedFiles : undefined,
            });
      if (runIdStr) {
        registerRunComplete(runIdStr, "completed");
        const detectedChatCost = getRunCost(userId ?? "", runIdStr);
        const detectedChatResultWithCost = { ...(result as Record<string, unknown>), costUsd: detectedChatCost };
        emitDeveloperPatchProgress(runIdStr, {
          stage: "run_completed_with_result",
          progress: {
            runId: runIdStr,
            ts: Date.now(),
            type: "chat_response",
            title: result.chatResponse,
            status: "success",
            result: detectedChatResultWithCost,
            costUsd: detectedChatCost,
          } as any,
        });
        perf.finish("chat response sent");
        res.json(detectedChatResultWithCost);
        return;
      }
      perf.finish("chat response sent");
      res.json(result);
      return;
    } catch (error) {
      if (runIdStr) {
        registerRunComplete(runIdStr, "cancelled");
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
  const threadIdForRun =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : runIdStr;
  try {
    const existingRuns = await getActiveRunsByUser(userId);
    const existingRun = existingRuns.find(
      (run) =>
        run.runId !== runIdStr &&
        run.threadId === threadIdForRun &&
        (run.status === "running" || run.status === "interrupted")
    );
    logger.info(
      "[patch-handler] active-run check: existingRunId=%s, blocked=%s, threadId=%s",
      existingRun?.runId ?? "",
      "false",
      threadIdForRun
    );
  } catch (error) {
    logger.info(
      "[patch-handler] active-run check: existingRunId=%s, blocked=%s, threadId=%s",
      "",
      "false",
      threadIdForRun
    );
    console.warn(
      "[zone] active run diagnostic lookup failed",
      error instanceof Error ? error.message : String(error)
    );
  }
  let patchAbort: AbortController | null = null;
  if (runIdStr) {
    patchAbort = new AbortController();
    const _priorPatchController = activePatchRunAbortControllers.get(runIdStr);
    if (_priorPatchController) {
      console.warn(
        "[zone] duplicate runId on /api/patch — aborting previous controller before overwrite",
        JSON.stringify({ runId: runIdStr })
      );
      try { _priorPatchController.abort(); } catch {}
    }
    activePatchRunAbortControllers.set(runIdStr, patchAbort);
    try {
      registerRunStart(runIdStr, { task: typeof task === "string" ? task : undefined });
    } catch {}
    try {
      await upsertActiveRun(runIdStr, {
        userId,
        threadId: threadIdForRun,
        conversationId:
          typeof conversationId === "string" && conversationId.trim()
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
      debugLog("[resume-debug] upsertActiveRun running", {
        runId: runIdStr,
        userId,
        threadId: threadIdForRun,
        repoPath: String(repoPath),
        task: String(task),
      });
    } catch (error) {
      console.warn(
        "[zone] active run upsert failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  let preGeneratedPlan: Awaited<ReturnType<typeof generateExecutionPlan>> | undefined;
  let planContext: Awaited<ReturnType<typeof preparePlanContext>> | undefined;
  if (runIdStr) {
    try {
      planContext = await preparePlanContext({
        task: String(task),
        repoPath: String(repoPath),
        repoSummaryOverride: (hostedContext as { repoSummary?: string } | undefined)?.repoSummary,
        userApiKey: userApiKey || undefined,
      });
      preGeneratedPlan = await generateExecutionPlan({
        task: String(task),
        repoSummary: planContext.projectSummary,
        relevantFiles: planContext.relevantFilePaths,
        userApiKey: userApiKey || undefined,
        provider: byokProvider,
      });
      const _planSummaryFiles = Array.from(
        new Set(preGeneratedPlan.steps.flatMap((s) => s.filesLikely ?? []))
      );
      emitProgress(runIdStr, {
        stage: "plan_summary",
        progress: {
          type: "plan_summary",
          title: "Plan generated",
          detail: preGeneratedPlan.objective,
          status: "success",
          planSummaryFiles: _planSummaryFiles,
          planSummaryStepCount: preGeneratedPlan.steps.length,
          // TODO: payload type cleanup — runId/ts injected by emitProgress wrapper
        } as any,
      });
    } catch (planGenErr) {
      console.warn(
        "[zone-plan] plan generation failed:",
        planGenErr instanceof Error ? planGenErr.message : String(planGenErr)
      );
      // preGeneratedPlan remains undefined — approval and audit gates will skip.
    }
  }
  // Y.1.2: headless detection — no Accept:text/event-stream header means no SSE listener.
  const isHeadless: boolean = !(
    typeof req.headers["accept"] === "string" &&
    req.headers["accept"].includes("text/event-stream")
  );
  console.log("[api-patch-request-params]", JSON.stringify({
    runId: runIdStr,
    threadId: typeof conversationId === "string" ? conversationId.trim() : "",
    autoApproveRevisions: !!autoApproveRevisions,
    headless: isHeadless,
    ts: new Date().toISOString(),
  }));
  // Y.1.1/Y.1.2: set to a non-null value when revision approval times out; causes
  // early res.json() before runLlmPatchFlow so the caller isn't left hanging.
  let revisionEarlyExit: { terminationReason: string; proposal: RevisionProposal; revisionId: string } | null = null;

  // Scope audit gate — fires when shouldRunAudit returns true.
  let preClassifiedTask: TaskClassification | undefined;
  // Phase X.0.1: captured when audit ran without skipping; forwarded to execute agent.
  let auditFindingsForExec: { summary: string; citationCount: number; toolCallCount: number; costUsd: number } | undefined;
  if (runIdStr) {
    try {
      // Classify task here so tier is available for audit gating AND to
      // avoid a second classification call inside runLlmPatchFlow.
      preClassifiedTask = await classifyTask(String(task), { userApiKey: userApiKey || undefined });
    } catch {
      // classifyTask is self-healing; defensive catch for future contract changes.
    }

    const autoAuditComplexTasks = readAutoAuditSetting();
    const tier = preClassifiedTask?.tier ?? "medium";

    function shouldRunAudit(
      t: typeof tier,
      perRunOverride: boolean | undefined,
      autoAuditSetting: boolean
    ): boolean {
      if (t === "simple") return false;
      if (perRunOverride === false) return false;
      return autoAuditSetting;
    }

    if (shouldRunAudit(tier, undefined, autoAuditComplexTasks)) {
      if (!preGeneratedPlan) {
        // Defensive: plan generation failed upstream — audit cannot run without a plan.
        log("[zone-audit-skipped]", JSON.stringify({ runId: runIdStr, reason: "no_plan", ts: new Date().toISOString() }));
      } else {
        try {
        emitProgress(runIdStr, {
          stage: "scope_revision",
          progress: {
            runId: runIdStr,
            ts: Date.now(),
            type: "scope_audit_started",
            title: "Auditing plan scope",
            status: "active",
          } as any,
        });

        const findings = await investigateScope({
          repoPath: String(repoPath),
          query: `Audit whether this plan is correctly scoped for the task:\n\n${String(task)}\n\nPlan:\n${preGeneratedPlan.objective}\nSteps: ${preGeneratedPlan.steps.map((s) => s.title).join(", ")}`,
          runId: runIdStr,
          userApiKey: userApiKey || undefined,
          abortSignal: patchAbort?.signal,
          parentTier: tier,
          onProgress: (update) => emitProgress(runIdStr, update as any),
        });

        if (findings.skipped) {
          emitProgress(runIdStr, {
            stage: "scope_revision",
            progress: {
              runId: runIdStr,
              ts: Date.now(),
              type: "scope_audit_skipped",
              title: "Scope audit skipped",
              skipReason: findings.skipReason,
              status: "warning",
            } as any,
          });
        } else {
          // X.0.1: capture for handoff to execute agent.
          auditFindingsForExec = {
            summary: findings.findings.slice(0, 2048),
            citationCount: findings.citations.length,
            toolCallCount: findings.toolCallCount,
            costUsd: findings.costUsd,
          };
          // Check if agent directly proposed a revision
          const agentRevision = findings.agentSuggestedRevision;
          // Also run the LLM judge on the findings
          const judgement = await runScopeJudge({
            originalPlan: preGeneratedPlan,
            findings: findings.findings,
            taskClassification: preClassifiedTask,
            runId: runIdStr,
            userApiKey: userApiKey || undefined,
          });

          const hasMismatch = agentRevision != null || judgement.mismatch;
          if (hasMismatch) {
            const revType = agentRevision?.type ?? judgement.type as "under_scope" | "over_scope" | "mixed";
            const revReason = agentRevision?.reason ?? judgement.reason;
            const revSummary = agentRevision?.revisedPlanSummary ?? judgement.revisedPlan ?? "Revised plan — see reason above.";
            const revMissing = agentRevision?.missingFiles ?? judgement.missingFiles;
            const revUnnecessary = agentRevision?.unnecessaryFiles ?? judgement.unnecessaryFiles;

            // Y.0 decision matrix (2×2 on planReview × severity):
            //   planReview=true  + any mismatch → requestRevisionApproval (interrupt)
            //   planReview=false + major        → requestRevisionApproval (interrupt)
            //   planReview=false + minor        → silent auto_apply (no user prompt)
            // Agent-suggested revisions always count as major (no severity field on agent tool).
            const mismatchSeverity: "minor" | "major" = agentRevision != null
              ? "major"
              : judgement.severity === "minor" ? "minor" : "major";
            const requiresInterrupt = mismatchSeverity === "major";

            if (requiresInterrupt) {
              const proposal: RevisionProposal = {
                runId: runIdStr,
                type: revType,
                reason: revReason,
                originalPlan: preGeneratedPlan.objective,
                revisedPlanSummary: revSummary,
                ...(revMissing ? { missingFiles: revMissing } : {}),
                ...(revUnnecessary ? { unnecessaryFiles: revUnnecessary } : {}),
              };

              const { decision, revisionId: approvalRevisionId } = await requestRevisionApproval({
                proposal,
                emit: (evt) =>
                  emitProgress(runIdStr, {
                    stage: "scope_revision",
                    progress: { ...evt, ts: Date.now() } as any,
                  }),
                abortSignal: patchAbort?.signal,
                autoApprove: autoApproveRevisions,
                timeoutMs: revisionApprovalTimeoutMsOverride ?? (isHeadless ? 30_000 : 10 * 60 * 1000),
              });

              if (decision === "timeout") {
                // Y.1.2: headless timeout — record for early exit, skip patch flow.
                revisionEarlyExit = { terminationReason: "revision_approval_timeout", proposal, revisionId: approvalRevisionId };
                log("[scope-revision-timeout]", JSON.stringify({
                  runId: runIdStr,
                  revisionId: approvalRevisionId,
                  timeoutMs: revisionApprovalTimeoutMsOverride ?? (isHeadless ? 30_000 : 10 * 60 * 1000),
                  timeoutSource: revisionApprovalTimeoutMsOverride ? "explicit_override" : isHeadless ? "headless_default" : "ui_default",
                  ts: new Date().toISOString(),
                }));
              } else if (decision === "approve") {
                if (autoApproveRevisions) {
                  log("[scope-revision-auto-approved]", JSON.stringify({ runId: runIdStr, type: revType, revisionId: approvalRevisionId, reason: "headless_autoapprove", ts: new Date().toISOString() }));
                } else {
                  log("[zone-scope-revision-approved]", JSON.stringify({ runId: runIdStr, type: revType, ts: new Date().toISOString() }));
                }
                emitProgress(runIdStr, {
                  stage: "scope_revision",
                  progress: {
                    runId: runIdStr,
                    ts: Date.now(),
                    type: "scope_revision_resolved",
                    title: "Scope revision approved",
                    revisionDecision: "approve",
                    status: "success",
                  } as any,
                });
                // Note: revised plan summary is informational; the agent loop
                // will re-plan from scratch using the updated context.
              } else {
                log("[zone-scope-revision-rejected]", JSON.stringify({ runId: runIdStr, type: revType, ts: new Date().toISOString() }));
                emitProgress(runIdStr, {
                  stage: "scope_revision",
                  progress: {
                    runId: runIdStr,
                    ts: Date.now(),
                    type: "scope_revision_resolved",
                    title: "Scope revision rejected — proceeding with original plan",
                    revisionDecision: "reject",
                    status: "active",
                  } as any,
                });
              }
            } else {
              // Minor mismatch + plan-review-off → silent auto-apply.
              log("[zone-scope-auto-apply]", JSON.stringify({ runId: runIdStr, type: revType, severity: "minor", ts: new Date().toISOString() }));
              emitProgress(runIdStr, {
                stage: "scope_revision",
                progress: {
                  runId: runIdStr,
                  ts: Date.now(),
                  type: "scope_revision_resolved",
                  title: "Scope revision auto-applied (minor)",
                  revisionDecision: "auto_apply",
                  status: "success",
                } as any,
              });
            }
          }

          if (!revisionEarlyExit) {
            emitProgress(runIdStr, {
              stage: "scope_revision",
              progress: {
                runId: runIdStr,
                ts: Date.now(),
                type: "scope_audit_completed",
                title: "Scope audit complete",
                status: "success",
              } as any,
            });
          }
        }
        } catch (auditErr) {
          // Audit failures never block execution — log and continue.
          console.warn("[zone-scope-audit] audit gate failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
        }
      } // end else (preGeneratedPlan guard)
    }
  }

  // Y.1.2: revision approval timed out — return before patch flow so headless
  // callers receive a response instead of waiting indefinitely.
  if (revisionEarlyExit) {
    const earlyOutcome = getPatchUserFacingReason({ terminationReason: revisionEarlyExit.terminationReason });
    res.json({
      ok: true,
      terminationReason: revisionEarlyExit.terminationReason,
      userFacingMessage: earlyOutcome.userFacingMessage,
      canResume: earlyOutcome.canResume,
      resumeHint: earlyOutcome.resumeHint,
      revisionId: revisionEarlyExit.revisionId,
      revisionProposal: revisionEarlyExit.proposal,
    });
    return;
  }

  try {
    logger.info(
      "[patch-handler] reached planner, ms since entry=%d",
      Date.now() - patchHandlerStartedAt
    );
    const result = await runLlmPatchFlow({
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
      provider: byokProvider,
      mode: requestedMode === "patch" ? "patch" : undefined,
      preGeneratedPlan,
      forceTier,
      preClassifiedTask,
      auditFindings: auditFindingsForExec,
    });
    perf.mark("core patch flow complete");

    // Best-effort: extract newly added function names from added diff lines.
    try {
      const diffs = Array.isArray((result as { fileDiffs?: unknown }).fileDiffs)
        ? ((result as { fileDiffs?: Array<{ diff?: unknown }> }).fileDiffs || [])
        : [];
      const addedLines: string[] = [];
      for (const fd of diffs) {
        const lines = Array.isArray(fd?.diff) ? (fd!.diff as Array<{ type?: unknown; content?: unknown }>) : [];
        for (const l of lines) {
          if (l && l.type === "added" && typeof l.content === "string") {
            addedLines.push(l.content);
          }
        }
      }
      const names = new Set<string>();
      const patterns: RegExp[] = [
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
      (result as Record<string, unknown>).addedFunctions = Array.from(names).slice(0, 10);
    } catch {}

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
        try {
          if (runIdStr) {
            await completeActiveRun(runIdStr, "cancelled");
          }
        } catch (error) {
          console.warn(
            "[zone] active run validation cleanup failed",
            error instanceof Error ? error.message : String(error)
          );
        }
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

      debugLog("[zone-billing-debug] execution success reached", {
        routeName: "/api/patch",
        userId: typeof userId === "string" ? userId.trim() : null,
        billingMode: billingMode ?? null,
      });

      const loggedConversationId = await logRun({
        userId,
        role: "developer",
        task,
        repoPath,
        decisionMode: getDecisionModeFromResult(
          result as Record<string, unknown>,
          confidence
        ),
        confidence,
        executionId: typeof runId === "string" ? runId : undefined,
        creditsUsed: 1,
        conversationId,
        changedFiles: Array.isArray((result as { applyPatches?: unknown }).applyPatches)
          ? ((result as { applyPatches?: Array<{ filePath?: unknown }> }).applyPatches || [])
              .map((p) => String(p?.filePath ?? "").trim())
              .filter(Boolean)
          : Array.isArray((result as { fileDiffs?: unknown }).fileDiffs)
            ? ((result as { fileDiffs?: Array<{ filePath?: unknown }> }).fileDiffs || [])
                .map((d) => String(d?.filePath ?? "").trim())
                .filter(Boolean)
            : [],
        billingMode,
        routeName: "/api/patch",
        // J.5: forward the loop summary so runLogging can persist the
        // APPLY_ROLLED_BACK marker on rollback runs. Skipped server-side
        // for non-rollback decisionModes.
        agentSummary:
          typeof (result as { patchPreview?: unknown }).patchPreview === "string"
            ? ((result as { patchPreview?: string }).patchPreview as string)
            : undefined,
      }).catch(() => null);

      if (loggedConversationId) {
        (result as Record<string, unknown>).conversationId = loggedConversationId;
      }
      perf.mark("successful accounting complete");
    }

    perf.mark("response ready");
    perf.finish("complete");
    logger.info(
      "[patch-handler] dispatched runId=%s, total ms=%d",
      runIdStr,
      Date.now() - patchHandlerStartedAt
    );
    try {
      if (runIdStr) registerRunComplete(runIdStr, "completed");
    } catch {}
    try {
      if (runIdStr) {
        await completeActiveRun(runIdStr, "completed");
      }
    } catch (error) {
      console.warn(
        "[zone] active run complete failed",
        error instanceof Error ? error.message : String(error)
      );
    }
    // After refresh, the original HTTP response is orphaned. Emit the final result via SSE too.
    const finalCostUsd = runIdStr ? getRunCost(userId ?? "", runIdStr) : 0;
    const resultWithCost = { ...(result as Record<string, unknown>), costUsd: finalCostUsd };
    // Phase J.4: full internal context preserved for [zone-patch-result] log
    // (debug observability), public response strips heuristic-only fields.
    const publicResultWithCost = toPublicLlmPatchResponse(resultWithCost);
    const _resultRecord = resultWithCost as Record<string, unknown>;
    debugLog("[zone-patch-result]", JSON.stringify({
      runId: runIdStr || null,
      decisionMode: _resultRecord.decisionMode,
      verificationReason: _resultRecord.verificationReason,
      developerConfidence: _resultRecord.developerConfidence,
      tokenBudgetExceeded: _resultRecord.tokenBudgetExceeded,
      rolledBack: _resultRecord.decisionMode === "rolled_back",
    }));
    try {
      if (runIdStr) {
        emitDeveloperPatchProgress(runIdStr, {
          stage: "run_completed_with_result",
          progress: {
            runId: runIdStr,
            ts: Date.now(),
            type: "run_completed_with_result",
            title: "Run completed",
            status: "success",
            result: publicResultWithCost,
            costUsd: finalCostUsd,
          } as any,
        });
      }
    } catch {}
    const patchTerminationReason = derivePatchTerminationReason(_resultRecord);
    const patchOutcome = getPatchUserFacingReason({ terminationReason: patchTerminationReason });
    res.json({
      ...publicResultWithCost,
      terminationReason: patchTerminationReason,
      userFacingMessage: patchOutcome.userFacingMessage,
      canResume: patchOutcome.canResume,
      resumeHint: patchOutcome.resumeHint,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      perf.finish("cancelled");
      try {
        if (runIdStr) registerRunComplete(runIdStr, "cancelled");
      } catch {}
      try {
        if (runIdStr) {
          await completeActiveRun(runIdStr, "cancelled");
        }
      } catch (error) {
        console.warn(
          "[zone] active run cancel failed",
          error instanceof Error ? error.message : String(error)
        );
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
          emitDeveloperPatchProgress(runIdStr, {
            stage: "run_completed_with_result",
            progress: {
              runId: runIdStr,
              ts: Date.now(),
              type: "run_completed_with_result",
              title: "Run cancelled",
              status: "warning",
              result: payload,
            } as any,
          });
        }
      } catch {}
      res.json(payload);
      return;
    }
    perf.finish("error");
    try {
      if (runIdStr) registerRunComplete(runIdStr, "cancelled");
    } catch {}
    try {
      if (runIdStr) {
        await completeActiveRun(runIdStr, "cancelled");
      }
    } catch (error) {
      console.warn(
        "[zone] active run error cleanup failed",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (err instanceof UpstreamUnavailableError) {
      const mapped = getPatchUserFacingReason({ terminationReason: "upstream_unavailable" });
      res.status(503).json({
        ok: false,
        terminationReason: "upstream_unavailable",
        reason: err.message,
        userFacingMessage: mapped.userFacingMessage,
        canResume: mapped.canResume,
        resumeHint: mapped.resumeHint,
      });
      return;
    }
    const fallbackMessage = err instanceof Error ? err.message : "patch_flow_failed";
    res.status(500).json({
      ok: false,
      reason: fallbackMessage,
      userFacingMessage: `Run failed: ${fallbackMessage}`,
      canResume: false,
      resumeHint: null,
    });
  } finally {
    if (runIdStr) {
      activePatchRunAbortControllers.delete(runIdStr);
      try {
        const { killAllForRun } = await import(
          "../tools/backgroundProcessRegistry.js"
        );
        await killAllForRun(runIdStr);
      } catch {
        // best-effort, orchestrator hook is primary
      }
    }
  }
  });
});
app.post("/api/dry-run", async (req, res) => {
  const billingMode = "hosted";
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
  if (!userApiKey && shouldProxyHostedRequest(req, "/api/dry-run")) {
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

  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
  const {
    task,
    repoPath,
    runId,
    userId: rawUserId,
    hostedContext: hostedContextFromBodyDry,
    conversationId,
  } = req.body ?? {};
  const hostedContext =
    process.env.NODE_ENV === "production"
      ? hostedContextFromBodyDry
      : hostedDeveloperContextRequestHasFiles(hostedContextFromBodyDry)
        ? hostedContextFromBodyDry
        : undefined;
  const userId =
    typeof rawUserId === "string" && rawUserId.trim()
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

  attachRunIdentity({ userId, runId: typeof runId === "string" ? runId : undefined });

const result = await runLlmPatchFlow({
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

  debugLog("[zone-billing-debug] execution success reached", {
    routeName: "/api/dry-run",
    userId: typeof userId === "string" ? userId.trim() : null,
    billingMode: billingMode ?? null,
  });

  const loggedConversationId = await logRun({
    userId,
    role: "developer",
    task,
    repoPath,
    decisionMode: getDecisionModeFromResult(
      result as Record<string, unknown>,
      confidence
    ),
    confidence,
    executionId: typeof runId === "string" ? runId : undefined,
      creditsUsed: 1,
      conversationId,
      billingMode,
      routeName: "/api/dry-run",
      // J.5: see /api/patch callsite for rationale.
      agentSummary:
        typeof (result as { patchPreview?: unknown }).patchPreview === "string"
          ? ((result as { patchPreview?: string }).patchPreview as string)
          : undefined,
    }).catch(() => null);

  if (loggedConversationId) {
    responseBody.conversationId = loggedConversationId;
  }

res.json(responseBody);
  });
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
  debugLog("[zone-apply-input]", {
    repoPath,
    patchCount: Array.isArray(patches) ? patches.length : null,
  });
  try {
    const result = await applyLlmPatches(patches, repoPath);
    let suggestedVerification: SuggestedVerification = { available: false };
    if (result.applied.length > 0 && typeof repoPath === "string") {
      suggestedVerification = await buildSuggestedVerification(repoPath);
      debugLog(
        `[zone-verify-suggest] command="${suggestedVerification.command ?? ""}" available=${suggestedVerification.available}`
      );
    }
    const responseBody = {
      ...result,
      suggestedVerification,
    };
    debugLog(
      `[zone-apply] suggestedVerification available=${suggestedVerification.available} command="${suggestedVerification.command ?? ""}"`
    );
    res.json(responseBody);
  } catch (err) {
    debugLog(
      "[zone-apply-error]",
      (err as any)?.message,
      (err as any)?.code,
      String((err as any)?.stack || "").slice(0, 300)
    );
    res.status(500).json({ ok: false, reason: "apply_failed" });
  }
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
  debugLog(
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
    debugLog(
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
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
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
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const relevantFiles = Array.isArray(req.body?.relevantFiles)
    ? req.body.relevantFiles.filter((file: unknown): file is string => typeof file === "string")
    : undefined;
  const plan =
    req.body?.plan && typeof req.body.plan === "object"
      ? req.body.plan
      : undefined;

  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
    try {
      const refinedPrompt = await refinePrompt({
        task,
        role,
        reason,
        relevantFiles,
        plan,
      });
      debugLog(
        `[zone-refine] prompt refined role=${role || "developer"} reason=${reason || "unspecified"}`
      );
      res.json({ ok: true, refinedPrompt });
    } catch {
      res.json({ ok: true, refinedPrompt: PROMPT_REFINEMENT_FALLBACK });
    }
  });
});

app.post("/api/enhance-task", async (req, res) => {
  const billingMode = "hosted";
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
  if (!userApiKey && shouldProxyHostedRequest(req, "/api/enhance-task")) {
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

  await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
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
    } catch (err) {
      res.status(500).json({
        ok: false,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
});

app.post("/api/test-engineer", async (req, res) => {
  const billingMode = "hosted";
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
if (!userApiKey && shouldProxyHostedRequest(req, "/api/test-engineer")) {
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
await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
  attachRunIdentity({
    userId: typeof userId === "string" ? userId : undefined,
    runId: typeof runId === "string" ? runId : undefined,
  });
const authorization = await ensureRunAuthorized(userId, {
  billingMode,
});  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }
  const _teCapCheck = await routeCapGate(
    typeof userId === "string" ? userId : "local-dev",
    typeof runId === "string" && runId.trim() ? runId.trim() : undefined
  );
  if (!_teCapCheck.allowed) {
    res.status(429).json({
      ok: false,
      terminationReason: "daily_usd_cap_exceeded",
      userFacingMessage: _teCapCheck.outcome.userFacingMessage,
      canResume: _teCapCheck.outcome.canResume,
      resumeHint: _teCapCheck.outcome.resumeHint,
    });
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
debugLog("[zone-billing-debug] execution success reached", {
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
    // Phase J.4: same internal-only stripping as /api/patch.
    debugLog("[zone-patch-result]", JSON.stringify({
      route: "/api/test-engineer",
      runId: typeof runId === "string" ? runId : null,
      decisionMode: (result as Record<string, unknown>).decisionMode,
      verificationReason: (result as Record<string, unknown>).verificationReason,
      developerConfidence: (result as Record<string, unknown>).developerConfidence,
    }));
    res.json(toPublicLlmPatchResponse(result as Record<string, unknown>));
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
});

app.post("/api/data-analyst", async (req, res) => {
  const billingMode = "hosted";
  const { apiKey: userApiKey, provider: byokProvider, modelHigh: byokModelHigh, modelStandard: byokModelStandard } = getRequestContextFromHeaders(req);
if (!userApiKey && shouldProxyHostedRequest(req, "/api/data-analyst")) {
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
await withRequestContext({ userApiKey: userApiKey || undefined, provider: byokProvider, modelOverride: { high: byokModelHigh, standard: byokModelStandard } }, async () => {
const { task, repoPath, runId, userId, hostedContext, conversationId } =
    req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
  attachRunIdentity({
    userId: typeof userId === "string" ? userId : undefined,
    runId: typeof runId === "string" ? runId : undefined,
  });
const authorization = await ensureRunAuthorized(userId, {
  billingMode,
});  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }
  const _daCapCheck = await routeCapGate(
    typeof userId === "string" ? userId : "local-dev",
    typeof runId === "string" && runId.trim() ? runId.trim() : undefined
  );
  if (!_daCapCheck.allowed) {
    res.status(429).json({
      ok: false,
      terminationReason: "daily_usd_cap_exceeded",
      userFacingMessage: _daCapCheck.outcome.userFacingMessage,
      canResume: _daCapCheck.outcome.canResume,
      resumeHint: _daCapCheck.outcome.resumeHint,
    });
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
  debugLog("[zone-billing-debug] execution success reached", {
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
    // Phase J.4: strip internal-only fields from the public response.
    debugLog("[zone-patch-result]", JSON.stringify({
      route: "/api/data-analyst",
      runId: typeof runId === "string" ? runId : null,
      decisionMode: (result as Record<string, unknown>).decisionMode,
      confidence: (result as { confidence?: number }).confidence,
    }));
    res.json(toPublicLlmPatchResponse(result as Record<string, unknown>));
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
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
      log(
        colorize(`Zone UI running on http://localhost:${port}`, "\x1b[32m", "\x1b[1m")
      );
      log(colorize("Press Ctrl+C to stop", "\x1b[2m", "\x1b[90m"));
      resolve();
    });
  });

  await startPromise;
}

// Tur 5a: removed module-load-time auto-start. The CLI (src/cli/index.ts)
// imports `startServer` and invokes it explicitly. Importing this module no
// longer side-effects an `app.listen` — manual tests can `import` cleanly
// without ZONE_SERVER_MANUAL_START.
