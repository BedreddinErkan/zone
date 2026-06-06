import { describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store.js";
import type { UserCommand } from "./userCommands.js";

function initialState() {
  return buildInitialState({ model: "test-model", capUsd: 10 });
}

const PLAN_ACTION = {
  type: "PLAN_PROPOSED" as const,
  revisionId: "rev-1",
  runId: "run-1",
  revisionType: "over_scope" as const,
  revisionReason: "Too many files",
  originalPlan: "Original plan text",
  revisedPlanSummary: "Revised plan text",
};

describe("MODE_CYCLE", () => {
  it("rotates normal → autoAccept → plan → normal", () => {
    let s = initialState();
    expect(s.mode).toBe("normal");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("autoAccept");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("plan");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("normal");
  });

  it("no-op when modalView !== 'none'", () => {
    const s = { ...initialState(), modalView: "permissions" as const };
    const next = reducer(s, { type: "MODE_CYCLE" });
    expect(next.mode).toBe("normal");
    expect(next).toBe(s); // same reference — no state change
  });

  it("no-op when pendingApproval !== null", () => {
    const s = {
      ...initialState(),
      pendingApproval: { approvalId: "a1", runId: "r1", command: "npm test" },
    };
    const next = reducer(s, { type: "MODE_CYCLE" });
    expect(next.mode).toBe("normal");
    expect(next).toBe(s);
  });

  it("PENDING_APPROVAL_RESOLVED clears pendingApproval regardless of mode", () => {
    let s = { ...initialState(), pendingApproval: { approvalId: "a1", runId: "r1", command: "npm test" } };
    s = reducer(s, { type: "MODE_CYCLE" }); // no-op because pendingApproval set
    expect(s.pendingApproval).not.toBeNull();
    s = reducer(s, { type: "PENDING_APPROVAL_RESOLVED" });
    expect(s.pendingApproval).toBeNull();
    // Now MODE_CYCLE should work
    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("autoAccept");
  });
});

describe("PLAN_PROPOSED / PLAN_RESOLVED", () => {
  it("PLAN_PROPOSED sets planProposal + modalView:'plan'", () => {
    const s = reducer(initialState(), PLAN_ACTION);
    expect(s.modalView).toBe("plan");
    expect(s.planProposal).not.toBeNull();
    expect(s.planProposal?.revisionId).toBe("rev-1");
    expect(s.planProposal?.revisionType).toBe("over_scope");
  });

  it("PLAN_RESOLVED clears planProposal + modalView:'none'", () => {
    let s = reducer(initialState(), PLAN_ACTION);
    s = reducer(s, { type: "PLAN_RESOLVED" });
    expect(s.modalView).toBe("none");
    expect(s.planProposal).toBeNull();
  });

  it("PLAN_PROPOSED does not change mode", () => {
    const base = { ...initialState(), mode: "autoAccept" as const };
    const s = reducer(base, PLAN_ACTION);
    expect(s.mode).toBe("autoAccept");
  });

  it("MODE_CYCLE does not affect planProposal", () => {
    let s = reducer(initialState(), PLAN_ACTION);
    // planProposal is set; MODE_CYCLE is guarded by modalView:'plan' ≠ 'none'
    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.planProposal).not.toBeNull();
    expect(s.mode).toBe("normal"); // unchanged
  });
});

describe("MODEL / EFFORT actions", () => {
  it("MODEL_MODAL_OPEN sets modalView to 'model'", () => {
    const s = reducer(initialState(), { type: "MODEL_MODAL_OPEN" });
    expect(s.modalView).toBe("model");
  });

  it("MODEL_APPLY updates modelSettings, statusBar.model, and closes modal", () => {
    const settings = {
      version: 2 as const,
      model: "claude-opus-4-7",
      provider: "anthropic" as const,
      effort: "high" as const,
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    const s = reducer(
      { ...initialState(), modalView: "model" as const },
      { type: "MODEL_APPLY", settings }
    );
    expect(s.modelSettings?.model).toBe("claude-opus-4-7");
    expect(s.modelSettings?.provider).toBe("anthropic");
    expect(s.statusBar.model).toBe("claude-opus-4-7");
    expect(s.modalView).toBe("none");
  });

  it("MODEL_APPLY clears effort when new model does not support it (haiku)", () => {
    const base = {
      ...initialState(),
      modelSettings: {
        version: 2 as const,
        model: "claude-sonnet-4-6",
        provider: "anthropic" as const,
        effort: "high" as const,
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    };
    const settings = {
      version: 2 as const,
      model: "claude-haiku-4-5",
      provider: "anthropic" as const,
      effort: "high" as const,
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    const s = reducer(base, { type: "MODEL_APPLY", settings });
    expect(s.modelSettings?.model).toBe("claude-haiku-4-5");
    expect(s.modelSettings?.effort).toBeUndefined();
  });

  it("EFFORT_APPLY saves effort regardless of whether current model supports it", () => {
    const base = {
      ...initialState(),
      modelSettings: {
        version: 2 as const,
        model: "claude-haiku-4-5",
        provider: "anthropic" as const,
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    };
    const s = reducer(base, { type: "EFFORT_APPLY", effort: "high" });
    expect(s.modelSettings?.effort).toBe("high");
    expect(s.modalView).toBe("none");
  });
});

describe("METRICS_MODAL_OPEN / CLOSE", () => {
  it("METRICS_MODAL_OPEN sets modalView to metrics", () => {
    const s = reducer(initialState(), { type: "METRICS_MODAL_OPEN" });
    expect(s.modalView).toBe("metrics");
  });

  it("METRICS_MODAL_CLOSE returns modalView to none", () => {
    const s = reducer(
      { ...initialState(), modalView: "metrics" as const },
      { type: "METRICS_MODAL_CLOSE" },
    );
    expect(s.modalView).toBe("none");
  });
});

describe("LIMITS_MODAL_OPEN / CLOSE / APPLY", () => {
  it("LIMITS_MODAL_OPEN sets modalView to limits", () => {
    const s = reducer(initialState(), { type: "LIMITS_MODAL_OPEN" });
    expect(s.modalView).toBe("limits");
  });

  it("LIMITS_MODAL_CLOSE returns modalView to none", () => {
    const s = reducer(
      { ...initialState(), modalView: "limits" as const },
      { type: "LIMITS_MODAL_CLOSE" },
    );
    expect(s.modalView).toBe("none");
  });

  it("LIMITS_APPLY updates statusBar.capUsd and closes modal", () => {
    const base = { ...initialState(), modalView: "limits" as const };
    const s = reducer(base, { type: "LIMITS_APPLY", capUsd: 25 });
    expect(s.statusBar.capUsd).toBe(25);
    expect(s.modalView).toBe("none");
  });
});

describe("TRANSCRIPT_APPEND_NARRATION / NARRATION_COMMIT", () => {
  it("TRANSCRIPT_APPEND_NARRATION accumulates in liveTail.narrationBuffer without touching transcript", () => {
    const s0 = buildInitialState({});
    const s1 = reducer(s0, { type: "TRANSCRIPT_APPEND_NARRATION", text: "hello " });
    const s2 = reducer(s1, { type: "TRANSCRIPT_APPEND_NARRATION", text: "world" });
    expect(s2.liveTail.narrationBuffer).toBe("hello world");
    expect(s2.transcript).toHaveLength(0);
  });

  it("NARRATION_COMMIT flushes narrationBuffer to transcript and clears it", () => {
    const s0 = buildInitialState({});
    const s1 = reducer(s0, { type: "TRANSCRIPT_APPEND_NARRATION", text: "hello" });
    const s2 = reducer(s1, { type: "NARRATION_COMMIT" });
    expect(s2.transcript).toHaveLength(1);
    expect(s2.transcript[0]).toEqual({ kind: "narration", text: "hello" });
    expect(s2.liveTail.narrationBuffer).toBe("");
  });

  it("NARRATION_COMMIT on empty buffer returns same state reference", () => {
    const s0 = buildInitialState({});
    const s1 = reducer(s0, { type: "NARRATION_COMMIT" });
    expect(s1).toBe(s0);
  });
});

describe("buildInitialState", () => {
  it("includes transcriptGeneration: 0", () => {
    const state = buildInitialState({});
    expect(state.transcriptGeneration).toBe(0);
  });

  it("seeds userCommands from initialValues", () => {
    const cmds: UserCommand[] = [{ name: "/review", description: "Code review", body: "Review the diff." }];
    const state = buildInitialState({ model: "m", capUsd: 10, userCommands: cmds });
    expect(state.userCommands).toEqual(cmds);
  });

  it("defaults userCommands to [] when not provided", () => {
    const state = buildInitialState({ model: "m", capUsd: 10 });
    expect(state.userCommands).toEqual([]);
  });
});

describe("TRANSCRIPT_REMOUNT", () => {
  it("increments transcriptGeneration", () => {
    const s = { ...initialState(), transcriptGeneration: 2 };
    const next = reducer(s, { type: "TRANSCRIPT_REMOUNT" });
    expect(next.transcriptGeneration).toBe(3);
  });

  it("leaves transcript and todos unchanged", () => {
    const entry = { kind: "narration" as const, text: "hello" };
    const s = { ...initialState(), transcript: [entry] };
    const next = reducer(s, { type: "TRANSCRIPT_REMOUNT" });
    expect(next.transcript).toEqual([entry]);
    expect(next.todos).toEqual([]);
  });
});

describe("SESSION_RESUME", () => {
  const mockSession = {
    sessionId: "new-session-id",
    startedAt: "2026-01-01T00:00:00.000Z",
    transcript: [{ kind: "narration" as const, text: "resumed entry" }],
  };

  it("replaces transcript with resumed session", () => {
    const s = { ...initialState(), transcript: [{ kind: "narration" as const, text: "old" }] };
    const next = reducer(s, { type: "SESSION_RESUME", session: mockSession });
    expect(next.transcript).toEqual(mockSession.transcript);
  });

  it("increments transcriptGeneration", () => {
    const s = { ...initialState(), transcriptGeneration: 3 };
    const next = reducer(s, { type: "SESSION_RESUME", session: mockSession });
    expect(next.transcriptGeneration).toBe(4);
  });

  it("clears liveTail on resume", () => {
    const s = {
      ...initialState(),
      liveTail: { currentToolCall: { toolName: "read_file", args: "foo.ts" }, narrationBuffer: "partial" },
    };
    const next = reducer(s, { type: "SESSION_RESUME", session: mockSession });
    expect(next.liveTail.currentToolCall).toBeNull();
    expect(next.liveTail.narrationBuffer).toBe("");
  });
});

describe("SESSIONS_OPEN deduplication", () => {
  it("removes duplicate sessionIds before storing", () => {
    const makeMeta = (sessionId: string) => ({
      filename: `${sessionId}.json`,
      sessionId,
      startedAt: "",
      model: "",
      totalCostUsd: 0,
      firstUserMessage: "",
      messageCount: 0,
    });
    const list = [makeMeta("abc"), makeMeta("abc"), makeMeta("def")];
    const next = reducer(initialState(), { type: "SESSIONS_OPEN", list });
    expect(next.sessionsList).toHaveLength(2);
    expect(next.sessionsList.map(s => s.sessionId)).toEqual(["abc", "def"]);
  });
});

describe("WEBSEARCH_APPLY", () => {
  it("sets webSearchEnabled=false on existing modelSettings", () => {
    const s0 = buildInitialState({
      model: "test-model", capUsd: 10,
      modelSettings: { version: 2, model: "test-model", provider: "anthropic", updatedAt: "" },
    });
    const s1 = reducer(s0, { type: "WEBSEARCH_APPLY", webSearchEnabled: false });
    expect(s1.modelSettings?.webSearchEnabled).toBe(false);
  });

  it("sets webSearchEnabled=true after false", () => {
    const s0 = buildInitialState({
      model: "test-model", capUsd: 10,
      modelSettings: { version: 2, model: "test-model", provider: "anthropic", webSearchEnabled: false, updatedAt: "" },
    });
    const s1 = reducer(s0, { type: "WEBSEARCH_APPLY", webSearchEnabled: true });
    expect(s1.modelSettings?.webSearchEnabled).toBe(true);
  });

  it("creates modelSettings from null when none exists", () => {
    const s0 = buildInitialState({ model: "test-model", capUsd: 10 });
    expect(s0.modelSettings).toBeNull();
    const s1 = reducer(s0, { type: "WEBSEARCH_APPLY", webSearchEnabled: false });
    expect(s1.modelSettings?.webSearchEnabled).toBe(false);
  });
});

describe("TODOS_SET / TODO_STATUS_SET", () => {
  const TODO_A = { id: "1", text: "Locate the bug", status: "pending" as const };
  const TODO_B = { id: "2", text: "Patch the bug", status: "pending" as const };
  const TODO_C = { id: "3", text: "Run tests", status: "pending" as const };

  it("TODOS_SET sets the todos list", () => {
    const s = initialState();
    const next = reducer(s, { type: "TODOS_SET", todos: [TODO_A, TODO_B] });
    expect(next.todos).toHaveLength(2);
    expect(next.todos[0].status).toBe("pending");
    expect(next.transcript).toHaveLength(0);
  });

  it("TODO_STATUS_SET completed updates the matching todo", () => {
    const s = {
      ...initialState(),
      todos: [TODO_A, { ...TODO_B, status: "in_progress" as const }, TODO_C],
    };
    const next = reducer(s, { type: "TODO_STATUS_SET", todoId: "2", status: "completed" });
    expect(next.todos.find(t => t.id === "2")?.status).toBe("completed");
    expect(next.todos.find(t => t.id === "1")?.status).toBe("pending");
  });

  it("TODO_STATUS_SET in_progress back-fills prior pending→completed (startTodo invariant)", () => {
    const s = { ...initialState(), todos: [TODO_A, TODO_B, TODO_C] };
    const next = reducer(s, { type: "TODO_STATUS_SET", todoId: "2", status: "in_progress" });
    expect(next.todos.find(t => t.id === "1")?.status).toBe("completed");
    expect(next.todos.find(t => t.id === "2")?.status).toBe("in_progress");
    expect(next.todos.find(t => t.id === "3")?.status).toBe("pending");
  });

  it("TODO_STATUS_SET is a noop (same reference) when todos list is empty", () => {
    const s = initialState();
    const next = reducer(s, { type: "TODO_STATUS_SET", todoId: "1", status: "completed" });
    expect(next).toBe(s);
  });

  it("USER_PROMPT resets todos to []", () => {
    const s = reducer(initialState(), { type: "TODOS_SET", todos: [TODO_A] });
    expect(s.todos).toHaveLength(1);
    const next = reducer(s, { type: "USER_PROMPT", text: "new task" });
    expect(next.todos).toEqual([]);
  });

  it("SESSION_RESUME resets todos to []", () => {
    const s = reducer(initialState(), { type: "TODOS_SET", todos: [TODO_A] });
    const mockSession = {
      sessionId: "new-sid",
      startedAt: "2026-01-01T00:00:00.000Z",
      transcript: [],
    };
    const next = reducer(s, { type: "SESSION_RESUME", session: mockSession });
    expect(next.todos).toEqual([]);
  });

  it("TRANSCRIPT_CLEAR resets todos to []", () => {
    const s = reducer(initialState(), { type: "TODOS_SET", todos: [TODO_A, TODO_B] });
    expect(s.todos).toHaveLength(2);
    const next = reducer(s, { type: "TRANSCRIPT_CLEAR" });
    expect(next.todos).toEqual([]);
    expect(next.transcript).toEqual([]);
  });
});

