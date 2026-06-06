/**
 * Phase 1 session memory tests.
 *
 * Covers:
 *  1. Round-trip: appendFsConversationEvent → readFsConversationEvents → extractPriorRunSummary
 *  2. Toggle off: no SESSION MEMORY block in prompt when priorSessionSummary is absent
 *  3. Toggle on: SESSION MEMORY block appears with neutral framing (not rollback framing)
 *  4. Both fields active: SESSION MEMORY then PRIOR RUN CONTEXT
 *  5. Static prefix invariant: assembleAgentSystemPrompt unchanged by priorSessionSummary
 *  6. stripBanner: both banner shapes stripped; unknown prefix passes through
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendFsConversationEvent,
  readFsConversationEvents,
} from "../core/conversationFilesystemStore.js";
import { extractPriorRunSummary } from "./applyRollbackFeedback.js";
import { assembleAgentSystemPrompt } from "./agentLoop.js";
import { buildSessionWindow } from "./sessionWindow.js";
import { reducer, buildInitialState } from "../cli/tui/store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PATCH_INPUT = {
  agentIntro: "You are Zone, an AI code agent.",
  frameworkLines: [],
  hasFramework: false,
  projectMemoryBlock: "",
  baseMaxIterations: 10,
  canRunCommand: false,
  backgroundCommandBlock: "",
  repoPath: "/repo",
};

// Keep in sync with SESSION_MEMORY_HEADER constant in agentLoop.ts.
const SESSION_MEMORY_HEADER = "SESSION MEMORY — context from earlier turns in this session:";

// Helper: build the userContent string the same way agentLoop does (Phase 1 logic).
function buildUserContent(opts: {
  priorSessionSummary?: string;
  priorRunSummary?: string;
  task?: string;
}): string {
  const { priorSessionSummary, priorRunSummary, task = "Do the thing." } = opts;
  const sessionMem = (priorSessionSummary ?? "").trim();
  const sessionMemBlock = sessionMem
    ? SESSION_MEMORY_HEADER + "\n" +
      sessionMem +
      "\nEND SESSION MEMORY.\n\n"
    : "";
  const priorRun = (priorRunSummary ?? "").trim();
  // Double-injection suppression: when session window is non-empty, suppress PRIOR RUN CONTEXT.
  return (priorRun && !sessionMemBlock)
    ? "PRIOR RUN CONTEXT — your last attempt in this thread produced this result:\n" +
        priorRun +
        "\nEND PRIOR RUN CONTEXT.\n\n" +
        task
    : sessionMemBlock + task;
}

// ── stripBanner (module-local — test by observable side-effects) ──────────────

// We can't import the private stripBanner from index.tsx directly, so we replicate
// the regex here and test it in isolation (the implementation must match this).
function stripBanner(s: string): string {
  return s.replace(/^=== [A-Z ]+===\n/, "");
}

// ── 1. Round-trip ─────────────────────────────────────────────────────────────

describe("session memory round-trip (FS store)", () => {
  let tmpDir: string;
  const threadId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"; // UUID-shaped

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-mem-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads back a non-rollback agent_summary event", async () => {
    const written = "## What changed\n- Added auth module\n\n## Why\nNeeded by login flow.";
    const ok = await appendFsConversationEvent({
      repoPath: tmpDir,
      threadId,
      event: { type: "agent_summary", ts: Date.now(), text: written },
    });
    expect(ok).toBe(true);

    const events = readFsConversationEvents({ repoPath: tmpDir, threadId });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_summary");
    expect(events[0].text).toBe(written);

    const extracted = extractPriorRunSummary(events);
    expect(extracted).not.toBe("");
    expect(extracted).toBe(written);
  });

  it("round-trip survives re-read after multiple events", async () => {
    const first = "First task summary.";
    const second = "Second task summary.";
    await appendFsConversationEvent({ repoPath: tmpDir, threadId, event: { type: "agent_summary", ts: 1, text: first } });
    await appendFsConversationEvent({ repoPath: tmpDir, threadId, event: { type: "agent_summary", ts: 2, text: second } });

    const events = readFsConversationEvents({ repoPath: tmpDir, threadId });
    expect(events).toHaveLength(2);

    // extractPriorRunSummary scans newest-first and returns the MOST RECENT agent_summary.
    const extracted = extractPriorRunSummary(events);
    expect(extracted).toBe(second);
  });

  it("returns empty string when no events exist", () => {
    const events = readFsConversationEvents({ repoPath: tmpDir, threadId });
    expect(events).toHaveLength(0);
    expect(extractPriorRunSummary(events)).toBe("");
  });
});

// ── 2. Toggle off → no SESSION MEMORY block ──────────────────────────────────

describe("session memory toggle — off", () => {
  it("no SESSION MEMORY block when priorSessionSummary is undefined", () => {
    const content = buildUserContent({ priorSessionSummary: undefined, task: "Fix the bug." });
    expect(content).not.toContain("SESSION MEMORY");
    expect(content).toBe("Fix the bug.");
  });

  it("no SESSION MEMORY block when priorSessionSummary is empty string", () => {
    const content = buildUserContent({ priorSessionSummary: "", task: "Fix the bug." });
    expect(content).not.toContain("SESSION MEMORY");
  });
});

// ── 3. Toggle on → neutral SESSION MEMORY framing ────────────────────────────

describe("session memory toggle — on", () => {
  it("SESSION MEMORY block appears with neutral header (plural turns)", () => {
    const summary = "## What changed\n- Added auth\n## Why\nNeeded by login.";
    const content = buildUserContent({ priorSessionSummary: summary, task: "Now add tests." });

    expect(content).toContain("SESSION MEMORY — context from earlier turns in this session:");
    expect(content).toContain("END SESSION MEMORY.");
    expect(content).toContain(summary);
    expect(content).toContain("Now add tests.");
  });

  it("SESSION MEMORY does NOT use rollback framing", () => {
    const summary = "Prior task summary.";
    const content = buildUserContent({ priorSessionSummary: summary });

    expect(content).not.toContain("your last attempt");
    expect(content).not.toContain("PRIOR RUN CONTEXT");
    expect(content).not.toContain("WHERE the problem is");
    expect(content).not.toContain("APPLY_ROLLED_BACK");
  });

  it("SESSION MEMORY block comes before the task", () => {
    const summary = "Prior summary text.";
    const task = "Do next task.";
    const content = buildUserContent({ priorSessionSummary: summary, task });

    const memIdx = content.indexOf("SESSION MEMORY");
    const taskIdx = content.indexOf(task);
    expect(memIdx).toBeLessThan(taskIdx);
  });
});

// ── 4. Double-injection suppression ──────────────────────────────────────────

describe("double-injection suppression (Phase 1)", () => {
  it("PRIOR RUN CONTEXT is suppressed when session window (sessionMemBlock) is non-empty", () => {
    // When the session window carries history, the newest turn's content is already
    // present — PRIOR RUN CONTEXT would double-inject the same summary with wrong framing.
    const sessionSummary = "Session window with recent turn content.";
    const rollbackSummary = "APPLY_ROLLED_BACK — patch was reverted.";
    const content = buildUserContent({
      priorSessionSummary: sessionSummary,
      priorRunSummary: rollbackSummary,
      task: "Fix the rollback.",
    });

    // Session window is present; PRIOR RUN CONTEXT is suppressed
    expect(content).toContain("SESSION MEMORY");
    expect(content).not.toContain("PRIOR RUN CONTEXT");
    // The header line appears exactly once (not doubled with PRIOR RUN CONTEXT)
    const headerCount = (content.match(/SESSION MEMORY — context from/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it("PRIOR RUN CONTEXT appears when sessionMemBlock is empty (no window)", () => {
    const rollbackSummary = "APPLY_ROLLED_BACK — patch was reverted.";
    const content = buildUserContent({
      priorSessionSummary: undefined,
      priorRunSummary: rollbackSummary,
      task: "Fix the rollback.",
    });
    expect(content).not.toContain("SESSION MEMORY");
    expect(content).toContain("PRIOR RUN CONTEXT");
  });

  it("PRIOR RUN CONTEXT is absent when priorRunSummary is empty (regardless of session window)", () => {
    const content = buildUserContent({ priorSessionSummary: "Session mem.", priorRunSummary: "" });
    expect(content).not.toContain("PRIOR RUN CONTEXT");
    expect(content).toContain("SESSION MEMORY");
  });
});

// ── 5. Static prefix invariant ───────────────────────────────────────────────

describe("static prefix invariant", () => {
  it("assembleAgentSystemPrompt is byte-identical regardless of (absent) priorSessionSummary", () => {
    // priorSessionSummary is NOT a parameter of assembleAgentSystemPrompt.
    const p1 = assembleAgentSystemPrompt(PATCH_INPUT);
    const p2 = assembleAgentSystemPrompt({ ...PATCH_INPUT });
    expect(p1).toBe(p2);
  });

  it("system prompt contains static SESSION MEMORY directive docs (not dynamic content)", () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain("SESSION MEMORY — if the user message begins with");
    // Updated to pluralized wording (Phase 1)
    expect(prompt).toContain("It describes COMPLETED work");
    // priorSessionSummary is NOT a parameter of assembleAgentSystemPrompt — no dynamic
    // session data can appear here. Confirmed by byte-identical test above.
    expect(prompt).not.toContain("Added auth module in this session");
  });
});

// ── Phase 2 — SESSION_MEMORY_CLEAR reducer ───────────────────────────────────

describe("SESSION_MEMORY_CLEAR reducer", () => {
  const OLD_SESSION_ID = "aaaaaaaa-0000-0000-0000-000000000001";
  const NEW_SESSION_ID = "bbbbbbbb-0000-0000-0000-000000000002";

  it("sets sessionId to the new id provided in the action", () => {
    const state = buildInitialState({ model: "test", capUsd: 10, resumedSessionId: OLD_SESSION_ID });
    expect(state.sessionId).toBe(OLD_SESSION_ID);

    const next = reducer(state, { type: "SESSION_MEMORY_CLEAR", newSessionId: NEW_SESSION_ID });
    expect(next.sessionId).toBe(NEW_SESSION_ID);
    expect(next.sessionId).not.toBe(OLD_SESSION_ID);
  });

  it("closes the modal and appends a confirmation transcript entry", () => {
    const state = { ...buildInitialState({ model: "test", capUsd: 10 }), modalView: "session" as const };

    const next = reducer(state, { type: "SESSION_MEMORY_CLEAR", newSessionId: NEW_SESSION_ID });
    expect(next.modalView).toBe("none");
    const confirmEntry = next.transcript.at(-1);
    expect(confirmEntry?.kind).toBe("user_prompt");
    expect(confirmEntry?.text).toContain("Session memory cleared");
  });

  it("leaves transcript unchanged except for the confirmation entry", () => {
    const state = buildInitialState({ model: "test", capUsd: 10 });
    const prevLen = state.transcript.length;

    const next = reducer(state, { type: "SESSION_MEMORY_CLEAR", newSessionId: NEW_SESSION_ID });
    expect(next.transcript.length).toBe(prevLen + 1);
  });
});

// ── Phase 2 — default-on: new sessionId has no prior summary ─────────────────

describe("default-on: new sessionId finds no prior summary", () => {
  let tmpDir: string;
  const OLD_ID = "c3d4e5f6-a7b8-9012-cdef-012345678903";
  const NEW_ID = "d4e5f6a7-b8c9-0123-defa-123456789014";

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-p2-test-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("a session cleared to a new id loads no prior summary even when old id had events", async () => {
    await appendFsConversationEvent({
      repoPath: tmpDir,
      threadId: OLD_ID,
      event: { type: "agent_summary", ts: Date.now(), text: "Old summary text." },
    });

    // Old id has events
    const oldEvents = readFsConversationEvents({ repoPath: tmpDir, threadId: OLD_ID });
    expect(extractPriorRunSummary(oldEvents)).not.toBe("");

    // New id (post-clear) has nothing
    const newEvents = readFsConversationEvents({ repoPath: tmpDir, threadId: NEW_ID });
    expect(extractPriorRunSummary(newEvents)).toBe("");
  });
});

// ── Phase 2 — StatusBar memory-pill logic ────────────────────────────────────

describe("StatusBar memory pill logic", () => {
  it("memOn is true when modelSettings is null (TUI default)", () => {
    const state = buildInitialState({ model: "test", capUsd: 10 });
    // modelSettings is null when no disk file has been loaded
    expect(state.modelSettings).toBeNull();
    const memOn = state.modelSettings?.memoryEnabled ?? true;
    expect(memOn).toBe(true);
  });

  it("memOn is true when memoryEnabled is explicitly true", () => {
    const state = buildInitialState({ model: "test", capUsd: 10 });
    const stateWithSettings = reducer(state, { type: "MEMORY_APPLY", memoryEnabled: true });
    const memOn = stateWithSettings.modelSettings?.memoryEnabled ?? true;
    expect(memOn).toBe(true);
  });

  it("memOn is false when memoryEnabled is explicitly false", () => {
    const state = buildInitialState({ model: "test", capUsd: 10 });
    const stateWithOff = reducer(state, { type: "MEMORY_APPLY", memoryEnabled: false });
    const memOn = stateWithOff.modelSettings?.memoryEnabled ?? true;
    expect(memOn).toBe(false);
  });
});

// ── 6. stripBanner ────────────────────────────────────────────────────────────

describe("stripBanner", () => {
  it("strips the agent-loop banner", () => {
    const raw = "=== AGENT LOOP SUMMARY ===\n## What changed\n- Added auth\n";
    expect(stripBanner(raw)).toBe("## What changed\n- Added auth\n");
  });

  it("strips the legacy patch preview banner", () => {
    const raw = "=== LLM PATCH PREVIEW ===\n--- a/foo.ts\n+++ b/foo.ts\n";
    expect(stripBanner(raw)).toBe("--- a/foo.ts\n+++ b/foo.ts\n");
  });

  it("passes through a string with no banner", () => {
    const plain = "## What changed\n- Added auth\n";
    expect(stripBanner(plain)).toBe(plain);
  });

  it("passes through empty string", () => {
    expect(stripBanner("")).toBe("");
  });
});

// ── Phase 5 guard tests ───────────────────────────────────────────────────────

describe("Phase 5 guard: repoPath vs process.cwd() (standing regression tests)", () => {
  it("turn write site uses config.repoPath not process.cwd() (repoPathTrap guard)", () => {
    // Grep the source to confirm the write intent is correct and intentional.
    const src = fs.readFileSync(path.resolve("src/cli/tui/index.tsx"), "utf8");
    // The appendFsConversationEvent call must key on config.repoPath
    expect(src).toContain("repoPath: config.repoPath");
    // The repoPathTrap comment must be present (guards the intent)
    expect(src).toContain("NOT process.cwd() — repoPathTrap");
  });
});

describe("Phase 5 guard: cwd !== repoPath reconciliation", () => {
  let tmpDir: string;
  const threadId = "e5f6a7b8-c9d0-1234-efab-234567890cd5"; // UUID-shaped, distinct

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-repopath-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("window reads from repoPath, not process.cwd(), when they differ", async () => {
    const repoPath = tmpDir; // deliberately != process.cwd()

    // Write a turn event to repoPath (the correct path)
    const ok = await appendFsConversationEvent({
      repoPath,
      threadId,
      event: {
        type: "turn",
        ts: Date.now(),
        runId: "r1",
        userPrompt: "fix the auth bug",
        summary: "Fixed the auth module in src/auth.ts",
        changedFiles: ["src/auth.ts"],
        outcome: "applied",
      },
    });
    expect(ok).toBe(true);

    // Reading from repoPath → finds the event → window is non-empty
    const eventsFromRepo = readFsConversationEvents({ repoPath, threadId });
    expect(eventsFromRepo).toHaveLength(1);
    const window = buildSessionWindow(eventsFromRepo);
    expect(window).toContain("fix the auth bug");
    expect(window).toContain("src/auth.ts");

    // Reading from cwd → finds nothing (file lives in repoPath, not cwd)
    const eventsFromCwd = readFsConversationEvents({ repoPath: process.cwd(), threadId });
    expect(eventsFromCwd).toHaveLength(0);
    const emptyWindow = buildSessionWindow(eventsFromCwd);
    expect(emptyWindow).toBe("");
  });
});
