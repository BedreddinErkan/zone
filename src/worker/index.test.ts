import { beforeEach, describe, expect, it, vi } from "vitest";

const runLlmPatchFlowMock = vi.fn();
const validateLlmOutputMock = vi.fn();
const claimNextQueuedDeveloperPatchJobMock = vi.fn();
const markDeveloperPatchJobCompletedMock = vi.fn();
const markDeveloperPatchJobFailedMock = vi.fn();
const updateDeveloperPatchJobProgressMock = vi.fn();
const queueRunLogMock = vi.fn();
const createSupabaseClientMock = vi.fn(() => ({}));

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
}));

vi.mock("../core/validateLlmOutput.js", () => ({
  validateLlmOutput: validateLlmOutputMock,
}));

vi.mock("../jobs/developerPatchJobs.js", () => ({
  claimNextQueuedDeveloperPatchJob: claimNextQueuedDeveloperPatchJobMock,
  markDeveloperPatchJobCompleted: markDeveloperPatchJobCompletedMock,
  markDeveloperPatchJobFailed: markDeveloperPatchJobFailedMock,
  updateDeveloperPatchJobProgress: updateDeveloperPatchJobProgressMock,
}));

vi.mock("../api/runLogging.js", () => ({
  queueRunLog: queueRunLogMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createSupabaseClientMock,
}));

describe("developer patch worker", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.VITEST = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  });

  it("processes a queued developer job and stores the completed result", async () => {
    claimNextQueuedDeveloperPatchJobMock.mockResolvedValue({
      id: "job_123",
      request_payload: {
        task: "fix login flow",
        repoPath: "C:/repo",
        userId: "clerk_user_123",
        isByok: false,
      },
    });
    runLlmPatchFlowMock.mockImplementation(async ({ onProgress }) => {
      onProgress?.("Planning feature...");
      onProgress?.("Ready");
      return {
        ok: true,
        patchPreview: "=== LLM PATCH PREVIEW ===",
        warnings: [],
        developerConfidence: 81,
        decisionMode: "safe_to_apply",
        applyPatches: [],
        patchResults: [],
        fileDiffs: [],
      };
    });
    validateLlmOutputMock.mockReturnValue({
      verdict: "pass",
      issues: [],
    });

    const { processNextDeveloperPatchJob } = await import("./index.js");
    const processed = await processNextDeveloperPatchJob();

    expect(processed).toBe(true);
    expect(runLlmPatchFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "fix login flow",
        repoPath: "C:/repo",
      })
    );
    expect(updateDeveloperPatchJobProgressMock).toHaveBeenCalledWith(
      expect.any(Object),
      "job_123",
      "Planning feature..."
    );
    expect(markDeveloperPatchJobCompletedMock).toHaveBeenCalledWith(
      expect.any(Object),
      "job_123",
      expect.objectContaining({
        ok: true,
        decisionMode: "safe_to_apply",
      })
    );
    expect(queueRunLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "clerk_user_123",
        role: "developer",
        creditsUsed: 1,
      })
    );
  });
});
