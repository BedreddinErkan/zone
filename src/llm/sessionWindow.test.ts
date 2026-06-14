import { describe, it, expect } from "vitest";
import {
  buildSessionWindow,
  buildContinuationContext,
  truncateSessionTurn,
  truncateForContinuation,
  SESSION_WINDOW_MAX_BYTES,
  TURN_SUMMARY_MAX_BYTES,
  FULL_ANSWER_MAX_BYTES,
  USER_PROMPT_MAX_BYTES,
  MAX_CHANGED_FILES,
} from "./sessionWindow.js";
import { assembleAgentSystemPrompt } from "./agentLoop.js";
import type { FsConversationEvent } from "../core/conversationFilesystemStore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(overrides: {
  userPrompt?: string;
  summary?: string;
  changedFiles?: string[];
} = {}): FsConversationEvent {
  return {
    type: "turn",
    ts: 0,
    runId: "test-run",
    userPrompt: overrides.userPrompt ?? "fix the bug",
    summary: overrides.summary ?? "Fixed the bug in src/foo.ts",
    changedFiles: overrides.changedFiles ?? ["src/foo.ts"],
    outcome: "applied",
  };
}

const PATCH_INPUT = {
  agentIntro: "You are Zone, a coding agent.",
  frameworkLines: [],
  hasFramework: false,
  projectMemoryBlock: "",
  baseMaxIterations: 25,
  canRunCommand: false,
  backgroundCommandBlock: "",
  repoPath: "/repo",
};

// ---------------------------------------------------------------------------
// R1 guard: cache-safety invariant (make-or-break)
// ---------------------------------------------------------------------------

describe("R1 — cache-safety: assembleAgentSystemPrompt is seam-safe", () => {
  it("assembleAgentSystemPrompt is byte-identical regardless of session window content", () => {
    // priorSessionSummary is NOT a param of assembleAgentSystemPrompt.
    // A window string (or the empty string from buildSessionWindow) is passed
    // via the priorSessionSummary field to AgentLoopInput at runtime —
    // it goes into userContent, NEVER into the system prompt.
    const p1 = assembleAgentSystemPrompt(PATCH_INPUT);
    const p2 = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(p1).toBe(p2);
    // Building a window does not change the system prompt — proved by construction
    // (assembleAgentSystemPrompt doesn't accept priorSessionSummary).
    buildSessionWindow([makeTurn()]);
    const p3 = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(p3).toBe(p1);
  });

  it("system prompt contains the SESSION MEMORY directive unconditionally", () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    // The directive trigger string must be present — always, not conditionally.
    expect(prompt).toContain("SESSION MEMORY — if the user message begins with");
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("do not re-investigate or re-apply");
  });

  it("system prompt does NOT contain dynamic session window content", () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).not.toContain("earlier turns in this session:\nFixed the bug");
    expect(prompt).not.toContain("Turn 1 — you asked");
  });
});

// ---------------------------------------------------------------------------
// buildSessionWindow — pure builder tests
// ---------------------------------------------------------------------------

describe("buildSessionWindow — pure builder", () => {
  it("returns empty string for empty events array", () => {
    expect(buildSessionWindow([])).toBe("");
  });

  it("returns empty string when no type:turn events present", () => {
    const events: FsConversationEvent[] = [
      { type: "agent_summary", ts: 0, text: "old style" },
    ];
    expect(buildSessionWindow(events)).toBe("");
  });

  it("builder purity: same input → byte-identical output", () => {
    const events = [makeTurn(), makeTurn({ userPrompt: "add feature", summary: "Added feature" })];
    const r1 = buildSessionWindow(events);
    const r2 = buildSessionWindow(events);
    expect(r1).toBe(r2);
    expect(r1.length).toBeGreaterThan(0);
  });

  it("single turn: renders Tier A with userPrompt, result, files", () => {
    const result = buildSessionWindow([makeTurn()]);
    expect(result).toContain("you asked:");
    expect(result).toContain("fix the bug");
    expect(result).toContain("result:");
    expect(result).toContain("Fixed the bug");
    expect(result).toContain("files:");
    expect(result).toContain("src/foo.ts");
  });

  it("empty-summary skip-and-continue: skips empty turn, finds real turn", () => {
    const events: FsConversationEvent[] = [
      makeTurn({ userPrompt: "older task", summary: "real content from older turn", changedFiles: [] }),
      { type: "turn", ts: 1, runId: "r2", userPrompt: "", summary: "", changedFiles: [], outcome: "no_change" },
    ];
    const result = buildSessionWindow(events);
    expect(result).toContain("real content from older turn");
  });

  it("multiple turns: newest turn appears in Tier A (full detail)", () => {
    const events = [
      makeTurn({ userPrompt: "first task", summary: "first result" }),
      makeTurn({ userPrompt: "second task", summary: "second result" }),
      makeTurn({ userPrompt: "third task", summary: "third result" }),
    ];
    const result = buildSessionWindow(events);
    // Newest turn (third) gets Tier A with full summary
    expect(result).toContain("result: third result");
    // Older turns appear as Tier B one-liners (no "result:" key for them)
  });

  it("Tier B one-liners: older turns have no 'result:' key", () => {
    const events = [
      makeTurn({ userPrompt: "first task", summary: "first result" }),
      makeTurn({ userPrompt: "second task", summary: "second result" }),
      makeTurn({ userPrompt: "newest task", summary: "newest result" }),
    ];
    const result = buildSessionWindow(events);
    // Count occurrences of "result:" — should be exactly 1 (Tier A only)
    const resultCount = (result.match(/\bresult:/g) ?? []).length;
    expect(resultCount).toBe(1);
    // Older turns appear as "earlier you asked to..."
    expect(result).toContain('earlier you asked to "first task"');
    expect(result).toContain('earlier you asked to "second task"');
  });

  it("Tier B one-liners include files when present", () => {
    const events = [
      makeTurn({ userPrompt: "old task", changedFiles: ["src/a.ts", "src/b.ts"] }),
      makeTurn({ userPrompt: "newest task" }),
    ];
    const result = buildSessionWindow(events);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("cap enforcement: result length ≤ SESSION_WINDOW_MAX_BYTES + framing overhead", () => {
    const bigSummary = "x".repeat(3000);
    const events = [
      makeTurn({ userPrompt: "task 1", summary: bigSummary }),
      makeTurn({ userPrompt: "task 2", summary: bigSummary }),
      makeTurn({ userPrompt: "task 3", summary: bigSummary }),
    ];
    const result = buildSessionWindow(events);
    // Allow small overhead for framing characters
    expect(result.length).toBeLessThanOrEqual(SESSION_WINDOW_MAX_BYTES + 100);
  });

  it("single-turn-over-cap degrade: result is non-empty even for pathological summary", () => {
    const hugeSummary = "y".repeat(6000);
    const events = [makeTurn({ summary: hugeSummary })];
    const result = buildSessionWindow(events);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("you asked:");
  });

  it("anti-redo: APPLY_ROLLED_BACK does not appear in window output", () => {
    const events = [
      makeTurn({ summary: "APPLY_ROLLED_BACK\nsome error details\nfoo" }),
    ];
    const result = buildSessionWindow(events);
    expect(result).not.toContain("APPLY_ROLLED_BACK");
    expect(result).not.toContain("rolled_back");
    expect(result).toContain("no net change remained");
  });

  it("anti-redo: other rollback vocabulary does not appear in Tier B lines", () => {
    const events = [
      makeTurn({ userPrompt: "old task", summary: "APPLY_ROLLED_BACK details" }),
      makeTurn({ userPrompt: "newest task", summary: "clean result" }),
    ];
    const result = buildSessionWindow(events);
    expect(result).not.toContain("APPLY_ROLLED_BACK");
  });

  it("events of other types are ignored", () => {
    const events: FsConversationEvent[] = [
      { type: "agent_summary", ts: 0, text: "old style summary" },
      { type: "run", ts: 1 },
      makeTurn({ userPrompt: "real task", summary: "real result" }),
    ];
    const result = buildSessionWindow(events);
    expect(result).toContain("real task");
    expect(result).not.toContain("old style summary");
  });
});

// ---------------------------------------------------------------------------
// truncateSessionTurn
// ---------------------------------------------------------------------------

describe("truncateSessionTurn", () => {
  it("returns text unchanged when within TURN_SUMMARY_MAX_BYTES", () => {
    const short = "short text";
    expect(truncateSessionTurn(short)).toBe(short);
  });

  it("truncates long text and keeps the TAIL", () => {
    const tail = "THIS IS THE TAIL OF THE TEXT";
    const long = "x".repeat(3000) + tail;
    const result = truncateSessionTurn(long);
    expect(result.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_BYTES);
    expect(result).toContain(tail);
    expect(result).toContain("[…truncated…]");
  });

  it("strips APPLY_ROLLED_BACK from output", () => {
    const text = "Some content\nAPPLY_ROLLED_BACK some error\nmore content";
    const result = truncateSessionTurn(text);
    expect(result).not.toContain("APPLY_ROLLED_BACK");
    expect(result).toContain("no net change remained during that turn");
  });

  it("strips APPLY_ROLLED_BACK even when surviving truncation", () => {
    const tail = "APPLY_ROLLED_BACK important info";
    const long = "x".repeat(3000) + tail;
    const result = truncateSessionTurn(long);
    expect(result).not.toContain("APPLY_ROLLED_BACK");
  });

  it("handles empty string", () => {
    expect(truncateSessionTurn("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("SESSION_WINDOW_MAX_BYTES is 4096", () => {
    expect(SESSION_WINDOW_MAX_BYTES).toBe(4096);
  });

  it("USER_PROMPT_MAX_BYTES is 256", () => {
    expect(USER_PROMPT_MAX_BYTES).toBe(256);
  });

  it("TURN_SUMMARY_MAX_BYTES is 2048", () => {
    expect(TURN_SUMMARY_MAX_BYTES).toBe(2048);
  });

  it("MAX_CHANGED_FILES is 12", () => {
    expect(MAX_CHANGED_FILES).toBe(12);
  });

  it("FULL_ANSWER_MAX_BYTES is 65536", () => {
    expect(FULL_ANSWER_MAX_BYTES).toBe(65_536);
  });
});

// ---------------------------------------------------------------------------
// truncateForContinuation
// ---------------------------------------------------------------------------

describe("truncateForContinuation — head-keep snapshot", () => {
  it("returns text unchanged when within FULL_ANSWER_MAX_BYTES", () => {
    const short = "Section 1: intro\nSection 2: details";
    expect(truncateForContinuation(short)).toBe(short);
  });

  it("head-keep: truncates long text and keeps the HEAD", () => {
    const head = "SECTION 1 IS RIGHT HERE AT THE START";
    const long = head + "x".repeat(70_000); // must exceed 65536 to trigger truncation
    const result = truncateForContinuation(long);
    expect(result.length).toBeLessThanOrEqual(FULL_ANSWER_MAX_BYTES);
    expect(result.startsWith(head)).toBe(true);
    expect(result).toContain("[…truncated");
  });

  it("head-keep: truncated result does NOT end with the tail of the input", () => {
    const long = "a".repeat(70_000); // must exceed 65536
    const result = truncateForContinuation(long);
    expect(result.length).toBe(FULL_ANSWER_MAX_BYTES);
    // Last char should be the truncation notice, not "a"
    expect(result.endsWith("a")).toBe(false);
    expect(result).toContain("[…truncated");
  });

  it("strips APPLY_ROLLED_BACK from output — same scrub as truncateSessionTurn", () => {
    const text = "Section 1\nAPPLY_ROLLED_BACK some detail here\nSection 2";
    const result = truncateForContinuation(text);
    expect(result).not.toContain("APPLY_ROLLED_BACK");
    expect(result).toContain("no net change remained during that turn");
  });

  it("handles empty string", () => {
    expect(truncateForContinuation("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildContinuationContext
// ---------------------------------------------------------------------------

describe("buildContinuationContext", () => {
  it("returns null for empty events array", () => {
    expect(buildContinuationContext([])).toBeNull();
  });

  it("returns null when no type:turn events have fullAnswer", () => {
    const events: FsConversationEvent[] = [
      { type: "turn", ts: 0, runId: "r1", userPrompt: "fix", summary: "done", changedFiles: [], outcome: "applied" },
      { type: "agent_summary", ts: 1, text: "summary" },
    ];
    expect(buildContinuationContext(events)).toBeNull();
  });

  it("returns fullAnswer from the most recent turn that has one", () => {
    const events: FsConversationEvent[] = [
      { type: "turn", ts: 0, runId: "r1", userPrompt: "p1", summary: "s1", changedFiles: [], outcome: "applied",
        fullAnswer: "Section 1: first turn content" },
      { type: "turn", ts: 1, runId: "r2", userPrompt: "p2", summary: "s2", changedFiles: [], outcome: "applied",
        fullAnswer: "Section 1: second turn content" },
    ];
    expect(buildContinuationContext(events)).toBe("Section 1: second turn content");
  });

  it("skips turns without fullAnswer and finds the most recent with one", () => {
    const events: FsConversationEvent[] = [
      { type: "turn", ts: 0, runId: "r1", userPrompt: "p1", summary: "s1", changedFiles: [], outcome: "applied",
        fullAnswer: "prior turn answer" },
      { type: "turn", ts: 1, runId: "r2", userPrompt: "p2", summary: "s2", changedFiles: [], outcome: "applied" },
    ];
    expect(buildContinuationContext(events)).toBe("prior turn answer");
  });

  it("returns null when fullAnswer is empty string", () => {
    const events: FsConversationEvent[] = [
      { type: "turn", ts: 0, runId: "r1", userPrompt: "p1", summary: "s1", changedFiles: [], outcome: "applied",
        fullAnswer: "" },
    ];
    expect(buildContinuationContext(events)).toBeNull();
  });
});
