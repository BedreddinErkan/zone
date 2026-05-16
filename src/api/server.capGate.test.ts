/**
 * K.1.1 integration tests.
 *
 * 1. Route-level daily cap gate — /api/patch, /api/test-engineer, /api/data-analyst
 *    all return 429 when spend >= cap before any LLM call is made.
 * 2. Chat-cost fix — /api/patch in chat intent includes costUsd from getRunCost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

// ── heavy dep stubs ────────────────────────────────────────────────────────────

vi.mock("../core/runAgent.js", () => ({ runAgent: vi.fn() }));

const runLlmPatchFlowMock = vi.fn();
vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
  isIrrelevantDeveloperContextPath: vi.fn(() => false),
  toPublicLlmPatchResponse: (r: unknown) => r,
}));

vi.mock("../core/applyLlmPatches.js", () => ({ applyLlmPatches: vi.fn() }));

const runTestEngineerFlowMock = vi.fn();
vi.mock("../roles/runTestEngineerFlow.js", () => ({
  runTestEngineerFlow: runTestEngineerFlowMock,
  readExampleContents: vi.fn(),
  readFeatureExampleContents: vi.fn(),
}));
vi.mock("../roles/detectTestFramework.js", () => ({ detectTestFramework: vi.fn() }));
vi.mock("../roles/testEngineerContext.js", () => ({ buildTestEngineerContext: vi.fn() }));
vi.mock("../roles/detectDataSchema.js", () => ({ detectDataSchema: vi.fn() }));
vi.mock("../roles/dataAnalystContext.js", () => ({ buildDataAnalystContext: vi.fn() }));

const runDataAnalystFlowMock = vi.fn();
vi.mock("../roles/runDataAnalystFlow.js", () => ({ runDataAnalystFlow: runDataAnalystFlowMock }));

const runChatAgentFlowMock = vi.fn();
vi.mock("../llm/investigationFlow.js", () => ({
  runChatAgentFlow: runChatAgentFlowMock,
  runInvestigationFlow: vi.fn(),
}));

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: vi.fn() }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: vi.fn() }));

const createLLMClientMock = vi.fn(() => ({
  provider: "openai" as const,
  createChatCompletion: vi.fn(),
  createChatCompletionStream: vi.fn(),
  createEmbedding: vi.fn(),
}));
vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createLLMClientMock,
  getModelName: vi.fn(() => "gpt-4o-mini"),
  getInferenceMode: vi.fn(() => "local"),
  getHostedInferenceBaseUrl: vi.fn(() => "https://zonecli.dev"),
}));
vi.mock("../llm/factory.js", () => ({ createLLMClient: createLLMClientMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  credits: 10,
                  runs_used_this_month: 0,
                  free_limit: 10,
                  subscription_status: "free",
                },
                error: null,
              })),
            })),
          })),
        };
      }
      return {
        insert: vi.fn(),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
        upsert: vi.fn(() => ({
          select: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })),
        })),
        update: vi.fn(),
      };
    }),
    rpc: vi.fn(async () => ({ error: null })),
  })),
}));

vi.mock("../jobs/developerPatchJobs.js", () => ({
  createDeveloperPatchJob: vi.fn(),
  getDeveloperPatchJob: vi.fn(),
}));

const getRunCostMock = vi.fn(() => 0);
const getUsageMock = vi.fn(async () => ({
  period: "day" as const,
  totalRuns: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  byProvider: {},
  byModel: {},
}));
vi.mock("../usage/usageTracker.js", () => ({
  readRecords: vi.fn(() => []),
  getUsage: getUsageMock,
  getRunCost: getRunCostMock,
  recordExecution: vi.fn(),
  readDailyUsdCapOverride: vi.fn(() => undefined),
  recordRunSummary: vi.fn(),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(() => undefined),
  TIER_LIMITS: { simple: {}, medium: {}, complex: {} },
  saveLimitConfig: vi.fn(),
  readLimitConfig: vi.fn(() => ({})),
}));

// ── shared setup ───────────────────────────────────────────────────────────────

describe("K.1.1 — route-level daily cap gate", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ZONE_DAILY_USD_CAP;
    delete process.env.ZONE_ORG_POLICY_PATH;

    // Default: spend is 0, no cap → all requests allowed
    getUsageMock.mockResolvedValue({
      period: "day",
      totalRuns: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      byProvider: {},
      byModel: {},
    });

    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    delete process.env.ZONE_DAILY_USD_CAP;
    delete process.env.ZONE_ORG_POLICY_PATH;
  });

  // ── /api/patch ─────────────────────────────────────────────────────────────

  it("/api/patch: 429 + daily_usd_cap_exceeded when spend >= cap", async () => {
    process.env.ZONE_DAILY_USD_CAP = "5";
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 10, totalTokens: 10000, totalCostUsd: 6.5,
      byProvider: {}, byModel: {},
    });

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix bug", repoPath: "/tmp/repo", userId: "u1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(body.canResume).toBe(true);
    expect(body.userFacingMessage).toContain("$6.50");
    expect(body.userFacingMessage).toContain("$5.00");
    expect(body.resumeHint).toContain("ZONE_DAILY_USD_CAP");
    // LLM flow must NOT have been called
    expect(runLlmPatchFlowMock).not.toHaveBeenCalled();
  });

  it("/api/patch: proceeds normally when spend < cap", async () => {
    process.env.ZONE_DAILY_USD_CAP = "10";
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 3.0,
      byProvider: {}, byModel: {},
    });
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== PATCH ===",
      warnings: [],
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
    });

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix bug", repoPath: "/tmp/repo", userId: "u1" }),
    });

    expect(res.status).toBe(200);
    expect(runLlmPatchFlowMock).toHaveBeenCalled();
  });

  it("/api/patch: no cap gate when ZONE_DAILY_USD_CAP not set", async () => {
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 10, totalTokens: 100000, totalCostUsd: 999,
      byProvider: {}, byModel: {},
    });
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== PATCH ===",
      warnings: [],
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
    });

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix bug", repoPath: "/tmp/repo", userId: "u1" }),
    });
    // Default cap is $10 — $999 spend → blocked
    // But since no env var, resolveDailyUsdCap falls back to $10 default
    expect(res.status).toBe(429);
    expect(runLlmPatchFlowMock).not.toHaveBeenCalled();
  });

  // ── /api/test-engineer ─────────────────────────────────────────────────────

  it("/api/test-engineer: 429 + daily_usd_cap_exceeded when spend >= cap", async () => {
    process.env.ZONE_DAILY_USD_CAP = "2";
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 5, totalTokens: 5000, totalCostUsd: 3.0,
      byProvider: {}, byModel: {},
    });

    const res = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "write tests", repoPath: "/tmp/repo", userId: "u1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(runTestEngineerFlowMock).not.toHaveBeenCalled();
  });

  // ── /api/data-analyst ──────────────────────────────────────────────────────

  it("/api/data-analyst: 429 + daily_usd_cap_exceeded when spend >= cap", async () => {
    process.env.ZONE_DAILY_USD_CAP = "1";
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 2, totalTokens: 2000, totalCostUsd: 2.5,
      byProvider: {}, byModel: {},
    });

    const res = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "analyze data", repoPath: "/tmp/repo", userId: "u1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(runDataAnalystFlowMock).not.toHaveBeenCalled();
  });
});

// ── chat cost fix ──────────────────────────────────────────────────────────────

describe("K.1.1 — /api/patch chat path costUsd fix", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ZONE_DAILY_USD_CAP;

    // Cap is unlimited (0) so cap gate never blocks
    getUsageMock.mockResolvedValue({
      period: "day", totalRuns: 0, totalTokens: 0, totalCostUsd: 0,
      byProvider: {}, byModel: {},
    });
    process.env.ZONE_DAILY_USD_CAP = "0";

    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    delete process.env.ZONE_DAILY_USD_CAP;
  });

  it("response includes costUsd equal to getRunCost return value", async () => {
    // Simulate: getRunCost returns the accumulated LLM cost for this run
    getRunCostMock.mockReturnValue(0.042);

    runChatAgentFlowMock.mockResolvedValue({
      ok: true,
      chatResponse: "The auth flow works by...",
    });

    const runId = "test-chat-cost-run-001";
    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "How does the auth flow work?",
        repoPath: "/tmp/repo",
        userId: "u1",
        runId,
        mode: "chat",
      }),
    });

    const body = await res.json();
    // The route should have called getRunCost("u1", runId) and included result
    expect(body.costUsd).toBe(0.042);
  });
});
