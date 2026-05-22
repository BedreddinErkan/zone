/**
 * Phase D server tests: /api/investigate route — routing, validation,
 * no-plan-review contract, and result shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

// ── module-level mocks ────────────────────────────────────────────────────────

const runInvestigationFlowMock = vi.fn();
const runLlmPatchFlowMock = vi.fn();
const runAgentMock = vi.fn();
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
const supabaseConversationInsertMock = vi.fn();
const supabaseConversationCreateSingleMock = vi.fn();
const supabaseConversationMaybeSingleMock = vi.fn();
const supabaseConversationUpdateMock = vi.fn();
const supabaseConversationUpdateSingleMock = vi.fn();
const supabaseRpcMock = vi.fn();
const createDeveloperPatchJobMock = vi.fn();
const getDeveloperPatchJobMock = vi.fn();
const supabaseProfileMaybeSingleMock = vi.fn();
const supabaseSelectEqMock = vi.fn(() => ({ maybeSingle: async () => supabaseProfileMaybeSingleMock() }));
const supabaseSelectMock = vi.fn(() => ({ eq: supabaseSelectEqMock }));
const supabaseFromMock = vi.fn((table: string) => {
  if (table === "profiles") return { select: supabaseSelectMock };
  if (table === "conversations") {
    return {
      insert: supabaseConversationInsertMock,
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: supabaseConversationMaybeSingleMock })) })),
      update: supabaseConversationUpdateMock,
    };
  }
  return { insert: supabaseInsertMock };
});
const createSupabaseClientMock = vi.fn(() => ({ from: supabaseFromMock, rpc: supabaseRpcMock }));
const createOpenAIClientMock = vi.fn(() => ({
  provider: "openai" as const,
  createChatCompletion: responsesCreateMock,
  createChatCompletionStream: vi.fn(),
  createEmbedding: vi.fn(),
}));

vi.mock("../llm/investigationFlow.js", () => ({
  runInvestigationFlow: runInvestigationFlowMock,
  runChatAgentFlow: vi.fn(),
}));
vi.mock("../core/runAgent.js", () => ({ runAgent: runAgentMock }));
vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
  isIrrelevantDeveloperContextPath: vi.fn(() => false),
}));
vi.mock("../core/applyLlmPatches.js", () => ({ applyLlmPatches: applyLlmPatchesMock }));
vi.mock("../roles/runTestEngineerFlow.js", () => ({
  runTestEngineerFlow: runTestEngineerFlowMock,
  readExampleContents: readExampleContentsMock,
  readFeatureExampleContents: readFeatureExampleContentsMock,
}));
vi.mock("../roles/detectTestFramework.js", () => ({ detectTestFramework: detectTestFrameworkMock }));
vi.mock("../roles/testEngineerContext.js", () => ({ buildTestEngineerContext: buildTestEngineerContextMock }));
vi.mock("../roles/detectDataSchema.js", () => ({ detectDataSchema: detectDataSchemaMock }));
vi.mock("../roles/dataAnalystContext.js", () => ({ buildDataAnalystContext: buildDataAnalystContextMock }));
vi.mock("../roles/runDataAnalystFlow.js", () => ({ runDataAnalystFlow: runDataAnalystFlowMock }));
vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createOpenAIClientMock,
  getModelName: vi.fn(() => "gpt-4o-mini"),
  getInferenceMode: vi.fn(() => "local"),
  getHostedInferenceBaseUrl: vi.fn(() => "https://zonecli.dev"),
}));
vi.mock("../llm/factory.js", () => ({ createLLMClient: createOpenAIClientMock }));
vi.mock("@supabase/supabase-js", () => ({ createClient: createSupabaseClientMock }));
vi.mock("../jobs/developerPatchJobs.js", () => ({
  createDeveloperPatchJob: createDeveloperPatchJobMock,
  getDeveloperPatchJob: getDeveloperPatchJobMock,
}));

// ── shared investigation result fixture ───────────────────────────────────────

const INVESTIGATION_RESULT = {
  ok: true,
  decisionMode: "investigation",
  chatResponse: "## getRunCost References\n\n- `src/usage/usageTracker.ts:220` — definition\n- `src/api/server.ts:2790` — chat route\n- `src/api/server.ts:3126` — investigation route",
  responseHtml: "<h2>getRunCost References</h2>",
  contextFiles: ["src/usage/usageTracker.ts"],
  applyPatches: [],
  fileDiffs: [],
  toolCallLog: [{ tool: "search_in_files", args: { pattern: "getRunCost" }, result: "3 matches", success: true }],
};

// ── helpers ───────────────────────────────────────────────────────────────────

function setupAuthMocks() {
  supabaseProfileMaybeSingleMock.mockResolvedValue({
    data: { credits: 10, runs_used_this_month: 0, free_limit: 10, subscription_status: "free" },
    error: null,
  });
  supabaseConversationMaybeSingleMock.mockResolvedValue({ data: null, error: null });
  supabaseConversationInsertMock.mockReturnValue({
    select: vi.fn(() => ({ single: supabaseConversationCreateSingleMock })),
  });
  supabaseConversationCreateSingleMock.mockResolvedValue({ data: { id: "conv_test" }, error: null });
  supabaseConversationUpdateMock.mockReturnValue({
    eq: vi.fn(() => ({ select: vi.fn(() => ({ single: supabaseConversationUpdateSingleMock })) })),
  });
  supabaseConversationUpdateSingleMock.mockResolvedValue({ data: { id: "conv_test" }, error: null });
  detectTestFrameworkMock.mockReturnValue({ framework: "vitest", language: "typescript" });
  buildTestEngineerContextMock.mockReturnValue({ pageObjectFiles: [], stepDefinitionFiles: [], featureFiles: [], existingTestFiles: [] });
  detectDataSchemaMock.mockReturnValue({ dialect: "postgresql", migrationFormat: "flyway" });
  buildDataAnalystContextMock.mockReturnValue({ existingSqlFiles: [] });
  readExampleContentsMock.mockResolvedValue([]);
  readFeatureExampleContentsMock.mockResolvedValue([]);
}

describe("/api/investigate", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setupAuthMocks();
    process.env.VITEST = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ZONE_USER_ID;
    delete process.env.ZONE_USER_EMAIL;
    delete process.env.ZONE_DEBUG_FALLBACK_USER_ID;
    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("returns 200 with investigation result including costUsd", async () => {
    runInvestigationFlowMock.mockResolvedValue(INVESTIGATION_RESULT);

    const response = await fetch(`${baseUrl}/api/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "which files reference getRunCost?",
        repoPath: "/home/bedo/zone-api",
        runId: "run-invest-001",
        userId: "dev-user",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.decisionMode).toBe("investigation");
    expect(typeof body.costUsd).toBe("number");
    expect(body.applyPatches).toEqual([]);
    expect(body.fileDiffs).toEqual([]);
  });

  it("returns 400 when task is missing", async () => {
    const response = await fetch(`${baseUrl}/api/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: "/home/bedo/zone-api", userId: "dev-user" }),
    });

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/required/i);
  });

  it("returns 400 when repoPath is missing", async () => {
    const response = await fetch(`${baseUrl}/api/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "find getRunCost", userId: "dev-user" }),
    });

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it("response has no plan-review fields (investigation never plans)", async () => {
    runInvestigationFlowMock.mockResolvedValue(INVESTIGATION_RESULT);

    const response = await fetch(`${baseUrl}/api/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "find getRunCost usages",
        repoPath: "/home/bedo/zone-api",
        runId: "run-invest-002",
        userId: "dev-user",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("planRequired");
    expect(body).not.toHaveProperty("plan");
    expect(body).not.toHaveProperty("planApprovalRequired");
  });
});

describe("/api/patch back-compat: mode:'investigate' still routes to investigation flow", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setupAuthMocks();
    process.env.VITEST = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ZONE_USER_ID;
    delete process.env.ZONE_USER_EMAIL;
    delete process.env.ZONE_DEBUG_FALLBACK_USER_ID;
    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("POST /api/patch with mode:'investigate' returns investigation result (back-compat)", async () => {
    runInvestigationFlowMock.mockResolvedValue(INVESTIGATION_RESULT);

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "which files reference getRunCost?",
        repoPath: "/home/bedo/zone-api",
        runId: "run-compat-001",
        userId: "dev-user",
        mode: "investigate",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.decisionMode).toBe("investigation");
    expect(body.applyPatches).toEqual([]);
  });
});
