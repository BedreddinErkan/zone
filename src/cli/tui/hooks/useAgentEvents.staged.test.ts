import { describe, it, expect, vi } from "vitest";
import { handleStagedDiffsReadyExported } from "./useAgentEvents.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";

function makeEvt(overrides: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return {
    type: "staged_diffs_ready_for_approval",
    title: "Review staged changes",
    runId: "run-001",
    approvalId: "approval-001",
    stagedFilesJson: JSON.stringify([
      { path: "src/foo.ts", findReplace: "--- FIND ---\nold\n--- REPLACE ---\nnew", added: 1, removed: 1 },
    ]),
    stagedVerificationSummary: "tsc ✓",
    stagedTrigger: "natural_completion",
    ...overrides,
  } as ZoneStructuredProgressEvent;
}

describe("handleStagedDiffsReadyExported", () => {
  it("dispatches SPINNER_STOP then STAGED_DIFFS_PROPOSED with parsed files", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(makeEvt(), dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "SPINNER_STOP" });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "STAGED_DIFFS_PROPOSED",
      approvalId: "approval-001",
      runId: "run-001",
      files: [{ path: "src/foo.ts", findReplace: "--- FIND ---\nold\n--- REPLACE ---\nnew", added: 1, removed: 1 }],
      verificationSummary: "tsc ✓",
      trigger: "natural_completion",
    });
  });

  it("no dispatch when approvalId is missing", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(makeEvt({ approvalId: undefined }), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches with empty files when stagedFilesJson is malformed JSON", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(
      makeEvt({ stagedFilesJson: "not valid json{" }),
      dispatch
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    const proposed = dispatch.mock.calls[1]![0] as { files: unknown[] };
    expect(proposed.files).toEqual([]);
  });

  it("dispatches with empty files when stagedFilesJson is absent", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(
      makeEvt({ stagedFilesJson: undefined }),
      dispatch
    );
    const proposed = dispatch.mock.calls[1]![0] as { files: unknown[] };
    expect(proposed.files).toEqual([]);
  });

  it("forwards max_iterations trigger correctly", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(
      makeEvt({ stagedTrigger: "max_iterations" }),
      dispatch
    );
    const proposed = dispatch.mock.calls[1]![0] as { trigger: string };
    expect(proposed.trigger).toBe("max_iterations");
  });

  it("defaults trigger to natural_completion when stagedTrigger is absent", () => {
    const dispatch = vi.fn();
    handleStagedDiffsReadyExported(
      makeEvt({ stagedTrigger: undefined }),
      dispatch
    );
    const proposed = dispatch.mock.calls[1]![0] as { trigger: string };
    expect(proposed.trigger).toBe("natural_completion");
  });
});
