/**
 * Phase J.5.1 — filesystem-first conversation store tests.
 *
 * Cross-run rollback persistence has TWO layers:
 *   - Supabase (optional, when env vars are present)
 *   - Filesystem (always, at <repoPath>/.zone/conversations/<id>.jsonl)
 *
 * These tests pin the filesystem-layer contract. The Supabase ↔ FS
 * fallthrough is exercised separately via the runLlmPatchFlow integration
 * test wire (J.5.2 source-shape coverage) — here we focus on the FS
 * helpers' invariants in isolation.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FS_CONVERSATION_DIR,
  FS_CONVERSATION_MAX_EVENTS,
  appendFsConversationEvent,
  isValidThreadId,
  readFsConversationEvents,
} from "./conversationFilesystemStore.js";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(path.join(tmpdir(), "zone-j51-"));
});
afterEach(() => {
  try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
});

describe("Phase J.5.1 — isValidThreadId path-traversal guard", () => {
  it("accepts realistic uuid-shaped thread ids", () => {
    expect(isValidThreadId("d4e1f0a9-2b6c-4f15-9a7e-3c8d2b1a4f6e")).toBe(true);
    expect(isValidThreadId("run_2026_05_15_abc123")).toBe(true);
    expect(isValidThreadId("thread-1")).toBe(true);
  });

  it("rejects path-traversal attempts", () => {
    expect(isValidThreadId("../../etc/passwd")).toBe(false);
    expect(isValidThreadId("..")).toBe(false);
    expect(isValidThreadId("a/b")).toBe(false);
    expect(isValidThreadId("a\\b")).toBe(false);
    expect(isValidThreadId("a.b")).toBe(false); // dots forbidden (slug-only)
    expect(isValidThreadId("a b")).toBe(false); // whitespace
    expect(isValidThreadId("")).toBe(false);
    expect(isValidThreadId("-leading-dash")).toBe(false); // first char must be alnum
    expect(isValidThreadId(null)).toBe(false);
    expect(isValidThreadId(undefined)).toBe(false);
    expect(isValidThreadId(123 as unknown)).toBe(false);
  });

  it("rejects absurdly long thread ids (>128 chars)", () => {
    const longId = "a".repeat(129);
    expect(isValidThreadId(longId)).toBe(false);
    const okId = "a".repeat(128);
    expect(isValidThreadId(okId)).toBe(true);
  });
});

describe("Phase J.5.1 — appendFsConversationEvent write path", () => {
  it("creates .zone/conversations/<threadId>.jsonl with the event as one line", async () => {
    const ok = await appendFsConversationEvent({
      repoPath,
      threadId: "thread-1",
      event: {
        type: "agent_summary",
        ts: 1700000000000,
        decisionMode: "rolled_back",
        text: "APPLY_ROLLED_BACK\nsample body",
      },
    });
    expect(ok).toBe(true);
    const filePath = path.join(repoPath, FS_CONVERSATION_DIR, "thread-1.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      type: "agent_summary",
      decisionMode: "rolled_back",
    });
    expect(parsed.text).toContain("APPLY_ROLLED_BACK");
  });

  it("appends sequential events as separate JSONL lines, oldest-first", async () => {
    for (let i = 0; i < 3; i++) {
      await appendFsConversationEvent({
        repoPath,
        threadId: "tid",
        event: { type: "agent_summary", ts: i, text: `body-${i}` },
      });
    }
    const filePath = path.join(repoPath, FS_CONVERSATION_DIR, "tid.jsonl");
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).text).toBe("body-0");
    expect(JSON.parse(lines[2]!).text).toBe("body-2");
  });

  it("rotates: when 50+ events exist, the next write drops oldest to keep file bounded", async () => {
    // Seed FS_CONVERSATION_MAX_EVENTS + 5 events directly via repeated appends.
    for (let i = 0; i < FS_CONVERSATION_MAX_EVENTS + 5; i++) {
      await appendFsConversationEvent({
        repoPath,
        threadId: "rot",
        event: { type: "agent_summary", ts: i, text: `body-${i}` },
      });
    }
    const events = readFsConversationEvents({ repoPath, threadId: "rot" });
    expect(events.length).toBe(FS_CONVERSATION_MAX_EVENTS);
    // Oldest 5 dropped — surviving range is [5, 5+50) = ts 5..54.
    expect((events[0] as { text: string }).text).toBe("body-5");
    expect((events[events.length - 1] as { text: string }).text).toBe(
      `body-${FS_CONVERSATION_MAX_EVENTS + 4}`
    );
  });

  it("returns false for invalid threadId (path traversal blocked at write time)", async () => {
    const ok = await appendFsConversationEvent({
      repoPath,
      threadId: "../../etc/passwd",
      event: { type: "agent_summary", ts: 1, text: "x" },
    });
    expect(ok).toBe(false);
    // Critically: no file written ANYWHERE — verify the legitimate path is empty
    // and the parent .zone/conversations dir wasn't even created for an invalid id.
    expect(existsSync(path.join(repoPath, FS_CONVERSATION_DIR))).toBe(false);
  });

  it("returns false for empty repoPath / event shape", async () => {
    expect(
      await appendFsConversationEvent({
        repoPath: "",
        threadId: "tid",
        event: { type: "agent_summary", ts: 1 },
      })
    ).toBe(false);
    expect(
      await appendFsConversationEvent({
        repoPath,
        threadId: "tid",
        event: { type: "" as "agent_summary", ts: 1 },
      })
    ).toBe(false);
  });
});

describe("Phase J.5.1 — readFsConversationEvents read path", () => {
  it("returns [] when the JSONL file doesn't exist", () => {
    expect(readFsConversationEvents({ repoPath, threadId: "missing" })).toEqual([]);
  });

  it("returns [] for invalid threadId (path traversal blocked at read time)", () => {
    expect(readFsConversationEvents({ repoPath, threadId: "../../etc/passwd" })).toEqual([]);
  });

  it("skips malformed lines but surfaces valid ones", () => {
    const filePath = path.join(repoPath, FS_CONVERSATION_DIR, "mixed.jsonl");
    // Construct a file by hand: 2 valid events bracketing a malformed line.
    const content =
      JSON.stringify({ type: "agent_summary", ts: 1, text: "a" }) +
      "\n{ not json }\n" +
      JSON.stringify({ type: "agent_summary", ts: 2, text: "b" }) +
      "\n";
    require("node:fs").mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    const events = readFsConversationEvents({ repoPath, threadId: "mixed" });
    expect(events.length).toBe(2);
    expect((events[0] as { text: string }).text).toBe("a");
    expect((events[1] as { text: string }).text).toBe("b");
  });
});

describe("Phase J.5.1 — round-trip parity with extractPriorRunSummary", () => {
  it("a write → read round-trip preserves the marker so extractPriorRunSummary returns it", async () => {
    const { extractPriorRunSummary, buildApplyRolledBackMessage } = await import(
      "../llm/applyRollbackFeedback.js"
    );
    const marker = buildApplyRolledBackMessage({
      filePath: "src/llm/detectIntent.ts",
      errors: [
        {
          code: "TS2305",
          message: "Module has no exported member 'detectFramework'.",
          file: "src/llm/agentLoop.ts",
          line: 42,
          col: 7,
        },
      ],
      restoredFiles: ["src/llm/detectIntent.ts"],
    });
    await appendFsConversationEvent({
      repoPath,
      threadId: "roundtrip",
      event: {
        type: "agent_summary",
        ts: Date.now(),
        decisionMode: "rolled_back",
        text: marker,
      },
    });
    const events = readFsConversationEvents({ repoPath, threadId: "roundtrip" });
    const extracted = extractPriorRunSummary(events);
    expect(extracted.startsWith("APPLY_ROLLED_BACK\n")).toBe(true);
    expect(extracted).toContain("TS2305");
    expect(extracted).toContain("detectFramework");
    // Suggestion line carries through from C2's heuristic.
    expect(extracted).toContain("Suggested: ");
  });
});

describe("Phase J.5.1 — runLogging wires filesystem write before Supabase short-circuit", () => {
  // Structural source-shape test (matches the J.5.2 pattern): pins the
  // invariant that the FS write runs unconditionally regardless of
  // Supabase env, so a future refactor can't silently re-introduce the
  // production miss.
  // Skipped: src/api/runLogging.ts deleted in Stage 4 (server retirement).
  it.skip("logRun calls persistAgentSummaryToFilesystem before the Supabase null short-circuit", () => {
    const src = readFileSync(path.resolve("src/api/runLogging.ts"), "utf8");
    const logRunIdx = src.indexOf("export async function logRun(");
    expect(logRunIdx).toBeGreaterThan(-1);
    // Find the next two anchors after logRun's opening.
    const fsCallIdx = src.indexOf("persistAgentSummaryToFilesystem(input)", logRunIdx);
    const supabaseShortCircuitIdx = src.indexOf("if (!supabase) return null;", logRunIdx);
    expect(fsCallIdx).toBeGreaterThan(-1);
    expect(supabaseShortCircuitIdx).toBeGreaterThan(-1);
    expect(fsCallIdx).toBeLessThan(supabaseShortCircuitIdx);
  });

  it("runLlmPatchFlow tries filesystem fallback when Supabase didn't yield a summary", () => {
    const src = readFileSync(
      path.resolve("src/core/runLlmPatchFlow.ts"),
      "utf8"
    );
    // Import wired in.
    expect(src).toMatch(/from\s+["']\.\/conversationFilesystemStore\.js["']/);
    // FS fallback runs when priorRunSummary still empty after Supabase try.
    // Phase 1: !input.priorSessionSummary guard added to prevent double-injection.
    expect(src).toMatch(/if \(!priorRunSummary && !input\.priorSessionSummary && threadIdForLoad/);
    // Telemetry carries the source + count.
    expect(src).toContain("persistenceSource");
    expect(src).toContain("historyEventCount");
  });
});
