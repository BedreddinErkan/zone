/**
 * Interactive round-trip: requestStagedApproval emit → mapStructuredEventToProgress
 * → handleStagedDiffsReadyExported → resolveStagedApproval.
 *
 * This is the exact channel that was broken (mapper had no staged_diffs case) and
 * was never exercised because all prior tests used autoApprove:true, which short-
 * circuits before the emit. These tests are RED without the mapper fix.
 *
 * Mirrors useAgentEvents.editApproval.test.ts (same wiring pattern for edit approval).
 */
import { describe, it, expect } from "vitest";
import { requestStagedApproval, resolveStagedApproval } from "./stagedApprovals.js";
import { mapStructuredEventToProgress } from "../core/runLlmPatchFlow.js";
import { handleStagedDiffsReadyExported } from "../cli/tui/hooks/useAgentEvents.js";
import type { StoreAction } from "../cli/tui/store.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import type { StagedFile } from "../core/fileDiff.js";

const FAKE_FILES: StagedFile[] = [
  { path: "a.ts", findReplace: "", added: 1, removed: 0 },
];

function capture(): { calls: StoreAction[]; dispatch: (a: StoreAction) => void } {
  const calls: StoreAction[] = [];
  return { calls, dispatch: (a) => { calls.push(a); } };
}

describe("staged_diffs_ready_for_approval interactive round-trip", () => {
  it("emit → mapper → handler dispatches STAGED_DIFFS_PROPOSED; resolve unblocks promise (RED without fix)", async () => {
    const { calls, dispatch } = capture();
    let capturedApprovalId = "";

    const p = requestStagedApproval({
      runId: "run-x",
      files: FAKE_FILES,
      verificationSummary: "tsc ✓",
      trigger: "natural_completion",
      emit: (evt) => {
        // Simulate: agentLoop → runLlmPatchFlow → mapStructuredEventToProgress (the bug site)
        const progress = mapStructuredEventToProgress(evt);
        expect(progress).not.toBeNull();          // FAILS without fix (mapper returns null)
        expect(progress?.type).toBe("staged_diffs_ready_for_approval");
        expect(progress?.approvalId).toBe((evt as any).approvalId);

        // Simulate: bus.emit → handleStagedDiffsReadyExported → store dispatch
        handleStagedDiffsReadyExported(
          { ...progress, runId: (evt as any).runId, ts: 0 } as ZoneStructuredProgressEvent,
          dispatch
        );
        capturedApprovalId = (evt as any).approvalId;
      },
      // NOT autoApprove — exercises the real emit path
    });

    // emit is synchronous; STAGED_DIFFS_PROPOSED is dispatched by the time requestStagedApproval returns.
    expect(calls.some((a) => a.type === "STAGED_DIFFS_PROPOSED")).toBe(true); // FAILS without fix

    resolveStagedApproval({ approvalId: capturedApprovalId, runId: "run-x", decision: "approve_all" });
    await expect(p).resolves.toMatchObject({ decision: "approve_all" });
  });

  it("resolve with reject yields {decision:'reject'}", async () => {
    let capturedApprovalId = "";
    const p = requestStagedApproval({
      runId: "run-y",
      files: FAKE_FILES,
      verificationSummary: "",
      trigger: "natural_completion",
      emit: (evt) => { capturedApprovalId = (evt as any).approvalId; },
    });
    resolveStagedApproval({ approvalId: capturedApprovalId, runId: "run-y", decision: "reject" });
    await expect(p).resolves.toMatchObject({ decision: "reject" });
  });

  it("aborted signal yields {decision:'reject'} (the abort-path reject source)", async () => {
    const ac = new AbortController();
    const p = requestStagedApproval({
      runId: "run-z",
      files: FAKE_FILES,
      verificationSummary: "",
      trigger: "natural_completion",
      emit: () => {},
      abortSignal: ac.signal,
    });
    ac.abort();
    await expect(p).resolves.toMatchObject({ decision: "reject" });
  });
});
