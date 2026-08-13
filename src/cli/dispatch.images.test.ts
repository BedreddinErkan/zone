/**
 * T-THREAD: verifies that images passed in OneShotOpts propagate through the
 * dispatch → runLlmPatchFlow call chain. The 6-hop threading
 * (Composer → App → index → dispatch → runLlmPatchFlow → agentLoopBaseInput)
 * is covered here at the dispatch boundary: we pass images to runOneShotInner
 * and assert runLlmPatchFlow receives them with the same reference.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImageAttachment } from "../api/imageUpload.js";

const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingPlansForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockSetTrustAllForRun = vi.hoisted(() => vi.fn());
const mockBuildCliSink = vi.hoisted(() => vi.fn(() => ({ onProgress: vi.fn() })));
const mockCreateSpinner = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const mockPreparePlanContext = vi.hoisted(() => vi.fn());
const mockGenerateExecutionPlan = vi.hoisted(() => vi.fn());
const mockRequestPlanApproval = vi.hoisted(() => vi.fn());
const mockLoadDiskModelSync = vi.hoisted(() => vi.fn(() => null));
const mockRunPlanInvestigation = vi.hoisted(() => vi.fn());
const mockIsNoChangePlan = vi.hoisted(() => vi.fn());
const mockIsCannotVerifyPlan = vi.hoisted(() => vi.fn());

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: mockRunLlmPatchFlow,
  isChitchat: () => false,
  isVagueDeveloperTask: () => false,
}));
vi.mock("../api/commandApprovals.js", () => ({
  rejectPendingApprovalsForRun: mockRejectPendingApprovalsForRun,
  clearTrustedCommandsForRun: mockClearTrustedCommandsForRun,
  setTrustAllForRun: mockSetTrustAllForRun,
}));
vi.mock("../llm/revisionApprovals.js", () => ({ rejectPendingRevisionsForRun: mockRejectPendingRevisionsForRun }));
vi.mock("../llm/planApprovals.js", () => ({
  requestPlanApproval: mockRequestPlanApproval,
  rejectPendingPlansForRun: mockRejectPendingPlansForRun,
}));
vi.mock("./sink.js", () => ({ buildCliSink: mockBuildCliSink, createSpinner: mockCreateSpinner }));
vi.mock("../core/preparePlanContext.js", () => ({ preparePlanContext: mockPreparePlanContext }));
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    generateExecutionPlan: mockGenerateExecutionPlan,
    isNoChangePlan: mockIsNoChangePlan,
    isCannotVerifyPlan: mockIsCannotVerifyPlan,
    synthesizeMinimalPlan: (task: string) => ({ objective: task.slice(0, 200), steps: [{ title: "s", filesLikely: [] }] }),
    tryParseExecutionPlan: () => null,
  };
});
vi.mock("../visual/tierSettings.js", () => ({ readDailyUsdCapOverride: vi.fn() }));
vi.mock("../api/diskModel.js", () => ({ loadDiskModelSync: mockLoadDiskModelSync }));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));

import { runOneShotInner } from "./dispatch.js";

const BASE_CONFIG = {
  model: "claude-sonnet-4-6",
  provider: "anthropic" as const,
  anthropicApiKey: "sk-ant-test",
  openaiApiKey: undefined,
  dailyUsdCap: 10,
  repoPath: "/tmp/test-repo",
  forceTier: undefined,
  autoApprove: false,
  noRevision: false,
  verbose: false,
  quiet: true,
  noColor: true,
};

const TEST_IMAGES: ImageAttachment[] = [
  { mediaType: "image/png", base64: "abc123" },
];

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRunLlmPatchFlow.mockResolvedValue({ ok: true, decisionMode: "safe_to_apply" });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "TS project", relevantFilePaths: [] });
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockLoadDiskModelSync.mockReturnValue(null);
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("images threading — dispatch to runLlmPatchFlow (T-THREAD)", () => {
  it("images in OneShotOpts reach the runLlmPatchFlow call", async () => {
    await runOneShotInner("describe this image", BASE_CONFIG, "run-img-1", { images: TEST_IMAGES });

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["images"]).toBe(TEST_IMAGES);
  });

  it("no images in opts → images field is undefined in runLlmPatchFlow call", async () => {
    await runOneShotInner("regular task", BASE_CONFIG, "run-img-2", {});

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["images"]).toBeUndefined();
  });

  it("images are passed even when plan mode is active (quick path fallback)", async () => {
    mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
    mockGenerateExecutionPlan.mockResolvedValue({
      objective: "describe the image",
      steps: [{ title: "step", filesLikely: [] }],
    });
    mockRequestPlanApproval.mockResolvedValue({ ok: true, decision: "accept_all" });

    await runOneShotInner("describe this image", BASE_CONFIG, "run-img-3", { images: TEST_IMAGES });

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["images"]).toBe(TEST_IMAGES);
  });
});
