import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const supabaseConversationInsertMock = vi.fn();
const supabaseConversationCreateSingleMock = vi.fn();
const supabaseConversationMaybeSingleMock = vi.fn();
const supabaseConversationUpdateMock = vi.fn();
const supabaseConversationUpdateSingleMock = vi.fn();
const supabaseRpcMock = vi.fn();
const createDeveloperPatchJobMock = vi.fn();
const getDeveloperPatchJobMock = vi.fn();
const supabaseProfileMaybeSingleMock = vi.fn();
const getNormalizedProfileMaybeSingleResult = async () => {
  const result = await supabaseProfileMaybeSingleMock();
  if (!result || result.data == null) return result;
  return {
    ...result,
    data: {
      credits: 10,
      runs_used_this_month: 0,
      free_limit: 10,
      subscription_status: "free",
      ...result.data,
    },
  };
};
const supabaseSelectEqMock = vi.fn(() => ({ maybeSingle: getNormalizedProfileMaybeSingleResult }));
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
const createOpenAIClientMock = vi.fn(() => ({ provider: "openai" as const, createChatCompletion: responsesCreateMock, createChatCompletionStream: vi.fn(), createEmbedding: vi.fn() }));
const getModelNameMock = vi.fn(() => "gpt-4o-mini");
const getInferenceModeMock = vi.fn(() => "local");
const getHostedInferenceBaseUrlMock = vi.fn(() => "https://zonecli.dev");

vi.mock("../core/runAgent.js", () => ({ runAgent: runAgentMock }));
vi.mock("../core/runLlmPatchFlow.js", () => ({ runLlmPatchFlow: runLlmPatchFlowMock, isIrrelevantDeveloperContextPath: vi.fn(() => false) }));
vi.mock("../core/applyLlmPatches.js", () => ({ applyLlmPatches: applyLlmPatchesMock }));
vi.mock("../roles/runTestEngineerFlow.js", () => ({ runTestEngineerFlow: runTestEngineerFlowMock, readExampleContents: readExampleContentsMock, readFeatureExampleContents: readFeatureExampleContentsMock }));
vi.mock("../roles/detectTestFramework.js", () => ({ detectTestFramework: detectTestFrameworkMock }));
vi.mock("../roles/testEngineerContext.js", () => ({ buildTestEngineerContext: buildTestEngineerContextMock }));
vi.mock("../roles/detectDataSchema.js", () => ({ detectDataSchema: detectDataSchemaMock }));
vi.mock("../roles/dataAnalystContext.js", () => ({ buildDataAnalystContext: buildDataAnalystContextMock }));
vi.mock("../roles/runDataAnalystFlow.js", () => ({ runDataAnalystFlow: runDataAnalystFlowMock }));
vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/openaiClient.js", () => ({ createOpenAIClient: createOpenAIClientMock, getModelName: getModelNameMock, getInferenceMode: getInferenceModeMock, getHostedInferenceBaseUrl: getHostedInferenceBaseUrlMock }));
vi.mock("../llm/factory.js", () => ({ createLLMClient: createOpenAIClientMock }));
vi.mock("@supabase/supabase-js", () => ({ createClient: createSupabaseClientMock }));
vi.mock("../jobs/developerPatchJobs.js", () => ({ createDeveloperPatchJob: createDeveloperPatchJobMock, getDeveloperPatchJob: getDeveloperPatchJobMock }));

describe("/api/runs/:runId/subagents", () => {
  let server: Server;
  let baseUrl: string;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-subagents-"));
    process.env.VITEST = "true";
    process.env.ZONE_USER_ID = "test-user";
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server address unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns an empty array when no subagents exist", async () => {
    fs.writeFileSync(path.join(tempDir, ".zone", "usage", "test-user.jsonl"), "", "utf8");
    const response = await fetch(`${baseUrl}/api/runs/run-1/subagents`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ runId: "run-1", subagents: [], totalSubagents: 0, aggregateCost: 0 });
  });

  it("aggregates one worker subagent", async () => {
    const file = path.join(tempDir, ".zone", "usage", "test-user.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ parentRunId: "run-2", subagentId: "sub-1", subagentType: "worker", input_tokens: 10, output_tokens: 5, est_cost_usd: 0.01, model: "gpt-a", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ parentRunId: "run-2", subagentId: "sub-1", subagentType: "worker", input_tokens: 20, output_tokens: 15, est_cost_usd: 0.02, model: "gpt-a", timestamp: "2026-01-01T00:05:00.000Z" }),
    ].join("\n"), "utf8");
    const response = await fetch(`${baseUrl}/api/runs/run-2/subagents`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      runId: "run-2",
      subagents: [
        {
          subagentId: "sub-1",
          subagentType: "worker",
          llmCallCount: 2,
          totalInputTokens: 30,
          totalOutputTokens: 20,
          totalCost: 0.03,
          model: "gpt-a",
          firstCallAt: "2026-01-01T00:00:00.000Z",
          lastCallAt: "2026-01-01T00:05:00.000Z",
        },
      ],
      totalSubagents: 1,
      aggregateCost: 0.03,
    });
  });

  it("returns two workers and excludes empty subagent context records", async () => {
    const file = path.join(tempDir, ".zone", "usage", "test-user.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ parentRunId: "run-3", subagentId: "sub-1", subagentType: "worker", input_tokens: 10, output_tokens: 1, est_cost_usd: 0.01, model: "gpt-a", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ parentRunId: "run-3", subagentId: "sub-2", subagentType: "worker", input_tokens: 8, output_tokens: 2, est_cost_usd: 0.02, model: "gpt-b", timestamp: "2026-01-01T00:02:00.000Z" }),
      JSON.stringify({ parentRunId: "run-3", subagentId: "", subagentType: "worker", input_tokens: 99, output_tokens: 99, est_cost_usd: 0.99, model: "gpt-z", timestamp: "2026-01-01T00:03:00.000Z" }),
      JSON.stringify({ runId: "run-3", input_tokens: 11, output_tokens: 11, est_cost_usd: 0.11, model: "gpt-z", timestamp: "2026-01-01T00:04:00.000Z" }),
    ].join("\n"), "utf8");
    const response = await fetch(`${baseUrl}/api/runs/run-3/subagents`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.totalSubagents).toBe(2);
    expect(body.subagents).toHaveLength(2);
    expect(body.aggregateCost).toBe(0.03);
    expect(body.subagents.map((x: { subagentId: string }) => x.subagentId)).toEqual(["sub-1", "sub-2"]);
  });
});
