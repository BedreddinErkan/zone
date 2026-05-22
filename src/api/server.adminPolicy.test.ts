/**
 * L.1 — /api/admin/policy GET + PUT integration tests.
 * Schema validation is covered in policyLoader.test.ts.
 * These tests cover: auth gate (Pattern B), absent-path handling,
 * round-trip write, schema rejection, write failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── heavy dep stubs (required for server.js to load in test env) ──────────────

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
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })),
      })),
      insert: vi.fn(),
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })),
      })),
      update: vi.fn(),
    })),
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

// ── test suite ─────────────────────────────────────────────────────────────────

describe("/api/admin/policy", () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let policyPath: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ADMIN_SECRET;
    delete process.env.ZONE_ORG_POLICY_PATH;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-admin-policy-"));
    policyPath = path.join(tmpDir, "policy.json");

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
    delete process.env.ZONE_ORG_POLICY_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── GET ────────────────────────────────────────────────────────────────────

  it("GET: 401 when ADMIN_SECRET env is not set", async () => {
    const res = await fetch(`${baseUrl}/api/admin/policy`);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("GET: 401 when x-admin-secret header is wrong", async () => {
    process.env.ADMIN_SECRET = "correct";
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      headers: { "x-admin-secret": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("GET: 200 absent when ZONE_ORG_POLICY_PATH is not set", async () => {
    process.env.ADMIN_SECRET = "secret";
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      headers: { "x-admin-secret": "secret" },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, policy: null, source: "absent" });
  });

  it("GET: 200 with parsed policy when policy file exists", async () => {
    process.env.ADMIN_SECRET = "secret";
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    const policy = { dailyUsdCap: 5, allowedTiers: ["simple", "medium"] };
    fs.writeFileSync(policyPath, JSON.stringify(policy), "utf-8");

    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      headers: { "x-admin-secret": "secret" },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.policy).toEqual({ dailyUsdCap: 5, allowedTiers: ["simple", "medium"] });
    expect(body.source).toBe("file");
  });

  it("GET: 200 + null when ZONE_ORG_POLICY_PATH set but file does not exist", async () => {
    process.env.ADMIN_SECRET = "secret";
    process.env.ZONE_ORG_POLICY_PATH = path.join(tmpDir, "nonexistent.json");
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      headers: { "x-admin-secret": "secret" },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, policy: null, source: "missing_file" });
  });

  // ── PUT ────────────────────────────────────────────────────────────────────

  it("PUT: 401 when ADMIN_SECRET env is not set", async () => {
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyUsdCap: 10 }),
    });
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("PUT: 400 when ZONE_ORG_POLICY_PATH env is not set", async () => {
    process.env.ADMIN_SECRET = "secret";
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-secret": "secret" },
      body: JSON.stringify({ dailyUsdCap: 10 }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "ZONE_ORG_POLICY_PATH_not_set" });
  });

  it("PUT: 400 schema_invalid for negative dailyUsdCap", async () => {
    process.env.ADMIN_SECRET = "secret";
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-secret": "secret" },
      body: JSON.stringify({ dailyUsdCap: -1 }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "schema_invalid" });
    expect(typeof body.detail).toBe("string");
  });

  it("PUT: 200 and GET round-trip returns same policy", async () => {
    process.env.ADMIN_SECRET = "secret";
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    const policy = { dailyUsdCap: 20, monthlyUsdCap: 100, allowedTiers: ["simple"] as const };

    const putRes = await fetch(`${baseUrl}/api/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-secret": "secret" },
      body: JSON.stringify(policy),
    });
    const putBody = await putRes.json();
    expect(putRes.status).toBe(200);
    expect(putBody.ok).toBe(true);
    expect(putBody.policy).toEqual(policy);

    const getRes = await fetch(`${baseUrl}/api/admin/policy`, {
      headers: { "x-admin-secret": "secret" },
    });
    const getBody = await getRes.json();
    expect(getRes.status).toBe(200);
    expect(getBody.policy).toEqual(policy);
  });

  it("PUT: 500 write_failed when ZONE_ORG_POLICY_PATH is in a non-existent directory", async () => {
    process.env.ADMIN_SECRET = "secret";
    process.env.ZONE_ORG_POLICY_PATH = "/nonexistent-dir-l1-test/policy.json";
    const res = await fetch(`${baseUrl}/api/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-secret": "secret" },
      body: JSON.stringify({ dailyUsdCap: 5 }),
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, reason: "write_failed" });
  });
});
