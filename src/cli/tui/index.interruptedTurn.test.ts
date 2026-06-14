/**
 * PR-B: Interrupted-run turn record.
 *
 * Tests for _writeTurnRecord — the extracted helper that writes an atomic
 * turn record to the JSONL session store. Covers the abort branch (new) and
 * the normal-run branch (regression guard).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  appendFsConversationEvent: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../core/conversationFilesystemStore.js", () => ({
  appendFsConversationEvent: mocks.appendFsConversationEvent,
}));

// ── import SUT ────────────────────────────────────────────────────────────────

import { _writeTurnRecord } from "./index.js";
import { ProviderRequestError } from "../../llm/factory.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG = { memoryEnabled: true, repoPath: "/repo" };

function makeRunResult(filePaths: string[] = ["src/a.ts"]) {
  return {
    ok: true,
    fileDiffs: filePaths.map(fp => ({ filePath: fp })),
    patchPreview: "Applied changes.",
  } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── scenarios ─────────────────────────────────────────────────────────────────

describe("_writeTurnRecord — abort branch", () => {
  it("1. writes interrupted record with correct outcome + summary + changedFiles", async () => {
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix the build",
      runResult: undefined,
      abortedFiles: ["src/a.ts", "src/b.ts"],
      aborted: true,
    });

    expect(mocks.appendFsConversationEvent).toHaveBeenCalledOnce();
    const call = mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>;
    const event = call.event as Record<string, unknown>;
    expect(event.outcome).toBe("interrupted");
    expect(event.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(String(event.summary)).toContain("2 files");
    expect(String(event.userPrompt)).toBe("fix the build");
  });

  it("4. N=0 abort — writes 'interrupted before any changes' with empty changedFiles", async () => {
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "add feature",
      runResult: undefined,
      abortedFiles: [],
      aborted: true,
    });

    expect(mocks.appendFsConversationEvent).toHaveBeenCalledOnce();
    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(event.outcome).toBe("interrupted");
    expect(event.changedFiles).toEqual([]);
    expect(event.summary).toBe("interrupted before any changes");
  });

  it("4b. abortedFiles undefined (abort before throwIfAborted attached files) → empty changedFiles", async () => {
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix",
      runResult: undefined,
      abortedFiles: undefined,
      aborted: true,
    });

    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(event.outcome).toBe("interrupted");
    expect(event.changedFiles).toEqual([]);
    expect(event.summary).toBe("interrupted before any changes");
  });
});

describe("_writeTurnRecord — gate: aborted=false must not write for error cases", () => {
  it("2. ProviderRequestError (aborted=false, runResult=undefined) → no write", async () => {
    // Simulate: catch block set emitSafetyNet=false but did NOT set aborted=true
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix",
      runResult: undefined,
      abortedFiles: undefined,
      aborted: false,
    });

    expect(mocks.appendFsConversationEvent).not.toHaveBeenCalled();
  });
});

describe("_writeTurnRecord — normal-run branch (regression guard)", () => {
  it("3. successful run writes expected outcome + changedFiles from fileDiffs", async () => {
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "add pagination",
      runResult: makeRunResult(["src/ui.ts", "src/api.ts"]),
      abortedFiles: undefined,
      aborted: false,
    });

    expect(mocks.appendFsConversationEvent).toHaveBeenCalledOnce();
    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(event.outcome).toBe("applied");
    expect(event.changedFiles).toEqual(["src/ui.ts", "src/api.ts"]);
    expect(event.outcome).not.toBe("interrupted");
  });

  it("3b. memoryEnabled=false skips write entirely", async () => {
    await _writeTurnRecord({
      config: { memoryEnabled: false, repoPath: "/repo" },
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix",
      runResult: makeRunResult(),
      abortedFiles: undefined,
      aborted: false,
    });

    expect(mocks.appendFsConversationEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fullAnswer write-path tests (Failure 2)
// ---------------------------------------------------------------------------

describe("_writeTurnRecord — fullAnswer field (Failure 2)", () => {
  it("writes fullAnswer when patchPreview is present", async () => {
    const runResult = {
      ok: true,
      fileDiffs: [{ filePath: "src/a.ts" }],
      patchPreview: "Section 1: Findings\nSection 2: Details",
    } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;

    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "generate report",
      runResult,
      abortedFiles: undefined,
      aborted: false,
    });

    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(typeof event.fullAnswer).toBe("string");
    expect(String(event.fullAnswer)).toContain("Section 1: Findings");
  });

  it("omits fullAnswer when patchPreview is absent", async () => {
    const runResult = {
      ok: true,
      fileDiffs: [],
      // no patchPreview
    } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;

    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix",
      runResult,
      abortedFiles: undefined,
      aborted: false,
    });

    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(event.fullAnswer).toBeUndefined();
  });

  it("aborted turn omits fullAnswer (no crash)", async () => {
    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "fix",
      runResult: undefined,
      abortedFiles: ["src/a.ts"],
      aborted: true,
    });

    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    expect(event.fullAnswer).toBeUndefined();
  });

  it("fullAnswer is head-kept: starts with beginning of patchPreview", async () => {
    const bigPreview = "HEAD_SECTION " + "x".repeat(20_000);
    const runResult = {
      ok: true,
      fileDiffs: [{ filePath: "src/a.ts" }],
      patchPreview: bigPreview,
    } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;

    await _writeTurnRecord({
      config: BASE_CONFIG,
      sessionId: "sess-1",
      runId: "run-1",
      prompt: "generate report",
      runResult,
      abortedFiles: undefined,
      aborted: false,
    });

    const event = (mocks.appendFsConversationEvent.mock.calls[0]![0] as Record<string, unknown>)
      .event as Record<string, unknown>;
    const fa = String(event.fullAnswer);
    expect(fa.startsWith("HEAD_SECTION")).toBe(true);
    expect(fa.length).toBeLessThanOrEqual(16_384);
  });
});

