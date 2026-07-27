import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import { toWireFrame, WIRE_BYTE_CAP, _resetUnmappedWarnedForTest } from "./toWireFrame.js";

function makeEvt(overrides: Partial<ZoneStructuredProgressEvent>): ZoneStructuredProgressEvent {
  return {
    runId: "run-1",
    ts: 0,
    type: "narration",
    title: "",
    ...overrides,
  } as ZoneStructuredProgressEvent;
}

describe("toWireFrame — security invariants", () => {
  it("drops metadata entirely", () => {
    const frame = toWireFrame(makeEvt({ metadata: { screenshotPath: "/x", secret: "abc" } }));
    expect(frame).not.toBeNull();
    expect(frame).not.toHaveProperty("metadata");
  });

  it("drops patch body; retains filePath for tool_call", () => {
    const frame = toWireFrame(
      makeEvt({
        type: "tool_call",
        title: "apply_patch",
        patch: "--- a/foo.ts\n+++ b/foo.ts\n+" + "x".repeat(500),
        filePath: "src/foo.ts",
      })
    );
    expect(frame).not.toBeNull();
    expect(frame).not.toHaveProperty("patch");
    expect(frame).toHaveProperty("filePath", "src/foo.ts");
  });

  it("truncates detail to WIRE_BYTE_CAP", () => {
    const big = "x".repeat(WIRE_BYTE_CAP + 500);
    const frame = toWireFrame(makeEvt({ type: "tool_call", title: "t", detail: big }));
    expect(frame).not.toBeNull();
    const detail = (frame as Record<string, unknown>)["detail"];
    expect(typeof detail).toBe("string");
    expect((detail as string).length).toBeLessThanOrEqual(WIRE_BYTE_CAP + 20);
    expect(detail as string).toContain("[truncated]");
  });

  it("truncates responseText to WIRE_BYTE_CAP", () => {
    const big = "x".repeat(WIRE_BYTE_CAP + 500);
    const frame = toWireFrame(makeEvt({ type: "agent_loop_complete", title: "done", responseText: big }));
    expect(frame).not.toBeNull();
    const responseText = (frame as Record<string, unknown>)["responseText"];
    expect(typeof responseText).toBe("string");
    expect((responseText as string).length).toBeLessThanOrEqual(WIRE_BYTE_CAP + 20);
  });

  it("never forwards responseHtml", () => {
    const frame = toWireFrame(
      makeEvt({ type: "agent_loop_complete", title: "done", responseHtml: "<b>sensitive</b>" })
    );
    expect(frame).not.toHaveProperty("responseHtml");
  });
});

describe("toWireFrame — approval events", () => {
  it("retains approvalId and command for command_approval_required", () => {
    const frame = toWireFrame(
      makeEvt({ type: "command_approval_required", title: "approve?", approvalId: "abc123", command: "npm run build" })
    );
    expect(frame).not.toBeNull();
    expect(frame).toHaveProperty("approvalId", "abc123");
    expect(frame).toHaveProperty("command", "npm run build");
  });

  it("retains planId + objective and drops planStepsJson for plan_ready_for_approval", () => {
    const frame = toWireFrame(
      makeEvt({
        type: "plan_ready_for_approval",
        title: "plan ready",
        planId: "p1",
        planObjective: "Add feature X",
        planStepsJson: '["step1","step2"]',
      })
    );
    expect(frame).not.toBeNull();
    expect(frame).toHaveProperty("planId", "p1");
    expect(frame).toHaveProperty("planObjective", "Add feature X");
    expect(frame).not.toHaveProperty("planStepsJson");
  });

  it("retains approvalId and drops stagedFilesJson for staged_diffs_ready_for_approval", () => {
    const frame = toWireFrame(
      makeEvt({
        type: "staged_diffs_ready_for_approval",
        title: "diffs ready",
        approvalId: "stg-1",
        stagedFilesJson: '{"src/foo.ts":"entire file content here"}',
        stagedVerificationSummary: "1 file staged",
      })
    );
    expect(frame).not.toBeNull();
    expect(frame).toHaveProperty("approvalId", "stg-1");
    expect(frame).toHaveProperty("stagedVerificationSummary", "1 file staged");
    expect(frame).not.toHaveProperty("stagedFilesJson");
  });
});

describe("toWireFrame — subagent runId rewrite", () => {
  it("rewrites runId to parentRunId when both parentRunId and subagentId are present", () => {
    const frame = toWireFrame(
      makeEvt({ runId: "child-run", parentRunId: "parent-run", subagentId: "sub-1", type: "narration", title: "working" })
    );
    expect(frame).not.toBeNull();
    expect(frame!.runId).toBe("parent-run");
  });

  it("does not rewrite runId when subagentId is absent", () => {
    const frame = toWireFrame(makeEvt({ runId: "run-1", parentRunId: "parent-run" }));
    expect(frame!.runId).toBe("run-1");
  });

  it("does not rewrite runId when parentRunId is absent", () => {
    const frame = toWireFrame(makeEvt({ runId: "run-1", subagentId: "sub-1" }));
    expect(frame!.runId).toBe("run-1");
  });

  it("does not rewrite runId for a non-subagent event", () => {
    const frame = toWireFrame(makeEvt({ runId: "run-1" }));
    expect(frame!.runId).toBe("run-1");
  });
});

describe("toWireFrame — noise filtering", () => {
  it("returns null for loop_warning_emitted", () => {
    expect(toWireFrame(makeEvt({ type: "loop_warning_emitted", title: "warn" }))).toBeNull();
  });

  it("returns null for iter_cost_update", () => {
    expect(toWireFrame(makeEvt({ type: "iter_cost_update", title: "cost" }))).toBeNull();
  });

  it("returns null for all compaction events", () => {
    const compactionTypes = [
      "compaction_started",
      "compaction_status",
      "compaction_exhausted",
      "compaction_overflow_warning",
    ] as const;
    for (const type of compactionTypes) {
      expect(toWireFrame(makeEvt({ type, title: "compact" }))).toBeNull();
    }
  });

  it("passes through non-noise events", () => {
    expect(toWireFrame(makeEvt({ type: "narration", title: "thinking…" }))).not.toBeNull();
    expect(toWireFrame(makeEvt({ type: "agent_loop_complete", title: "done" }))).not.toBeNull();
    expect(toWireFrame(makeEvt({ type: "run_failed", title: "failed" }))).not.toBeNull();
  });
});

describe("toWireFrame — unmapped events are loud", () => {
  beforeEach(() => {
    _resetUnmappedWarnedForTest();
  });

  it("carries a question's body across the wire", () => {
    // A question without its text is an unanswerable prompt, and questionId is
    // the handle a reply carries back. Dropping either makes a remote client
    // look wired while being useless.
    const frame = toWireFrame(
      makeEvt({
        type: "user_question_required",
        questionId: "q1",
        question: "Which auth module is canonical?",
      })
    );
    expect(frame).toMatchObject({
      type: "user_question_required",
      questionId: "q1",
      question: "Which auth module is canonical?",
    });
  });

  it("warns once per type when an event's fields are dropped", () => {
    // The default arm used to swallow event-specific fields in silence — the
    // failure mode where frames arrive so the feature looks wired, while the
    // payload that made them useful never left.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const evt = makeEvt({ type: "todo_status_changed", todoId: "t1", todoStatus: "completed" });
      toWireFrame(evt);
      toWireFrame(evt);
      const warnings = logSpy.mock.calls.filter((c) => c[0] === "[zone-wire-frame-unmapped]");
      expect(warnings).toHaveLength(1);
      const payload = JSON.parse(String(warnings[0]![1])) as { droppedFields: string[] };
      expect(payload.droppedFields).toContain("todoId");
      expect(payload.droppedFields).toContain("todoStatus");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("stays quiet for events that genuinely carry nothing extra", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      toWireFrame(makeEvt({ type: "command_trusted" }));
      expect(logSpy.mock.calls.filter((c) => c[0] === "[zone-wire-frame-unmapped]")).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
