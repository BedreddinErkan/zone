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

  it("K.3.C3: terminationDistribution populated when run-summary records present", async () => {
    // LLM call records (no terminationReason)
    const llmRecord = makeUsageRecord({ runId: "run_x", est_cost_usd: 0.02 });
    // Run-summary sentinel records (zero cost, carries terminationReason + latencyMs)
    const summaryA = makeUsageRecord({
      runId: "run_x",
      est_cost_usd: 0,
      input_uncached: 0,
      cache_read: 0,
      output: 0,
      terminationReason: "natural_completion",
      latencyMs: 5_000,
    });
    const summaryB = makeUsageRecord({
      runId: "run_y",
      est_cost_usd: 0.01,
      terminationReason: "max_iterations",
      latencyMs: 12_000,
    });
    readRecordsMock.mockReturnValue([llmRecord, summaryA, summaryB]);

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    // run_x + run_y = 2 distinct runs
    expect(body.runs).toBe(2);
    expect(body.terminationDistribution).toEqual({
      natural_completion: 1,
      max_iterations: 1,
    });
    // p50/p95 from [5000, 12000] → sorted [5000, 12000]
    // p50: floor(0.5*1)=0 → 5000; p95: floor(0.95*1)=0 → 5000
    expect(body.latencyMs.p50).toBe(5_000);
    expect(body.latencyMs.p95).toBe(5_000);
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

  it("K.4 C2: response carries gracefulDegradeRate and resumableRate fields", async () => {
    readRecordsMock.mockReturnValue([]);

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(typeof body.gracefulDegradeRate).toBe("number");
    expect(typeof body.resumableRate).toBe("number");
    // no runs → both zero
    expect(body.gracefulDegradeRate).toBe(0);
    expect(body.resumableRate).toBe(0);
  });

  it("K.4 C2: gracefulDegradeRate and resumableRate computed correctly from termination summary records", async () => {
    const natural = makeUsageRecord({ runId: "run_a", terminationReason: "natural_completion", est_cost_usd: 0 });
    const maxIter = makeUsageRecord({ runId: "run_b", terminationReason: "max_iterations", est_cost_usd: 0 });
    const loop = makeUsageRecord({ runId: "run_c", terminationReason: "loop_detected", est_cost_usd: 0 });
    readRecordsMock.mockReturnValue([natural, maxIter, loop]);

    const res = await fetch(`${baseUrl}/api/metrics?period=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.runs).toBe(3);
    // 2 degraded / 3 total = 0.667
    expect(body.gracefulDegradeRate).toBeCloseTo(2 / 3, 2);
    // 1 resumable (max_iterations) / 2 degraded = 0.5
    expect(body.resumableRate).toBe(0.5);
  });
});

// ── /api/metrics/prometheus ───────────────────────────────────────────────────

describe("/api/metrics/prometheus", () => {
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
    process.env.ADMIN_SECRET = "secret";
    const res = await fetch(`${baseUrl}/api/metrics/prometheus`);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("returns 200 with Prometheus text in self-hosted mode (no ADMIN_SECRET)", async () => {
    readRecordsMock.mockReturnValue([]);
    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=day`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/plain");
    expect(ct).toContain("version=0.0.4");
    const body = await res.text();
    expect(body).toContain("# HELP zone_runs ");
    expect(body).toContain("# TYPE zone_runs gauge");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("returns 200 with valid Prometheus body when authenticated", async () => {
    process.env.ADMIN_SECRET = "my-secret";
    readRecordsMock.mockReturnValue([makeUsageRecord({ runId: "r1", est_cost_usd: 0.05 })]);

    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=week`, {
      headers: { "x-admin-secret": "my-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`zone_runs{period="week"} 1`);
    expect(body).toContain(`zone_usd_dollars{period="week"} 0.05`);
    expect(body).toContain(`zone_latency_ms{quantile="0.5",period="week"}`);
    expect(body).toContain(`zone_latency_ms{quantile="0.95",period="week"}`);
  });

  it("returns 400 for an unrecognised period value (symmetric with /api/metrics)", async () => {
    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=year`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "invalid_period" });
  });

  it("cache hit: second call reuses aggregated result without re-reading records", async () => {
    readRecordsMock.mockReturnValue([makeUsageRecord({ runId: "r1", est_cost_usd: 0.02 })]);

    const res1 = await fetch(`${baseUrl}/api/metrics/prometheus?period=day&userId=u1`);
    const body1 = await res1.text();

    // mutate mock — cache hit should still return original result
    readRecordsMock.mockReturnValue([]);

    const res2 = await fetch(`${baseUrl}/api/metrics/prometheus?period=day&userId=u1`);
    const body2 = await res2.text();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(body2).toBe(body1);
    expect(readRecordsMock).toHaveBeenCalledTimes(1);
  });

  // Y.1.6.4 — zone_llm_retry_rate Prometheus gauge tests.

  it("Y.1.6.4: zone_llm_retry_rate = 0.3 when 3 of 10 runs have __run_retry__ sentinel", async () => {
    // 10 distinct runs; 3 of them have a __run_retry__ sentinel record.
    const records: UsageRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      records.push(makeUsageRecord({ runId: `run_${i}`, est_cost_usd: 0.01 }));
    }
    // Add retry sentinels for runs 1, 2, 3
    for (let i = 1; i <= 3; i++) {
      records.push(makeUsageRecord({ runId: `run_${i}`, model: "__run_retry__", est_cost_usd: 0 }));
    }
    readRecordsMock.mockReturnValue(records);

    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=day`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("zone_llm_retry_rate");
    // 3/10 = 0.3, formatter rounds to 3 decimal places
    const match = body.match(/zone_llm_retry_rate\{[^}]*\}\s+([\d.]+)/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1]!)).toBeCloseTo(0.3, 5);
  });

  it("Y.1.6.4: zone_llm_retry_rate = 0 when no runs have retry sentinels", async () => {
    readRecordsMock.mockReturnValue([
      makeUsageRecord({ runId: "r1" }),
      makeUsageRecord({ runId: "r2" }),
      makeUsageRecord({ runId: "r3" }),
      makeUsageRecord({ runId: "r4" }),
      makeUsageRecord({ runId: "r5" }),
    ]);

    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=day`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const match = body.match(/zone_llm_retry_rate\{[^}]*\}\s+([\d.]+)/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1]!)).toBe(0);
  });

  it("Y.1.6.4: zone_llm_retry_rate block present in Prometheus output with correct format", async () => {
    readRecordsMock.mockReturnValue([makeUsageRecord({ runId: "r1" })]);

    const res = await fetch(`${baseUrl}/api/metrics/prometheus?period=day`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# HELP zone_llm_retry_rate");
    expect(body).toContain("# TYPE zone_llm_retry_rate gauge");
    expect(body).toMatch(/zone_llm_retry_rate\{period="day"\} 0/);
  });
});
