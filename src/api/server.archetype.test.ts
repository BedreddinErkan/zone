/**
 * L5.1b-3 integration tests: server-level classify-before-plan-gen reorder.
 * Verifies that generateExecutionPlan is gated by _serverPipelineCfg?.skipPlan
 * and that classifyTask is called before generateExecutionPlan.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

// ── mocks ──────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  generateExecutionPlan: vi.fn(),
  preparePlanContext: vi.fn(),
  classifyTask: vi.fn(),
  runLlmPatchFlow: vi.fn(),
  getUsage: vi.fn(),
  getRunCost: vi.fn(),
  emitDeveloperPatchProgress: vi.fn(),
}));

vi.mock("../core/runAgent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: mocks.runLlmPatchFlow,
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
vi.mock("../repo/scanRepo.js", () => ({ scanRepo: vi.fn(async () => []) }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: vi.fn() }));
vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: vi.fn(),
  getModelName: vi.fn(() => "gpt-4o-mini"),
  getInferenceMode: vi.fn(() => "local"),
  getHostedInferenceBaseUrl: vi.fn(() => "https://zonecli.dev"),
}));
vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai" as const,
    createChatCompletion: vi.fn(),
    createChatCompletionStream: vi.fn(),
    createEmbedding: vi.fn(),
  })),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
      insert: vi.fn(),
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: null, error: null })),
        })),
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
  getUsage: mocks.getUsage,
  getRunCost: mocks.getRunCost,
  recordExecution: vi.fn(),
  readDailyUsdCapOverride: vi.fn(() => undefined),
  recordRunSummary: vi.fn(),
}));
vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(() => undefined),
  TIER_LIMITS: { simple: {}, medium: {}, complex: {} },
  saveLimitConfig: vi.fn(),
  readLimitConfig: vi.fn(() => ({})),
  readAuditModeSetting: vi.fn(() => "auto" as const),
  readAutoAuditSetting: vi.fn(() => false),
  readTierSettings: vi.fn(() => ({})),
  writeTierSettings: vi.fn(),
  writeAuditModeSetting: vi.fn(),
  writeAutoAuditSetting: vi.fn(),
}));
vi.mock("../llm/executionPlan.js", () => ({
  generateExecutionPlan: mocks.generateExecutionPlan,
}));
vi.mock("../core/preparePlanContext.js", () => ({
  preparePlanContext: mocks.preparePlanContext,
}));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: mocks.classifyTask,
}));
vi.mock("../billing/activeRunsRepository.js", () => ({
  completeActiveRun: vi.fn(async () => undefined),
  getActiveRunsByUser: vi.fn(async () => []),
  markAllRunningAsInterrupted: vi.fn(async () => undefined),
  upsertActiveRun: vi.fn(async () => undefined),
}));
vi.mock("./runLogging.js", () => ({
  logRun: vi.fn(async () => null),
}));
vi.mock("../core/developerRunProgressSse.js", () => ({
  attachDeveloperPatchProgressSseClient: vi.fn(),
  closeDeveloperPatchProgressSseForRun: vi.fn(),
  detachDeveloperPatchProgressSseClient: vi.fn(),
  emitDeveloperPatchProgress: mocks.emitDeveloperPatchProgress,
  getRunBuffer: vi.fn(() => []),
  registerRunComplete: vi.fn(),
  registerRunStart: vi.fn(),
}));

import { app } from "./server.js";

// ── fixture ────────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-server-archetype-"));

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeClassification(archetype = "simple_add") {
  return {
    tier: "simple" as const,
    archetype,
    archetypeConfidence: 0.9,
    confidence: 0.9,
    estimatedFiles: 1,
    estimatedIterations: 2,
    classifierCostUsd: 0,
    classifierLatencyMs: 0,
    classifierModel: "gpt-4o-mini",
  };
}

beforeEach(() => {
  mocks.classifyTask.mockResolvedValue(makeClassification());
  mocks.generateExecutionPlan.mockResolvedValue({ objective: "mock plan", steps: [] });
  mocks.preparePlanContext.mockResolvedValue({ projectSummary: "", relevantFilePaths: [] });
  mocks.runLlmPatchFlow.mockResolvedValue({
    ok: true,
    patchPreview: "=== PATCH ===",
    warnings: [],
    applyPatches: [],
    patchResults: [],
    fileDiffs: [],
  });
  mocks.getUsage.mockResolvedValue({
    period: "day" as const,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  });
  mocks.getRunCost.mockReturnValue(0);
  process.env.ZONE_DAILY_USD_CAP = "0"; // unlimited cap
  delete process.env.ZONE_ARCHETYPE_DISPATCHER;
  delete process.env.ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD;
  delete process.env.ZONE_ARCHETYPE_ENABLE_TARGETED_FIX;
});

afterEach(() => {
  delete process.env.ZONE_ARCHETYPE_DISPATCHER;
  delete process.env.ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD;
  delete process.env.ZONE_ARCHETYPE_ENABLE_TARGETED_FIX;
  delete process.env.ZONE_DAILY_USD_CAP;
});

async function postPatch(extra: object = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "add helper",
      repoPath: tmpDir,
      runId: crypto.randomUUID(),
      mode: "patch",
      auditMode: "auto",
      ...extra,
    }),
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("L5.1b-3 plan-gen skip", () => {
  it("does not call generateExecutionPlan for simple_add when both env flags=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("simple_add"));

    await postPatch();

    expect(mocks.generateExecutionPlan).not.toHaveBeenCalled();
  });
});

describe("L5.1b-3 plan_summary SSE skip", () => {
  it("emits no plan_summary SSE event for simple_add when both env flags=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("simple_add"));

    await postPatch();

    const planSummaryCalls = mocks.emitDeveloperPatchProgress.mock.calls.filter(
      (c: unknown[]) => (c[1] as { stage?: string } | undefined)?.stage === "plan_summary"
    );
    expect(planSummaryCalls.length).toBe(0);
  });
});

describe("L5.1b-3 legacy path (env unset)", () => {
  it("calls generateExecutionPlan when dispatcher env flags are absent", async () => {
    // both flags unset → buildPipelineConfig returns null → skipPlan=undefined → plan gen runs

    await postPatch();

    expect(mocks.generateExecutionPlan).toHaveBeenCalledOnce();
  });
});

describe("L5.1b-3 wrong archetype", () => {
  it("calls generateExecutionPlan for targeted_fix even when both env flags=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("targeted_fix"));

    await postPatch();

    // targeted_fix has no pipeline config — plan gen must still run
    expect(mocks.generateExecutionPlan).toHaveBeenCalledOnce();
  });
});

describe("L5.1b-3 classify-before-plan-gen order", () => {
  it("invokes classifyTask before generateExecutionPlan", async () => {
    const callOrder: string[] = [];
    mocks.classifyTask.mockImplementation(async () => {
      callOrder.push("classifyTask");
      return makeClassification("simple_add");
    });
    mocks.preparePlanContext.mockImplementation(async () => {
      callOrder.push("preparePlanContext");
      return { projectSummary: "", relevantFilePaths: [] };
    });
    mocks.generateExecutionPlan.mockImplementation(async () => {
      callOrder.push("generateExecutionPlan");
      return { objective: "mock plan", steps: [] };
    });
    // no env flags → plan gen runs, so all three are called in order

    await postPatch();

    expect(callOrder[0]).toBe("classifyTask");
    expect(callOrder).toContain("generateExecutionPlan");
  });
});

// ── L5.2 targeted_fix pipeline tests ──────────────────────────────────────────

describe("L5.2 plan-gen skip", () => {
  it("does not call generateExecutionPlan for targeted_fix when both env flags=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_TARGETED_FIX = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("targeted_fix"));

    await postPatch();

    expect(mocks.generateExecutionPlan).not.toHaveBeenCalled();
  });
});

describe("L5.2 plan_summary SSE skip", () => {
  it("emits no plan_summary SSE for targeted_fix when both env flags=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_TARGETED_FIX = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("targeted_fix"));

    await postPatch();

    const planSummaryCalls = mocks.emitDeveloperPatchProgress.mock.calls.filter(
      (c: unknown[]) => (c[1] as { stage?: string } | undefined)?.stage === "plan_summary"
    );
    expect(planSummaryCalls.length).toBe(0);
  });
});

describe("L5.2 legacy path (targeted_fix flag unset)", () => {
  it("calls generateExecutionPlan for targeted_fix when ZONE_ARCHETYPE_ENABLE_TARGETED_FIX unset", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    // ZONE_ARCHETYPE_ENABLE_TARGETED_FIX deliberately absent
    mocks.classifyTask.mockResolvedValue(makeClassification("targeted_fix"));

    await postPatch();

    expect(mocks.generateExecutionPlan).toHaveBeenCalledOnce();
  });
});

describe("L5.2 wrong archetype for targeted_fix pipeline", () => {
  it("calls generateExecutionPlan for refactor even when targeted_fix flag=1", async () => {
    process.env.ZONE_ARCHETYPE_DISPATCHER = "1";
    process.env.ZONE_ARCHETYPE_ENABLE_TARGETED_FIX = "1";
    mocks.classifyTask.mockResolvedValue(makeClassification("refactor"));

    await postPatch();

    expect(mocks.generateExecutionPlan).toHaveBeenCalledOnce();
  });
});

describe("L5.2 iterCap constant shape", () => {
  it("TARGETED_FIX_PIPELINE.iterCap=15, SIMPLE_ADD_PIPELINE.iterCap=5", async () => {
    const { TARGETED_FIX_PIPELINE, SIMPLE_ADD_PIPELINE } = await import("../llm/archetypeDispatcher.js");
    expect(TARGETED_FIX_PIPELINE.iterCap).toBe(15);
    expect(SIMPLE_ADD_PIPELINE.iterCap).toBe(5);
  });
});
