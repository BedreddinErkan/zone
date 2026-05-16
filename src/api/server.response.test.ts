/**
 * Phase Y.2.1 — /api/patch response shape regression tests.
 *
 * 1. Happy path: terminationReason present alongside userFacingMessage/canResume.
 * 2. UpstreamUnavailableError: 503 + enriched fields from patchUserFacingReason mapper.
 * 3. Generic error: 500 + raw reason + userFacingMessage parity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

// ── UpstreamUnavailableError must be a shared class across the mock boundary ──
// vi.resetModules() in beforeEach reloads server.ts, which reimports
// withExponentialBackoff.ts from the mock factory below — so the class defined
// here is the one server.ts will use for instanceof checks.
class UpstreamUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("Upstream LLM unavailable after retries exhausted");
    this.name = "UpstreamUnavailableError";
  }
}

// ── module-level mocks ────────────────────────────────────────────────────────

const runLlmPatchFlowMock = vi.fn();

vi.mock("../llm/withExponentialBackoff.js", () => ({
  withExponentialBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classifyError: vi.fn(),
  UpstreamUnavailableError,
}));

vi.mock("../core/runAgent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
  isIrrelevantDeveloperContextPath: vi.fn(() => false),
  toPublicLlmPatchResponse: (r: unknown) => r,
}));
vi.mock("../core/applyLlmPatches.js", () => ({ applyLlmPatches: vi.fn() }));
vi.mock("../roles/runTestEngineerFlow.js", () => ({
  runTestEngineerFlow: vi.fn(),
  readExampleContents: vi.fn(),
  readFeatureExampleContents: vi.fn(),
}));
vi.mock("../roles/detectTestFramework.js", () => ({ detectTestFramework: vi.fn() }));
vi.mock("../roles/testEngineerContext.js", () => ({ buildTestEngineerContext: vi.fn() }));
vi.mock("../roles/detectDataSchema.js", () => ({ detectDataSchema: vi.fn() }));
vi.mock("../roles/dataAnalystContext.js", () => ({ buildDataAnalystContext: vi.fn() }));
vi.mock("../roles/runDataAnalystFlow.js", () => ({ runDataAnalystFlow: vi.fn() }));
vi.mock("../llm/investigationFlow.js", () => ({
  runChatAgentFlow: vi.fn(),
  runInvestigationFlow: vi.fn(),
  investigateScope: vi.fn(),
}));
vi.mock("../repo/scanRepo.js", () => ({ scanRepo: vi.fn() }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: vi.fn() }));

const createLLMClientMock = vi.fn(() => ({
  provider: "anthropic" as const,
  createChatCompletion: vi.fn(),
  createChatCompletionStream: vi.fn(),
  createEmbedding: vi.fn(),
}));
vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createLLMClientMock,
  getModelName: vi.fn(() => "claude-haiku-4-5"),
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
        upsert: vi.fn(() => ({
          select: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })),
        })),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
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

vi.mock("../usage/usageTracker.js", () => ({
  readRecords: vi.fn(() => []),
  getUsage: vi.fn(async () => ({
    period: "day" as const,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  })),
  getRunCost: vi.fn(() => 0),
  recordExecution: vi.fn(),
  recordRunSummary: vi.fn(),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(() => undefined),
  TIER_LIMITS: { simple: {}, medium: {}, complex: {} },
  saveLimitConfig: vi.fn(),
  readLimitConfig: vi.fn(() => ({})),
}));

// ── shared setup ───────────────────────────────────────────────────────────────

describe("Y.2.1 — /api/patch response shape", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ZONE_DAILY_USD_CAP;

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
  });

  it("happy path: response includes terminationReason + userFacingMessage + canResume", async () => {
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "",
      warnings: [],
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      decisionMode: "safe_to_apply",
    });

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "add a comment", repoPath: "/tmp/repo", userId: "u1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.terminationReason).toBe("natural_completion");
    expect(body.userFacingMessage).toBe("Run completed successfully.");
    expect(body.canResume).toBe(true);
    expect(body.resumeHint).toBeNull();
  });

  it("UpstreamUnavailableError: 503 + upstream_unavailable terminationReason + canResume: true", async () => {
    runLlmPatchFlowMock.mockRejectedValue(
      new UpstreamUnavailableError("rate limit retries exhausted")
    );

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "add a comment", repoPath: "/tmp/repo", userId: "u1" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.terminationReason).toBe("upstream_unavailable");
    expect(body.reason).toContain("retries exhausted");
    expect(body.canResume).toBe(true);
    expect(typeof body.resumeHint).toBe("string");
    expect(body.userFacingMessage).toContain("unavailable");
  });

  it("generic error: 500 + reason + userFacingMessage parity + canResume: false", async () => {
    runLlmPatchFlowMock.mockRejectedValue(new Error("unexpected boom"));

    const res = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "add a comment", repoPath: "/tmp/repo", userId: "u1" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unexpected boom");
    expect(body.userFacingMessage).toBe("Run failed: unexpected boom");
    expect(body.canResume).toBe(false);
    expect(body.resumeHint).toBeNull();
  });
});
