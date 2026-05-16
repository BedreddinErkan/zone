/**
 * Phase K.3 — /api/metrics route integration tests.
 * Pure aggregation logic is covered in metricsAggregator.test.ts.
 * These tests cover: auth gate, period validation, no-data response,
 * data-present response, and 60 s in-memory cache hit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { UsageRecord } from "../usage/usageTracker.js";

// ── mock factories ────────────────────────────────────────────────────────────

const readRecordsMock = vi.fn<() => UsageRecord[]>();

vi.mock("../usage/usageTracker.js", () => ({
  readRecords: readRecordsMock,
  getUsage: vi.fn(async () => ({
    period: "day",
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  })),
  getRunCost: vi.fn(() => 0),
  recordExecution: vi.fn(),
  readDailyUsdCapOverride: vi.fn(() => undefined),
}));

// Stub out all heavy server dependencies so the module loads in test env.
vi.mock("../core/runAgent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: vi.fn(),
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
vi.mock("../repo/scanRepo.js", () => ({ scanRepo: vi.fn() }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: vi.fn() }));
vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: vi.fn(() => ({ provider: "openai", createChatCompletion: vi.fn() })),
  getModelName: vi.fn(() => "gpt-4o-mini"),
  getInferenceMode: vi.fn(() => "local"),
  getHostedInferenceBaseUrl: vi.fn(() => "https://zonecli.dev"),
}));
vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({ provider: "openai", createChatCompletion: vi.fn() })),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })),
      insert: vi.fn(),
      upsert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })),
      update: vi.fn(),
    })),
    rpc: vi.fn(async () => ({ error: null })),
  })),
}));
vi.mock("../jobs/developerPatchJobs.js", () => ({
  createDeveloperPatchJob: vi.fn(),
  getDeveloperPatchJob: vi.fn(),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeUsageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const now = new Date().toISOString();
  return {
    timestamp: now,
    userId: "u1",
    runId: "run_1",
    provider: "openai",
    model: "gpt-5.4-mini",
    input_uncached: 500,
    cache_write: 0,
    cache_read: 200,
    output: 100,
    est_cost_usd: 0.01,
    ...overrides,
  };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("/api/metrics", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ADMIN_SECRET;
    readRecordsMock.mockReturnValue([]);

    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.ADMIN_SECRET;
  });

  it("returns 403 when ADMIN_SECRET is set and x-admin-secret header is missing", async () => {
    process.env.ADMIN_SECRET = "test-secret-xyz";

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("returns 403 when ADMIN_SECRET is set and x-admin-secret header is wrong", async () => {
    process.env.ADMIN_SECRET = "correct-secret";

    const res = await fetch(`${baseUrl}/api/metrics?period=day`, {
      headers: { "x-admin-secret": "wrong-secret" },
    });

    expect(res.status).toBe(403);
  });

  it("returns 400 for an unrecognised period value", async () => {
    const res = await fetch(`${baseUrl}/api/metrics?period=year`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "invalid_period" });
  });

  it("returns 200 with all-zero metrics when no usage records exist", async () => {
    readRecordsMock.mockReturnValue([]);

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.period).toBe("day");
    expect(body.runs).toBe(0);
    expect(body.usdTotal).toBe(0);
    expect(body.tierDistribution).toEqual({ simple: 0, medium: 0, complex: 0 });
    expect(body.terminationDistribution).toEqual({});
    expect(body.cacheHitRatio).toBe(0);
    expect(body.latencyMs).toEqual({ p50: 0, p95: 0 });
    expect(typeof body.generatedAt).toBe("string");
  });

  it("returns 200 with correct aggregations for mock run records", async () => {
    const records: UsageRecord[] = [
      makeUsageRecord({
        runId: "run_a",
        est_cost_usd: 0.05,
        cache_read: 400,
        input_uncached: 600,
        cache_write: 0,
        output: 100,
      }),
      makeUsageRecord({
        runId: "run_b",
        est_cost_usd: 0.03,
        cache_read: 100,
        input_uncached: 200,
        cache_write: 0,
        output: 50,
      }),
    ];
    readRecordsMock.mockReturnValue(records);

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.runs).toBe(2);
    expect(body.usdTotal).toBe(0.08); // 0.05 + 0.03
    // weighted cache ratio: (400+100) / (600+400+0+100 + 200+100+0+50) = 500/1450 ≈ 0.345
    const expectedRatio = Math.round((500 / 1450) * 1000) / 1000;
    expect(body.cacheHitRatio).toBe(expectedRatio);
  });

  it("returns 200 with x-admin-secret header when ADMIN_SECRET is set", async () => {
    process.env.ADMIN_SECRET = "my-secret";
    readRecordsMock.mockReturnValue([]);

    const res = await fetch(`${baseUrl}/api/metrics?period=week`, {
      headers: { "x-admin-secret": "my-secret" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("defaults period to 'day' when period query param is absent", async () => {
    readRecordsMock.mockReturnValue([]);

    const res = await fetch(`${baseUrl}/api/metrics`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.period).toBe("day");
  });

  it("cache hit: second call uses cached result without re-scanning records", async () => {
    readRecordsMock.mockReturnValue([makeUsageRecord()]);

    const res1 = await fetch(`${baseUrl}/api/metrics?period=day&userId=u1`);
    const body1 = await res1.json();

    // Mutate the mock — cache hit should still return the first result
    readRecordsMock.mockReturnValue([]);

    const res2 = await fetch(`${baseUrl}/api/metrics?period=day&userId=u1`);
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both responses should be identical (same cached object)
    expect(body2.runs).toBe(body1.runs);
    expect(body2.usdTotal).toBe(body1.usdTotal);
    // readRecords called exactly once (second hit used cache)
    expect(readRecordsMock).toHaveBeenCalledTimes(1);
  });
});
