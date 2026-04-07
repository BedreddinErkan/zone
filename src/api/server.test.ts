import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const runAgentMock = vi.fn();
const runLlmPatchFlowMock = vi.fn();
const applyLlmPatchesMock = vi.fn();
const runTestEngineerFlowMock = vi.fn();
const runDataAnalystFlowMock = vi.fn();
const detectTestFrameworkMock = vi.fn();
const buildTestEngineerContextMock = vi.fn();
const detectDataSchemaMock = vi.fn();
const buildDataAnalystContextMock = vi.fn();
const readExampleContentsMock = vi.fn();
const readFeatureExampleContentsMock = vi.fn();
const scanRepoMock = vi.fn();
const readProjectFilesMock = vi.fn();
const responsesCreateMock = vi.fn();
const supabaseInsertMock = vi.fn();
const supabaseRpcMock = vi.fn();
const supabaseProfileMaybeSingleMock = vi.fn();
const supabaseSelectEqMock = vi.fn(() => ({
  maybeSingle: supabaseProfileMaybeSingleMock,
}));
const supabaseSelectMock = vi.fn(() => ({
  eq: supabaseSelectEqMock,
}));
const supabaseFromMock = vi.fn((table: string) => {
  if (table === "profiles") {
    return {
      select: supabaseSelectMock,
    };
  }
  return {
    insert: supabaseInsertMock,
  };
});
const createSupabaseClientMock = vi.fn(() => ({
  from: supabaseFromMock,
  rpc: supabaseRpcMock,
}));
const createOpenAIClientMock = vi.fn(() => ({
  responses: {
    create: responsesCreateMock,
  },
}));
const getModelNameMock = vi.fn(() => "gpt-4o-mini");
const getInferenceModeMock = vi.fn(() => "local");
const getHostedInferenceBaseUrlMock = vi.fn(() => "https://zonecli.dev");

vi.mock("../core/runAgent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
  isIrrelevantDeveloperContextPath: vi.fn(() => false),
}));

vi.mock("../core/applyLlmPatches.js", () => ({
  applyLlmPatches: applyLlmPatchesMock,
}));

vi.mock("../roles/runTestEngineerFlow.js", () => ({
  runTestEngineerFlow: runTestEngineerFlowMock,
  readExampleContents: readExampleContentsMock,
  readFeatureExampleContents: readFeatureExampleContentsMock,
}));

vi.mock("../roles/detectTestFramework.js", () => ({
  detectTestFramework: detectTestFrameworkMock,
}));

vi.mock("../roles/testEngineerContext.js", () => ({
  buildTestEngineerContext: buildTestEngineerContextMock,
}));

vi.mock("../roles/detectDataSchema.js", () => ({
  detectDataSchema: detectDataSchemaMock,
}));

vi.mock("../roles/dataAnalystContext.js", () => ({
  buildDataAnalystContext: buildDataAnalystContextMock,
}));

vi.mock("../roles/runDataAnalystFlow.js", () => ({
  runDataAnalystFlow: runDataAnalystFlowMock,
}));

vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createOpenAIClientMock,
  getModelName: getModelNameMock,
  getInferenceMode: getInferenceModeMock,
  getHostedInferenceBaseUrl: getHostedInferenceBaseUrlMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createSupabaseClientMock,
}));

describe("/api/test-engineer", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    detectTestFrameworkMock.mockReturnValue({
      framework: "playwright_ts",
      language: "typescript",
    });
    buildTestEngineerContextMock.mockReturnValue({
      pageObjectFiles: [],
      stepDefinitionFiles: [],
      featureFiles: [],
      existingTestFiles: [],
    });
    detectDataSchemaMock.mockReturnValue({
      dialect: "postgresql",
      migrationFormat: "flyway",
    });
    buildDataAnalystContextMock.mockReturnValue({
      existingSqlFiles: [],
    });
    readExampleContentsMock.mockResolvedValue([]);
    readFeatureExampleContentsMock.mockResolvedValue([]);
    process.env.VITEST = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ZONE_USER_ID;
    delete process.env.ZONE_USER_EMAIL;
    delete process.env.ZONE_DEBUG_FALLBACK_USER_ID;
    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns complexity from the test engineer flow", async () => {
    runTestEngineerFlowMock.mockResolvedValue({
      ok: true,
      framework: "playwright_ts",
      language: "typescript",
      confidence: 82,
      summary: "Generated test",
      warnings: [],
      complexity: "data_driven",
      applyPatches: [],
      preview: "preview",
    });

    const response = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "Write a data driven login test for multiple users",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.complexity).toBe("data_driven");
  });

  it("returns the expected successful shape for /api/data-analyst", async () => {
    runDataAnalystFlowMock.mockResolvedValue({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 90,
      summary: "Creates orders table",
      warnings: ["Existing index naming differs from default convention."],
      applyPatches: [
        {
          filePath: "db/migration/V3__orders.sql",
          fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
        },
      ],
      preview: "=== DATA ANALYST PREVIEW ===\nDialect: postgresql",
    });

    const response = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "create orders table",
        repoPath: "C:/repo/zone-flyway-test",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 90,
      summary: "Creates orders table",
      warnings: ["Existing index naming differs from default convention."],
    });
    expect(body.applyPatches).toHaveLength(1);
    expect(body.applyPatches[0].filePath).toBe("db/migration/V3__orders.sql");
  });

  it("returns contextFiles from the developer patch flow", async () => {
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Update login flow",
      warnings: [],
      contextFiles: [
        "src/components/LoginForm.tsx",
        "server/routes/auth.ts",
      ],
applyPatches: [
  {
    filePath: "src/components/LoginForm.tsx",
    fullContent: `import React, { useState } from "react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  return (
    <form>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <button type="submit">Login</button>
    </form>
  );
}`,
  },
],  });

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "fix login form auth bug",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.contextFiles).toEqual([
      "src/components/LoginForm.tsx",
      "server/routes/auth.ts",
    ]);
  });

  it("injects the current user bootstrap into the UI html when available", async () => {
    process.env.ZONE_USER_ID = "user_real_123";
    process.env.ZONE_USER_EMAIL = "real@example.com";

    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"currentUser":{"id":"user_real_123","email":"real@example.com"}');
    expect(body).toContain(
      'window.currentUser=window.currentUser||{"id":"user_real_123","email":"real@example.com"};'
    );
  });

  it("returns fileDiffs from /api/dry-run", async () => {
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Dry run",
      warnings: [],
      patchResults: [
        { filePath: "src/foo.ts", status: "applied" },
      ],
      fileDiffs: [
        {
          filePath: "src/foo.ts",
          before: "export const foo = 1;",
          after: "export const foo = 2;",
          diff: [
            { type: "removed", content: "export const foo = 1;", lineNumber: 1 },
            { type: "added", content: "export const foo = 2;", lineNumber: 1 },
          ],
          addedLines: 1,
          removedLines: 1,
        },
      ],
      applyPatches: [
        {
          filePath: "src/foo.ts",
          fullContent: "export const foo = 2;",
        },
      ],
    });

    const response = await fetch(`${baseUrl}/api/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "update foo",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fileDiffs).toHaveLength(1);
    expect(body.patchResults).toEqual([
      { filePath: "src/foo.ts", status: "applied" },
    ]);
  });

  it("proxies hosted dry-run requests with hostedContext", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    scanRepoMock.mockResolvedValue([
      {
        path: "src/foo.ts",
        absolutePath: "C:/repo/src/foo.ts",
        extension: "ts",
        category: "backend",
      },
    ]);
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/src/foo.ts": "export const foo = 1;",
    });

    let forwardedBody: Record<string, unknown> | undefined;
    const hostedServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        forwardedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            patchPreview: "=== HOSTED DRY RUN ===",
            warnings: [],
            patchResults: [],
            fileDiffs: [],
            applyPatches: [],
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(`${baseUrl}/api/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "update foo",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      patchPreview: "=== HOSTED DRY RUN ===",
      warnings: [],
      patchResults: [],
      fileDiffs: [],
      applyPatches: [],
    });
    expect(forwardedBody).toEqual(
      expect.objectContaining({
        task: "update foo",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
        hostedContext: expect.objectContaining({
          repoSummary: expect.any(String),
          contextFiles: [
            expect.objectContaining({
              path: "src/foo.ts",
              content: "export const foo = 1;",
            }),
          ],
          originalContents: {
            "src/foo.ts": "export const foo = 1;",
          },
        }),
      })
    );
    expect(runLlmPatchFlowMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("logs successful dry runs to Supabase when env is configured", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Dry run",
      warnings: [],
      developerConfidence: 74,
      decisionMode: "safe_to_apply",
      patchResults: [],
      fileDiffs: [],
      applyPatches: [],
    });
    supabaseInsertMock.mockResolvedValue({ error: null });
    supabaseRpcMock.mockResolvedValue({ error: null });

    const response = await fetch(`${baseUrl}/api/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "preview login fix",
        repoPath: "C:/repo",
        userId: "clerk_user_789",
      }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(supabaseInsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: "clerk_user_789",
          role: "developer",
          task: "preview login fix",
          repo_path: "C:/repo",
          decision: "safe_to_apply",
          confidence: 74,
          credits_used: 0.1,
        })
      );
      expect(supabaseRpcMock).toHaveBeenCalledWith(
        "deduct_credits_and_increment_runs",
        {
          p_user_id: "clerk_user_789",
          p_credits: 1,
        }
      );
    });
  });

it("logs successful developer runs to Supabase when env is configured", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

  // ensureRunAuthorized + logRun profile read için
  supabaseProfileMaybeSingleMock.mockResolvedValue({
    data: { credits: 20, subscription_status: "free" },
    error: null,
  });

  runLlmPatchFlowMock.mockResolvedValue({
    ok: true,
    patchPreview: "=== LLM PATCH PREVIEW ===",
    warnings: [],
    developerConfidence: 78,
    decisionMode: "safe_to_apply",
    applyPatches: [],
    patchResults: [],
  });
  supabaseInsertMock.mockResolvedValue({ error: null });
  supabaseRpcMock.mockResolvedValue({ error: null });

  // ... rest of test

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "fix login validation",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(createSupabaseClientMock).toHaveBeenCalledWith(
        "https://example.supabase.co",
        "service-role"
      );
      expect(supabaseFromMock).toHaveBeenCalledWith("run_logs");
      expect(supabaseInsertMock).toHaveBeenCalledWith({
        user_id: "clerk_user_123",
        role: "developer",
        task: "fix login validation",
        repo_path: "C:/repo",
        decision: "safe_to_apply",
        confidence: 78,
        credits_used: 0.1,
      });
      expect(supabaseRpcMock).toHaveBeenCalledWith(
        "deduct_credits_and_increment_runs",
        {
          p_user_id: "clerk_user_123",
          p_credits: 1,
        }
      );
    });
  });

  it("skips Supabase logging silently when Supabase env is missing", async () => {
    runTestEngineerFlowMock.mockResolvedValue({
      ok: true,
      framework: "playwright_ts",
      language: "typescript",
      confidence: 82,
      summary: "Generated test",
      warnings: [],
      complexity: "single_scenario",
      decisionMode: "safe_to_apply",
      applyPatches: [],
      preview: "preview",
    });

    const response = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createSupabaseClientMock).not.toHaveBeenCalled();
    expect(supabaseInsertMock).not.toHaveBeenCalled();
  });

  it("logs successful data analyst runs with derived decision mode", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    runDataAnalystFlowMock.mockResolvedValue({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 62,
      summary: "Adds report table",
      warnings: [],
      applyPatches: [],
      fileDiffs: [],
      preview: "preview",
    });
    supabaseInsertMock.mockResolvedValue({ error: null });
    supabaseRpcMock.mockResolvedValue({ error: null });

    const response = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add reporting table",
        repoPath: "C:/repo",
        userId: "clerk_user_456",
      }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(supabaseInsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "data_analyst",
          decision: "preview_only",
          confidence: 62,
          credits_used: 0.06,
        })
      );
      expect(supabaseRpcMock).toHaveBeenCalledWith(
        "deduct_credits_and_increment_runs",
        {
          p_user_id: "clerk_user_456",
          p_credits: 1,
        }
      );
    });
  });

  it("maps unsupported test framework failures to the product-friendly test engineer message", async () => {
    runTestEngineerFlowMock.mockResolvedValue({
      ok: false,
      reason: "Could not detect a test framework in this repository.",
      framework: "unknown",
    });

    const response = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      reason:
        "No supported test setup detected\n\n" +
        "Zone Test Engineer needs an existing supported test setup in this folder.\n" +
        "Supported: Playwright, Cypress, Cucumber+Java, Selenium (Java/Python), TestNG, or pytest.",
      framework: "unknown",
    });
  });

  it("maps missing schema context failures to the product-friendly data analyst message", async () => {
    runDataAnalystFlowMock.mockResolvedValue({
      ok: false,
      reason: "detectDataSchema failed: no schema context found",
      dialect: "unknown",
    });

    const response = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "create orders table",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      reason:
        "No database context detected\n\n" +
        "Zone Data Analyst needs existing schema or migration context in this folder.\n" +
        "Supported signals include SQL migrations, Alembic, Flyway, Liquibase, or existing database files.",
      dialect: "unknown",
    });
  });

  it("returns an enhanced task from /api/enhance-task", async () => {
    scanRepoMock.mockResolvedValue([
      {
        path: "tests/login.spec.ts",
        absolutePath: "C:/repo/tests/login.spec.ts",
      },
      {
        path: "tests/cart.spec.ts",
        absolutePath: "C:/repo/tests/cart.spec.ts",
      },
      {
        path: "src/app.ts",
        absolutePath: "C:/repo/src/app.ts",
      },
    ]);
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/tests/cart.spec.ts": "test('cart', async () => {});",
      "C:/repo/tests/login.spec.ts": "test('login', async () => {});",
    });
    responsesCreateMock.mockResolvedValue({
      output_text:
        "Extend tests/login.spec.ts with a negative invalid-credentials Playwright test that reuses the existing login flow and asserts the real error state.",
    });

    const response = await fetch(`${baseUrl}/api/enhance-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        role: "test_engineer",
        repoPath: "C:/repo",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      enhancedTask:
        "Extend tests/login.spec.ts with a negative invalid-credentials Playwright test that reuses the existing login flow and asserts the real error state.",
    });
    expect(scanRepoMock).toHaveBeenCalledWith("C:/repo");
    expect(readProjectFilesMock).toHaveBeenCalledWith([
      "C:/repo/tests/cart.spec.ts",
      "C:/repo/tests/login.spec.ts",
    ]);
    expect(createOpenAIClientMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        instructions: expect.stringContaining("You are a task optimizer"),
        input: expect.stringContaining("User task: add login test"),
      })
    );
  });

  it("proxies hosted enhance-task requests with hosted context", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    scanRepoMock.mockResolvedValue([
      {
        path: "tests/login.spec.ts",
        absolutePath: "C:/repo/tests/login.spec.ts",
      },
    ]);
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/tests/login.spec.ts": "test('login', async () => {});",
    });

    let forwardedBody: Record<string, unknown> | undefined;
    const hostedServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        forwardedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            enhancedTask: "Extend tests/login.spec.ts with a negative login test.",
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(`${baseUrl}/api/enhance-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        role: "test_engineer",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      enhancedTask: "Extend tests/login.spec.ts with a negative login test.",
    });
    expect(forwardedBody).toEqual(
      expect.objectContaining({
        task: "add login test",
        role: "test_engineer",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
        hostedContext: {
          contextFiles: [
            {
              path: "tests/login.spec.ts",
              content: "test('login', async () => {});",
            },
          ],
        },
      })
    );
    expect(createOpenAIClientMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("proxies hosted test-engineer requests with hosted context", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    let forwardedBody: Record<string, unknown> | undefined;
    const hostedServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        forwardedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            framework: "playwright_ts",
            language: "typescript",
            confidence: 82,
            decisionMode: "safe_to_apply",
            summary: "Generated test",
            warnings: [],
            applyPatches: [],
            fileDiffs: [],
            preview: "preview",
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        repoPath: "C:/repo",
        runId: "run-123",
        userId: "clerk_user_123",
        hostedContext: {
          availableFiles: [
            {
              path: "package.json",
              category: "unknown",
              extension: "json",
            },
            {
              path: "playwright.config.ts",
              category: "unknown",
              extension: "ts",
            },
            {
              path: "tests/login.spec.ts",
              category: "unknown",
              extension: "ts",
            },
          ],
          pageObjectContents: [],
          stepDefinitionContents: [],
          featureContents: [],
          existingTestContents: [
            {
              path: "tests/login.spec.ts",
              content:
                "import { test } from '@playwright/test'; test('login', async () => {});",
            },
          ],
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      framework: "playwright_ts",
      language: "typescript",
      confidence: 82,
      decisionMode: "safe_to_apply",
      summary: "Generated test",
      warnings: [],
      applyPatches: [],
      fileDiffs: [],
      preview: "preview",
    });
    expect(forwardedBody).toEqual(
      expect.objectContaining({
        task: "add login test",
        repoPath: "C:/repo",
        runId: "run-123",
        userId: "clerk_user_123",
        hostedContext: {
          availableFiles: [
            {
              path: "package.json",
              category: "unknown",
              extension: "json",
            },
            {
              path: "playwright.config.ts",
              category: "unknown",
              extension: "ts",
            },
            {
              path: "tests/login.spec.ts",
              category: "unknown",
              extension: "ts",
            },
          ],
          pageObjectContents: [],
          stepDefinitionContents: [],
          featureContents: [],
          existingTestContents: [
            {
              path: "tests/login.spec.ts",
              content:
                "import { test } from '@playwright/test'; test('login', async () => {});",
            },
          ],
        },
      })
    );
    expect(runTestEngineerFlowMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("proxies hosted data-analyst requests with hosted context", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    scanRepoMock.mockResolvedValue([
      {
        path: "db/migration/V3__orders.sql",
        absolutePath: "C:/repo/db/migration/V3__orders.sql",
        extension: "sql",
        category: "unknown",
      },
    ]);
    detectDataSchemaMock.mockReturnValue({
      dialect: "postgresql",
      migrationFormat: "flyway",
    });
    buildDataAnalystContextMock.mockReturnValue({
      existingSqlFiles: [
        {
          path: "db/migration/V3__orders.sql",
          absolutePath: "C:/repo/db/migration/V3__orders.sql",
        },
      ],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/db/migration/V3__orders.sql": "CREATE TABLE orders(id SERIAL PRIMARY KEY);",
    });

    let forwardedBody: Record<string, unknown> | undefined;
    const hostedServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        forwardedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            dialect: "postgresql",
            migrationFormat: "flyway",
            confidence: 90,
            summary: "Creates orders table",
            warnings: [],
            applyPatches: [],
            fileDiffs: [],
            preview: "preview",
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "create orders table",
        repoPath: "C:/repo",
        runId: "run-456",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 90,
      summary: "Creates orders table",
      warnings: [],
      applyPatches: [],
      fileDiffs: [],
      preview: "preview",
    });
    expect(forwardedBody).toEqual(
      expect.objectContaining({
        task: "create orders table",
        repoPath: "C:/repo",
        runId: "run-456",
        userId: "clerk_user_123",
        hostedContext: {
          availableFiles: [
            {
              path: "db/migration/V3__orders.sql",
              category: "unknown",
              extension: "sql",
            },
          ],
          schema: {
            dialect: "postgresql",
            migrationFormat: "flyway",
          },
          existingSqlContents: [
            {
              path: "db/migration/V3__orders.sql",
              content: "CREATE TABLE orders(id SERIAL PRIMARY KEY);",
            },
          ],
        },
      })
    );
    expect(runDataAnalystFlowMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns the billing summary from the authenticated profile", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 7,
        subscription_status: "free",
      },
      error: null,
    });

    const response = await fetch(
      `${baseUrl}/api/billing-summary?userId=clerk_user_123`
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      plan: "Free",
      credits: 7,
      subscriptionStatus: "free",
    });
  });

  it("returns ok from /api/check-access for a free user with remaining runs", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 5,
        subscription_status: "free",
      },
      error: null,
    });

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("returns unauthorized from /api/check-access when userId is missing", async () => {
    const response = await fetch(`${baseUrl}/api/check-access`);

    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      reason: "unauthorized",
      message: "Missing user session. Please open Zone from your dashboard.",
    });
  });

  it("returns no_free_runs from /api/check-access for an exhausted free user", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 0,
        subscription_status: "free",
      },
      error: null,
    });

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();
    expect(response.status).toBe(402);
    expect(body).toEqual({
      ok: false,
      reason: "no_free_runs",
      message: "You've used all your free runs. Upgrade to Pro.",
      upgradeUrl: "https://zonecli.dev/#pricing",
    });
  });

  it("returns ok from /api/check-access for a pro user even with zero credits", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 0,
        subscription_status: "pro",
      },
      error: null,
    });

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("returns a pro billing summary shape the UI can render", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 0,
        subscription_status: "pro",
      },
      error: null,
    });

    const response = await fetch(
      `${baseUrl}/api/billing-summary?userId=clerk_user_123`
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      plan: "Pro",
      credits: 0,
      subscriptionStatus: "pro",
    });
  });

  it("proxies hosted patch requests without using the local developer flow", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    scanRepoMock.mockResolvedValue([
      {
        path: "src/components/LoginForm.tsx",
        absolutePath: "C:/repo/src/components/LoginForm.tsx",
        extension: "tsx",
        category: "frontend",
      },
    ]);
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/src/components/LoginForm.tsx": "export function LoginForm() {}",
    });
    let forwardedHeaders: Headers | undefined;
    let forwardedBody: Record<string, unknown> | undefined;
    const hostedServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        forwardedHeaders = new Headers(req.headers as Record<string, string>);
        forwardedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            patchPreview: "=== HOSTED PATCH ===",
            warnings: [],
            applyPatches: [],
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        Cookie: "session=test",
      },
      body: JSON.stringify({
        task: "fix login validation",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      patchPreview: "=== HOSTED PATCH ===",
      warnings: [],
      applyPatches: [],
    });
    expect(runLlmPatchFlowMock).not.toHaveBeenCalled();
    expect(forwardedBody).toEqual(
      expect.objectContaining({
        task: "fix login validation",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
        hostedContext: expect.objectContaining({
          repoSummary: "React-like frontend detected",
          contextFiles: [
            expect.objectContaining({
              path: "src/components/LoginForm.tsx",
              content: "export function LoginForm() {}",
            }),
          ],
          originalContents: {
            "src/components/LoginForm.tsx": "export function LoginForm() {}",
          },
        }),
      })
    );
    expect(forwardedHeaders?.get("authorization")).toBe("Bearer test-token");
    expect(forwardedHeaders?.get("cookie")).toContain("session=test");
    expect(forwardedHeaders?.get("x-zone-user-id")).toBe("clerk_user_123");

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns a service-style hosted error instead of a local key error in hosted mode", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    getHostedInferenceBaseUrlMock.mockReturnValue("http://127.0.0.1:1");
    scanRepoMock.mockResolvedValue([
      {
        path: "tests/login.spec.ts",
        absolutePath: "C:/repo/tests/login.spec.ts",
      },
    ]);
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/tests/login.spec.ts": "test('login', async () => {});",
    });

    const response = await fetch(`${baseUrl}/api/enhance-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "add login test",
        role: "test_engineer",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.reason).toBe("hosted_inference_unavailable");
    expect(String(body.message)).toContain("Zone hosted inference is unavailable");
    expect(createOpenAIClientMock).not.toHaveBeenCalled();
  });

  it("falls back to local check-access when the hosted route returns 404", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    const hostedServer = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("bypasses self-proxy for /api/check-access and uses the local handler", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 5,
        subscription_status: "free",
      },
      error: null,
    });
    getHostedInferenceBaseUrlMock.mockReturnValue(baseUrl);

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(createSupabaseClientMock).toHaveBeenCalled();
  });

  it("falls back to local billing-summary when the hosted route returns 404", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    supabaseProfileMaybeSingleMock.mockResolvedValue({
      data: {
        credits: 3,
        subscription_status: "free",
      },
      error: null,
    });

    const hostedServer = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "not_found" }));
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(
      `${baseUrl}/api/billing-summary?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      plan: "Free",
      credits: 3,
      subscriptionStatus: "free",
    });

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("passes through hosted unauthorized responses from /api/check-access unchanged", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    const hostedServer = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          reason: "unauthorized",
          message: "Missing user session. Please open Zone from your dashboard.",
        })
      );
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      reason: "unauthorized",
      message: "Missing user session. Please open Zone from your dashboard.",
    });
    expect(createSupabaseClientMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("passes through hosted no_free_runs responses from /api/check-access unchanged", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    const hostedServer = createServer((_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          reason: "no_free_runs",
          message: "You've used all your free runs. Upgrade to Pro.",
          upgradeUrl: "https://zonecli.dev/#pricing",
        })
      );
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(
      `${baseUrl}/api/check-access?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body).toEqual({
      ok: false,
      reason: "no_free_runs",
      message: "You've used all your free runs. Upgrade to Pro.",
      upgradeUrl: "https://zonecli.dev/#pricing",
    });
    expect(createSupabaseClientMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("passes through hosted billing-summary responses unchanged", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    const hostedServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          plan: "Pro",
          credits: 0,
          subscriptionStatus: "pro",
        })
      );
    });

    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const hostedAddress = hostedServer.address();
    if (!hostedAddress || typeof hostedAddress === "string") {
      throw new Error("Hosted server address unavailable");
    }

    getHostedInferenceBaseUrlMock.mockReturnValue(
      `http://127.0.0.1:${hostedAddress.port}`
    );

    const response = await fetch(
      `${baseUrl}/api/billing-summary?userId=clerk_user_123`
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      plan: "Pro",
      credits: 0,
      subscriptionStatus: "pro",
    });
    expect(createSupabaseClientMock).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      hostedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("bypasses self-proxy for /api/patch and uses the local developer flow", async () => {
    getInferenceModeMock.mockReturnValue("hosted");
    getHostedInferenceBaseUrlMock.mockReturnValue(baseUrl);
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LOCAL PATCH ===",
      warnings: [],
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
    });

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "fix login validation",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      patchPreview: "=== LOCAL PATCH ===",
      warnings: [],
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
    });
    expect(runLlmPatchFlowMock).toHaveBeenCalled();
  });
});
