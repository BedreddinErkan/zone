import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runAgent } from "../core/runAgent.js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import { runTestEngineerFlow } from "../roles/runTestEngineerFlow.js";
import { runDataAnalystFlow } from "../roles/runDataAnalystFlow.js";
import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import type { Response } from "express";
import { c, colorize } from "../cli/colors.js";

export const app = express();
const PORT = process.env.PORT || 3000;
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

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
  const configScript = `<script>window.__ZONE_PUBLIC_CONFIG__=${JSON.stringify({
    posthogKey:
      typeof process.env.POSTHOG_KEY === "string"
        ? process.env.POSTHOG_KEY.trim()
        : "",
    posthogHost:
      typeof process.env.POSTHOG_HOST === "string"
        ? process.env.POSTHOG_HOST.trim()
        : "",
  })};</script>`;
  return zoneUiHtmlTemplate.replace("</head>", `${configScript}</head>`);
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

  let freeRunDebit = 1;

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
    ?.eq?.("id", effectiveUserId);

if (profileQuery && typeof profileQuery.maybeSingle === "function") {
  try {
    const { data, error } = await profileQuery.maybeSingle();

    if (!error && data) {
      const normalizedStatus = normalizeSubscriptionStatus(
        data.subscription_status
      );
      const paidAccess = normalizedStatus === "pro";

      freeRunDebit = paidAccess ? 0 : 1;

      console.log(
        `[zone] logRun: subscription_status=${normalizedStatus || "missing"}`
      );
      console.log(`[zone] logRun: paidAccess=${paidAccess}`);
    } else {
      console.log("[zone] logRun: profile read failed, defaulting debit=1");
      freeRunDebit = 1;
    }
  } catch {
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
    ?.eq?.("id", authenticatedUserId);

  if (!query || typeof query.maybeSingle !== "function") {
    return { allowed: true };
  }

  try {
    const { data, error } = await query.maybeSingle();
    if (error || !data) {
      return { allowed: true };
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
}): Promise<string> {
  try {
    const repoFiles = await scanRepo(input.repoPath);
    const contextFiles = selectEnhanceContextFiles(input.role, repoFiles);
    const contents =
      contextFiles.length > 0
        ? await readProjectFiles(contextFiles.map((file) => file.absolutePath))
        : {};

    const repoContext =
      contextFiles.length > 0
        ? contextFiles
            .map((file) => {
              const content = contents[file.absolutePath] ?? "";
              return `FILE: ${file.path}\n${content}`;
            })
            .join("\n\n")
        : "(no matching context files found)";

    const client = createOpenAIClient();
    const model = getModelName();
    const response = await client.responses.create({
      model,
      instructions: ENHANCE_TASK_SYSTEM_PROMPT,
      input:
        `Role: ${input.role}\n` +
        `Repo path: ${input.repoPath}\n` +
        `User task: ${input.task}\n\n` +
        `Relevant repository context:\n${repoContext}`,
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
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const authorization = await ensureRunAuthorized(userId);
  if (authorization.allowed) {
    res.json({ ok: true });
    return;
  }
  res.status(authorization.status).json(authorization.body);
});

app.get("/api/billing-summary", async (req, res) => {
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
  const profilesTable = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
      eq?: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: {
            credits?: number | string | null;
            subscription_status?: string | null;
          } | null;
          error?: unknown;
        }>;
      };
    };
  };
  const posthogKey = process.env.POSTHOG_KEY || "";
const posthogHost = process.env.POSTHOG_HOST || "";

const injectedScript = `
<script>
  window.__ZONE_PUBLIC_CONFIG__ = {
    POSTHOG_KEY: "${posthogKey}",
    POSTHOG_HOST: "${posthogHost}"
  };
</script>
`;
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
    const credits =
      typeof data.credits === "number"
        ? data.credits
        : Number(data.credits ?? 0);
    const status = normalizeSubscriptionStatus(data.subscription_status) || "free";
    res.json({
      ok: true,
      plan: hasPaidAccess(status) ? "Pro" : "Free",
      credits: Number.isFinite(credits) ? Math.max(0, credits) : 0,
      subscriptionStatus: status,
    });
  } catch {
    res.json({ ok: false, reason: "profile_unavailable" });
  }
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

  const result = await runLlmPatchFlow({ task, repoPath });
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
  const { task, repoPath, userId } = req.body;

  const authorization = await ensureRunAuthorized(userId);
  if (!authorization.allowed) {
    res.status(authorization.status).json(authorization.body);
    return;
  }

  const result = await runLlmPatchFlow({ task, repoPath, dryRun: true });
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/test-engineer", async (req, res) => {
const { task, repoPath, runId, userId } = req.body;
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
    });
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
const { task, repoPath, runId, userId } = req.body;
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
    });
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
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(
        colorize(`Zone UI running on http://localhost:${port}`, c.green, c.bold)
      );
      console.log(colorize("Press Ctrl+C to stop", c.dim, c.gray));
      resolve();
    });
  });
}

if (
  process.env.VITEST !== "true" &&
  process.env.ZONE_SERVER_MANUAL_START !== "1"
) {
  void startServer(Number(PORT));
}
