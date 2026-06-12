import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  let tmpRepoDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env["ZONE_FORCE_FLOW"] = "agent_loop";
    tmpRepoDir = mkdtempSync(join(tmpdir(), "zone-flow-test-"));

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
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("returns repo_not_accessible when path does not exist", async () => {
    const nonExistent = join(tmpdir(), `zone-nonexistent-${Date.now()}`);
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: nonExistent });
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("repo_not_accessible");
  });

  it("returns repo_not_accessible + emits narration event when path does not exist", async () => {
    const nonExistent = join(tmpdir(), `zone-nonexistent-${Date.now()}`);
    const onProgress = vi.fn();
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: nonExistent, runId: "test-run", onProgress });
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("repo_not_accessible");
    // The narration event must have been emitted via onProgress (the visible channel)
    const narrationCall = onProgress.mock.calls.find(
      (args: unknown[]) => {
        const upd = args[0] as { progress?: { type?: string } };
        return upd?.progress?.type === "narration";
      }
    );
    expect(narrationCall).toBeDefined();
  });

  it("regression: empty readable temp dir is NOT blocked (accessible empty dir must proceed)", async () => {
    scanRepoMock.mockResolvedValue([]);
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: tmpRepoDir });
    // Must NOT have hit the repo_not_accessible early-exit
    const reason = (result as { reason?: string }).reason;
    expect(reason).not.toBe("repo_not_accessible");
    // classifyTask called proves execution passed the scan gate
    expect(classifyTaskMock).toHaveBeenCalled();
  });

  it("proceeds past the scan gate when scanRepo returns an empty array (accessible empty dir)", async () => {
    scanRepoMock.mockResolvedValue([]);
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({ task: "add a feature", repoPath: tmpRepoDir });
    const reason = (result as { reason?: string }).reason;
    expect(reason).not.toBe("repo_not_accessible");
    expect(classifyTaskMock).toHaveBeenCalled();
  });

  it("empty dir routes to agent loop — reason=default_for_patch_tasks, not fallback_empty_repo", async () => {
    delete process.env["ZONE_FORCE_FLOW"];
    scanRepoMock.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log");
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({ task: "create a new Remotion video project", repoPath: tmpRepoDir });
    const flowBranchCall = logSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("[zone-flow-branch]")
    );
    expect(flowBranchCall).toBeDefined();
    const payload = JSON.parse(flowBranchCall![1] as string) as { branch: string; reason: string };
    expect(payload.branch).toBe("agent_loop");
    expect(payload.reason).toBe("default_for_patch_tasks");
    logSpy.mockRestore();
  });

  it("chmod-000 root → repo_not_accessible + narration (skipped as root)", async () => {
    if (process.geteuid?.() === 0) return; // root bypasses 000 permissions
    const lockedDir = mkdtempSync(join(tmpdir(), "zone-locked-root-"));
    chmodSync(lockedDir, 0o000);
    try {
      const onProgress = vi.fn();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({ task: "add a feature", repoPath: lockedDir, runId: "test-run", onProgress });
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("repo_not_accessible");
      const narrationCall = onProgress.mock.calls.find(
        (args: unknown[]) => {
          const upd = args[0] as { progress?: { type?: string } };
          return upd?.progress?.type === "narration";
        }
      );
      expect(narrationCall).toBeDefined();
    } finally {
      chmodSync(lockedDir, 0o755);
      rmSync(lockedDir, { recursive: true, force: true });
    }
  });
});
