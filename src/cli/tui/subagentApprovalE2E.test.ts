import { describe, it, expect } from "vitest";
import { withRequestContext } from "../../llm/openaiContext.js";
import { eventToActions } from "./hooks/eventToActions.js";
import { reducer, buildInitialState } from "./store-core.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

const ctx = { trustedPrefixes: [], mode: "normal" as const };

function makeApprovalEvent(extra: Record<string, any> = {}): ZoneStructuredProgressEvent {
  return {
    type: "command_approval_required",
    runId: "r1",
    ts: Date.now(),
    title: "",
    approvalId: "a1",
    command: "rm -rf /tmp/build",
    ...extra,
  } as ZoneStructuredProgressEvent;
}

describe("Phase 5c end-to-end — approval subagentId via ALS", () => {
  it("without ALS context: subagentId is absent from action and state", () => {
    const evt = makeApprovalEvent();
    const { actions } = eventToActions(evt, ctx);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.type).toBe("PENDING_APPROVAL_SET");
    if (action.type === "PENDING_APPROVAL_SET") {
      expect(action.subagentId).toBeUndefined();
    }

    let s = buildInitialState({ model: "test", capUsd: 10 });
    s = reducer(s, action);
    expect(s.pendingApproval?.subagentId).toBeUndefined();
  });

  it("with subagentId on the event: subagentId flows through to state", () => {
    const evt = makeApprovalEvent({ subagentId: "sub-1" });
    const { actions } = eventToActions(evt, ctx);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    if (action.type === "PENDING_APPROVAL_SET") {
      expect(action.subagentId).toBe("sub-1");
    }

    let s = buildInitialState({ model: "test", capUsd: 10 });
    s = reducer(s, action);
    expect(s.pendingApproval?.subagentId).toBe("sub-1");
  });

  it("requestCommandApproval enriches event with subagentId from ALS", async () => {
    // This test verifies the production path: ALS → emit → event carries subagentId
    const { requestCommandApproval } = await import("../../api/commandApprovals.js");

    // Without ALS context: subagentId absent
    let capturedEvent: any = null;
    const emit = (evt: any) => {
      capturedEvent = evt;
      // Auto-resolve after capture so the promise doesn't block
      resolveCommandApproval({ approvalId: evt.approvalId, approved: true, runId: evt.runId });
    };
    const { resolveCommandApproval } = await import("../../api/commandApprovals.js");

    // Use a command NOT in SAFE_COMMAND_PREFIXES so it reaches the prompt emit path
    // (safe commands auto-approve via command_auto_approved, bypassing the enriched emit).
    await requestCommandApproval({
      runId: "r1",
      command: "kubectl delete pods --all",
      emit,
    });
    expect(capturedEvent).toBeTruthy();
    expect(capturedEvent.type).toBe("command_approval_required");
    expect(capturedEvent.subagentId).toBeUndefined();

    // With ALS context: subagentId present
    capturedEvent = null;
    await withRequestContext({ subagentId: "sub-als-1", subagentType: "worker" }, async () => {
      await requestCommandApproval({
        runId: "r1",
        command: "kubectl apply -f deploy.yaml",
        emit,
      });
    });
    expect(capturedEvent).toBeTruthy();
    expect(capturedEvent.subagentId).toBe("sub-als-1");
  });
});
