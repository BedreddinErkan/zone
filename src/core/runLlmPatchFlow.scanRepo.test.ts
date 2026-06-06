import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All vi.mock calls must be at the top level (hoisted).
const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const classifyTaskMock = vi.fn();
const runAgentLoopMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));
vi.mock("../llm/agentLoop.js", () => ({
  runAgentLoop: runAgentLoopMock,
  stripVerificationTag: vi.fn((s: string) => s),
}));
vi.mock("./runRuntimeVerification.js", () => ({
  runRuntimeVerificationPlan: vi.fn().mockResolvedValue({
    attempted: false,
    status: "skipped_no_command",
    steps: [],
    summary: "No safe verification command detected.",
  }),
}));

describe("runLlmPatchFlow scanRepo empty-vs-throws blocking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["ZONE_FORCE_FLOW"] = "agent_loop";

    detectProjectStructureMock.mockReturnValue({ notes: [] });
    rankRelevantFilesMock.mockReturnValue([]);
    readProjectFilesMock.mockResolvedValue({});
    classifyTaskMock.mockResolvedValue({
      tier: "simple",
      archetype: "simple_add",
      confidence: 0.9,
      archetypeConfidence: 0.9,
      fallbackUsed: false,
    });
    runAgentLoopMock.mockResolvedValue({
      success: true,
      summary: "mock agent loop",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "natural_completion",
      iterCount: 1,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });
  });

  afterEach(() => {
    delete process.env["ZONE_FORCE_FLOW"];
  });

  it("returns repo_not_accessible when scanRepo throws (unreadable directory)", async () => {
    scanRepoMock.mockRejectedValue(new Error("EACCES: permission denied"));
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: "/unreadable" });
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("repo_not_accessible_in_hosted_mode");
  });

  it("proceeds past the scan gate when scanRepo returns an empty array (accessible empty dir)", async () => {
    scanRepoMock.mockResolvedValue([]);
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: "/empty-greenfield" });
    // The run must NOT have hit the repo_not_accessible early-exit.
    const reason = (result as { reason?: string }).reason;
    expect(reason).not.toBe("repo_not_accessible_in_hosted_mode");
    // classifyTask must have been called — proves execution passed the scan gate.
    expect(classifyTaskMock).toHaveBeenCalled();
  });
});
