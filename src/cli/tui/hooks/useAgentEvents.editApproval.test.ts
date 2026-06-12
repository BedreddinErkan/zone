import { describe, it, expect } from "vitest";
import { requestEditApproval, resolveEditApproval } from "../../../api/editApprovals.js";
import { mapStructuredEventToProgress } from "../../../core/runLlmPatchFlow.js";
import { handleEditApproval } from "./useAgentEvents.js";
import type { StoreAction } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";

function capture(): { calls: StoreAction[]; dispatch: (a: StoreAction) => void } {
  const calls: StoreAction[] = [];
  return { calls, dispatch: (a) => { calls.push(a); } };
}

describe("handleEditApproval (module-level)", () => {
  it("dispatches PENDING_APPROVAL_SET with kind:edit and filePath as command", () => {
    const { calls, dispatch } = capture();
    handleEditApproval(
      {
        type: "edit_approval_required",
        runId: "r1",
        ts: 0,
        title: "Edit approval required",
        filePath: "src/foo.ts",
        approvalId: "ap1",
      } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "PENDING_APPROVAL_SET",
      approvalId: "ap1",
      runId: "r1",
      command: "src/foo.ts",
      kind: "edit",
    });
  });

  it("noop when approvalId is absent", () => {
    const { calls, dispatch } = capture();
    handleEditApproval(
      { type: "edit_approval_required", runId: "r1", ts: 0, title: "t" } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(0);
  });
});

describe("edit_approval_required round-trip (reproduces the hang)", () => {
  it("requestEditApproval promise resolves after resolveEditApproval is called", async () => {
    let capturedApprovalId = "";
    const { calls, dispatch } = capture();

    const promise = requestEditApproval({
      runId: "test-run",
      filePath: "src/bar.ts",
      emit: (evt) => {
        // Simulate: bridge maps event → progress shape (fails before Step 1 branch exists)
        const progress = mapStructuredEventToProgress(evt);
        expect(progress).not.toBeNull();
        expect(progress?.type).toBe("edit_approval_required");
        expect((progress as any)?.filePath).toBe("src/bar.ts");

        // Simulate: bus.emit → handleEditApproval handler (fails before bridge fix)
        handleEditApproval(
          { ...progress, runId: (evt as any).runId, ts: 0 } as ZoneStructuredProgressEvent,
          dispatch
        );
        capturedApprovalId = (evt as any).approvalId;
      },
    });

    // Modal rendered — PENDING_APPROVAL_SET {kind:"edit"} dispatched
    expect(calls[0]).toMatchObject({ type: "PENDING_APPROVAL_SET", kind: "edit", command: "src/bar.ts" });

    // Simulate user pressing Y in ApprovalModal
    resolveEditApproval({ approvalId: capturedApprovalId, runId: "test-run", approved: true });

    // Await unblocks (would hang for 5 min before the fix)
    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it("resolves false when user rejects (N key)", async () => {
    let capturedApprovalId = "";

    const promise = requestEditApproval({
      runId: "test-run-2",
      filePath: "src/baz.ts",
      emit: (evt) => {
        capturedApprovalId = (evt as any).approvalId;
      },
    });

    resolveEditApproval({ approvalId: capturedApprovalId, runId: "test-run-2", approved: false });
    const result = await promise;
    expect(result.approved).toBe(false);
  });
});
