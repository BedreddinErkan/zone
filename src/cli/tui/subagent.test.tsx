import { describe, it, expect } from "vitest";
import { reducer, buildInitialState, type StoreAction, type SubagentThread } from "./store-core.js";
import { eventToActions } from "./hooks/eventToActions.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

function baseState() {
  return buildInitialState({ model: "test-model", capUsd: 10 });
}

function evt(type: string, extra: Record<string, any> = {}): ZoneStructuredProgressEvent {
  return { type, runId: "r1", ts: Date.now(), title: "", ...extra } as ZoneStructuredProgressEvent;
}

describe("Phase 5a — eventToActions subagent events", () => {
  it("subagent_started produces SUBAGENT_STARTED action", () => {
    const { actions } = eventToActions(
      evt("subagent_started", { subagentId: "sa-1", subagentType: "explore", title: "Search codebase" }),
      { trustedPrefixes: [], mode: "normal" },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "SUBAGENT_STARTED",
      subagentId: "sa-1",
      subagentType: "explore",
      title: "Search codebase",
    });
  });

  it("subagent_completed produces SUBAGENT_COMPLETED action with cost/iterations", () => {
    const { actions } = eventToActions(
      evt("subagent_completed", { subagentId: "sa-1", status: "completed", costUsd: 0.0023, iterations: 4, summary: "Found 3 matches" }),
      { trustedPrefixes: [], mode: "normal" },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "SUBAGENT_COMPLETED",
      subagentId: "sa-1",
      status: "completed",
      costUsd: 0.0023,
      iterations: 4,
      summary: "Found 3 matches",
    });
  });

  it("subagent_started without subagentId produces no actions", () => {
    const { actions } = eventToActions(
      evt("subagent_started", { title: "No ID" }),
      { trustedPrefixes: [], mode: "normal" },
    );
    expect(actions).toHaveLength(0);
  });
});

describe("Phase 5a — store subagent reducer", () => {
  it("SUBAGENT_STARTED creates thread and sets currentSubagentId", () => {
    let s = baseState();
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "explore", title: "Search" });
    expect(s.currentSubagentId).toBe("sa-1");
    expect(s.subagentThreads["sa-1"]).toBeDefined();
    expect(s.subagentThreads["sa-1"]!.status).toBe("running");
  });

  it("SUBAGENT_COMPLETED clears currentSubagentId and updates thread", () => {
    let s = baseState();
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "explore", title: "Search" });
    s = reducer(s, { type: "SUBAGENT_COMPLETED", subagentId: "sa-1", status: "completed", costUsd: 0.01, iterations: 3 });
    expect(s.currentSubagentId).toBeNull();
    expect(s.subagentThreads["sa-1"]!.status).toBe("completed");
    expect(s.subagentThreads["sa-1"]!.costUsd).toBe(0.01);
    expect(s.subagentThreads["sa-1"]!.iterations).toBe(3);
  });

  it("tool_call tagging: TOOL_RESULT_PUSH stamps subagentId from currentSubagentId", () => {
    let s = baseState();
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "worker", title: "Task" });
    s = reducer(s, { type: "TOOL_CALL_OPEN", toolName: "write_file", args: "test.ts" });
    s = reducer(s, { type: "TOOL_RESULT_PUSH", ok: true, detail: "wrote 42 bytes" });
    const lastEntry = s.transcript[s.transcript.length - 1];
    expect(lastEntry?.kind).toBe("tool_call");
    if (lastEntry?.kind === "tool_call") {
      expect(lastEntry.subagentId).toBe("sa-1");
    }
  });

  it("tool_call tagging: no subagentId when currentSubagentId is null", () => {
    let s = baseState();
    s = reducer(s, { type: "TOOL_CALL_OPEN", toolName: "write_file", args: "test.ts" });
    s = reducer(s, { type: "TOOL_RESULT_PUSH", ok: true, detail: "wrote 42 bytes" });
    const lastEntry = s.transcript[s.transcript.length - 1];
    if (lastEntry?.kind === "tool_call") {
      expect(lastEntry.subagentId).toBeUndefined();
    }
  });
});

describe("Phase 5c — spinner label stack", () => {
  it("SUBAGENT_STARTED pushes spinner label and sets subagent label", () => {
    let s = baseState();
    s = { ...s, spinner: { active: true, label: "Working on task" } };
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "explore", title: "Search codebase" });
    expect(s.spinner?.label).toBe("↳ explore · Search codebase");
    expect(s.parentSpinnerLabels).toEqual(["Working on task"]);
  });

  it("SUBAGENT_COMPLETED pops and restores parent label", () => {
    let s = baseState();
    s = { ...s, spinner: { active: true, label: "Working on task" } };
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "explore", title: "Search" });
    s = reducer(s, { type: "SUBAGENT_COMPLETED", subagentId: "sa-1", status: "completed" });
    expect(s.spinner?.label).toBe("Working on task");
    expect(s.parentSpinnerLabels).toEqual([]);
  });

  it("nested subagents: stack push/pop across two levels", () => {
    let s = baseState();
    s = { ...s, spinner: { active: true, label: "Root task" } };
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "worker", title: "First" });
    expect(s.spinner?.label).toBe("↳ worker · First");
    // Nested subagent starts while first is running
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-2", subagentType: "explore", title: "Deep search" });
    expect(s.spinner?.label).toBe("↳ explore · Deep search");
    expect(s.parentSpinnerLabels).toEqual(["Root task", "↳ worker · First"]);
    // Inner completes
    s = reducer(s, { type: "SUBAGENT_COMPLETED", subagentId: "sa-2", status: "completed" });
    expect(s.spinner?.label).toBe("↳ worker · First");
    // Outer completes
    s = reducer(s, { type: "SUBAGENT_COMPLETED", subagentId: "sa-1", status: "completed" });
    expect(s.spinner?.label).toBe("Root task");
    expect(s.parentSpinnerLabels).toEqual([]);
  });

  it("SUBAGENT_STARTED truncates long titles to 40 chars", () => {
    let s = baseState();
    s = { ...s, spinner: { active: true, label: "Working" } };
    const longTitle = "A".repeat(50);
    s = reducer(s, { type: "SUBAGENT_STARTED", subagentId: "sa-1", subagentType: "worker", title: longTitle });
    expect(s.spinner?.label).toBe("↳ worker · " + "A".repeat(37) + "...");
  });
});

describe("Phase 5c — PENDING_APPROVAL_SET carries subagentId", () => {
  it("subagentId is preserved in pendingApproval state", () => {
    let s = baseState();
    s = reducer(s, {
      type: "PENDING_APPROVAL_SET",
      approvalId: "a1",
      runId: "r1",
      command: "rm -rf /",
      kind: "command",
      subagentId: "sa-1",
    });
    expect(s.pendingApproval?.subagentId).toBe("sa-1");
  });

  it("subagentId is undefined when not provided", () => {
    let s = baseState();
    s = reducer(s, {
      type: "PENDING_APPROVAL_SET",
      approvalId: "a1",
      runId: "r1",
      command: "echo hello",
      kind: "command",
    });
    expect(s.pendingApproval?.subagentId).toBeUndefined();
  });
});
