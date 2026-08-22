/**
 * Item 275: fetch_url is excluded on refactor and complex_multi_file — the two archetypes
 * scopeGuard.ts's checkWriteScope bypasses unconditionally, so nothing else stands between
 * fetched text and a write on those two.
 *
 * The fix has two parts, and this file exercises both through the real production call site
 * rather than asserting on hand-built filter objects:
 *   1. A new archetype-gated exclusion, merged additively into `_dispatcherCapabilityFilter`.
 *   2. A new spread that delivers that filter into `agentLoopBaseInput` when `pipelineCfg` is
 *      null — closing a pre-existing gap for `complex_multi_file` (whose pipelineCfg is always
 *      null), the same class of gap the file's own R4 tests document for `debug`.
 *
 * Mirrors runLlmPatchFlow.terminationReasonProbe.test.ts's R4 pattern exactly: mock everything
 * around runLlmPatchFlow EXCEPT agentLoop.js, force a specific archetype through the real
 * classifier seam, and read the real tool array off the real request a mocked
 * createChatCompletion receives. A hand-built filter object would prove the filter is
 * constructed correctly; it would not prove it reaches the model, which is exactly where the
 * complex_multi_file gap lived.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { TaskClassification } from "../llm/taskClassifier.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const runRuntimeVerificationPlanMock = vi.fn();
const classifyTaskMock = vi.fn();

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/planPatchPreview.js", () => ({ planPatchPreviewWithLlm: planPatchPreviewWithLlmMock }));
vi.mock("./runRuntimeVerification.js", () => ({ runRuntimeVerificationPlan: runRuntimeVerificationPlanMock }));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));
// Deliberately NOT mocked: ../llm/agentLoop.js — the point is to prove the filter reaches the
// real request, not to assert on an intermediate value production never actually consumes.
vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({ provider: "anthropic", createChatCompletion: mocks.createChatCompletion })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

function buildRepoFile(p: string, category: RepoFile["category"] = "source"): RepoFile {
  return { path: p, absolutePath: `/tmp/fake-repo/${p}`, extension: p.split(".").pop() ?? "", category };
}

const REPO_FILES = [buildRepoFile("src/index.ts")];

/** Non-empty steps, no answerOnlyReason — isAnswerOnlyRun stays false, which is the case this
 *  fix is actually for. The narrow isAnswerOnlyRun path already had its own filter-delivery fix
 *  (R4, this file's sibling); this fix is for every other run. */
const NORMAL_PLAN = {
  objective: "Refactor the thing",
  steps: [{ title: "Refactor it", description: "Do the refactor.", filesLikely: ["src/index.ts"] }],
  scopeSummary: "Refactor the thing",
  riskHints: [],
};

/** tier: "complex" is load-bearing, not incidental — fetch_url is complex-tier-only
 *  (tierToolSubsets.ts omits it from both the 5-tool simple and 9-tool medium subsets), so a
 *  test left at some other tier would pass whether or not this fix exists. */
function classificationFor(archetype: TaskClassification["archetype"]): TaskClassification {
  return {
    tier: "complex",
    estimatedFiles: 2,
    estimatedIterations: 8,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1000,
    classifierModel: "claude-haiku-4-5",
    fallbackUsed: false,
    archetype,
    archetypeConfidence: 0.9,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
  vi.clearAllMocks();
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  runRuntimeVerificationPlanMock.mockResolvedValue({
    attempted: false, status: "skipped_no_command", steps: [], summary: "No safe verification command detected.",
  });
  scanRepoMock.mockResolvedValue(REPO_FILES);
  detectProjectStructureMock.mockReturnValue({ notes: ["Node.js"] });
  rankRelevantFilesMock.mockReturnValue([{ ...REPO_FILES[0]!, score: 10 }]);
  readProjectFilesMock.mockResolvedValue({});
  planPatchPreviewWithLlmMock.mockResolvedValue({ patches: [] });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

/** Drives one run to a single, immediate "Done." response and returns every tool name present
 *  in the first (only) request's `tools` array. `toolNames` starts empty, so
 *  `toBeGreaterThan(0)` below fails on its own if the mock is never invoked with a populated
 *  `tools` array — the positive control, checked by construction rather than assumed. */
async function offeredToolNames(archetype: TaskClassification["archetype"]): Promise<string[]> {
  classifyTaskMock.mockResolvedValue(classificationFor(archetype));

  let toolNames: string[] = [];
  mocks.createChatCompletion.mockImplementation(
    async (params: { tools?: Array<{ function?: { name?: string } }> }) => {
      if (toolNames.length === 0 && params.tools) {
        toolNames = params.tools.map((t) => t.function?.name ?? "");
      }
      return {
        choices: [{ message: { content: "Done.", tool_calls: null }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  );

  const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
  await runLlmPatchFlow({
    task: `do a ${archetype} task`,
    repoPath: "/tmp/fake-repo",
    runId: `run-fetch-url-placement-${archetype}`,
    onProgress: () => undefined,
    abortSignal: new AbortController().signal,
    userApiKey: "sk-fake",
    provider: "anthropic",
    mode: "patch",
    preGeneratedPlan: NORMAL_PLAN,
  });

  return toolNames;
}

describe("item 275: fetch_url excluded on refactor and complex_multi_file", () => {
  it("refactor: fetch_url absent, write tools present", async () => {
    const toolNames = await offeredToolNames("refactor");

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("write_file");
    expect(toolNames).not.toContain("fetch_url");
  });

  it("complex_multi_file: fetch_url absent, write tools present — exercises the new delivery spread", async () => {
    // Without the new spread, this fails even with the exclusion block in place: pipelineCfg is
    // always null for complex_multi_file, so the pre-existing pipelineCfg-gated spread never
    // runs and the exclusion never reaches agentLoopBaseInput.
    const toolNames = await offeredToolNames("complex_multi_file");

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("write_file");
    expect(toolNames).not.toContain("fetch_url");
  });

  it("contrast — targeted_fix: fetch_url still present (exclusion is scoped to exactly two archetypes)", async () => {
    const toolNames = await offeredToolNames("targeted_fix");

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("fetch_url");
  });

  it("debug: fetch_url still present — pins that the new spread stays dead for debug today", async () => {
    // The new spread's condition is archetype-agnostic (!pipelineCfg && !isAnswerOnlyRun &&
    // _dispatcherCapabilityFilter): it fires for ANY null-pipeline archetype the moment
    // something sets the filter. debug has a null pipeline too, and nothing in this pass
    // excludes anything for it — but that is a fact about today's code, not a guarantee the
    // spread's shape provides on its own. This pins it so a future change that adds a debug
    // exclusion breaks this test loudly, rather than silently riding in on a spread condition
    // nobody remembered was archetype-agnostic.
    const toolNames = await offeredToolNames("debug");

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("fetch_url");
  });
});
