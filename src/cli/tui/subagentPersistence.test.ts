import { describe, it, expect } from "vitest";
import { reducer, buildInitialState, type SubagentThread } from "./store-core.js";
import type { DiskSession } from "../../api/diskSessions.js";

function baseState() {
  return buildInitialState({ model: "test-model", capUsd: 10 });
}

function makeSession(overrides: Partial<DiskSession> = {}): DiskSession {
  return {
    version: 1,
    sessionId: "sess-1",
    startedAt: "2026-09-10T00:00:00Z",
    lastActivityAt: "2026-09-10T00:05:00Z",
    cwd: "/repo",
    model: "test-model",
    transcript: [],
    totalCostUsd: 0.01,
    totalTokens: 1000,
    totalElapsedMs: 5000,
    ...overrides,
  };
}

describe("Phase 5d — DiskSession subagentThreads persistence", () => {
  it("DiskSession type accepts optional subagentThreads", () => {
    const threads: Record<string, SubagentThread> = {
      "sa-1": {
        subagentId: "sa-1",
        subagentType: "explore",
        title: "Search codebase",
        status: "completed",
        toolCallCount: 5,
        costUsd: 0.002,
        iterations: 3,
        summary: "Found 3 matches",
      },
    };
    const session = makeSession({ subagentThreads: threads });
    expect(session.subagentThreads).toBeDefined();
    expect(session.subagentThreads!["sa-1"]!.status).toBe("completed");
  });

  it("old DiskSession without subagentThreads is still valid", () => {
    const oldSession = makeSession();
    expect(oldSession.subagentThreads).toBeUndefined();
    // This must not throw — backward compatibility
    expect(oldSession.version).toBe(1);
  });
});

describe("Phase 5d — SESSION_RESUME hydration", () => {
  it("resumes subagentThreads from session", () => {
    const threads: Record<string, SubagentThread> = {
      "sa-1": {
        subagentId: "sa-1",
        subagentType: "worker",
        title: "Fix bug",
        status: "completed",
        toolCallCount: 3,
        costUsd: 0.001,
      },
      "sa-2": {
        subagentId: "sa-2",
        subagentType: "explore",
        title: "Find tests",
        status: "failed",
        toolCallCount: 1,
      },
    };
    const session = makeSession({
      transcript: [
        { kind: "tool_call", toolName: "read_file", args: "src/foo.ts", results: [{ ok: true, detail: "" }], subagentId: "sa-1" },
        { kind: "tool_call", toolName: "read_file", args: "src/bar.ts", results: [{ ok: true, detail: "" }], subagentId: "sa-2" },
      ],
      subagentThreads: threads,
    });

    let s = baseState();
    s = reducer(s, { type: "SESSION_RESUME", session });
    expect(s.subagentThreads).toEqual(threads);
    expect(s.currentSubagentId).toBeNull();
    expect(s.parentSpinnerLabels).toEqual([]);
    // Transcript entries retain their subagentId tags
    expect(s.transcript[0]?.kind === "tool_call" ? (s.transcript[0] as any).subagentId : null).toBe("sa-1");
    expect(s.transcript[1]?.kind === "tool_call" ? (s.transcript[1] as any).subagentId : null).toBe("sa-2");
  });

  it("old session without subagentThreads resumes with empty record", () => {
    const oldSession = makeSession({
      transcript: [{ kind: "narration", text: "Hello" }],
    });

    let s = baseState();
    s = reducer(s, { type: "SESSION_RESUME", session: oldSession });
    expect(s.subagentThreads).toEqual({});
    expect(s.currentSubagentId).toBeNull();
    expect(s.transcript).toHaveLength(1);
  });

  it("resumed transcript with tagged entries enables nested rendering", () => {
    const threads: Record<string, SubagentThread> = {
      "sa-1": {
        subagentId: "sa-1",
        subagentType: "worker",
        title: "Refactor auth",
        status: "completed",
        toolCallCount: 4,
        costUsd: 0.003,
        iterations: 2,
        summary: "Refactored 3 files",
      },
    };
    const session = makeSession({
      transcript: [
        { kind: "user_prompt", text: "Refactor auth module" },
        { kind: "tool_call", toolName: "read_file", args: "src/auth.ts", results: [{ ok: true, detail: "" }], subagentId: "sa-1" },
        { kind: "tool_call", toolName: "write_file", args: "src/auth.ts", results: [{ ok: true, detail: "wrote 200 bytes" }], subagentId: "sa-1" },
        { kind: "narration", text: "Done refactoring" },
      ],
      subagentThreads: threads,
    });

    let s = baseState();
    s = reducer(s, { type: "SESSION_RESUME", session });

    // Entries 1 and 2 are tagged with sa-1 — Transcript.tsx's buildGroupedItems
    // will wrap them in a group header/footer using threads["sa-1"].
    const tagged = s.transcript.filter(e => (e as any).subagentId === "sa-1");
    expect(tagged).toHaveLength(2);
    // Thread metadata is available for rendering
    expect(s.subagentThreads["sa-1"]!.summary).toBe("Refactored 3 files");
    expect(s.subagentThreads["sa-1"]!.costUsd).toBe(0.003);
  });
});
