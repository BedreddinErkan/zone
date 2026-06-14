/**
 * Integration test: cross-turn context (Issue 1).
 *
 * Tests the real _runPromptImpl code path with storeCapture.state = null
 * (first-tick race). Exercises Change B (_resolveSessionId fallback) and
 * Change C (continuation injection without priorSessionSummary && gate).
 *
 * LLM is mocked (vi.mock ../dispatch.js). All other modules are real:
 * conversationFilesystemStore writes to a real temp dir, sessionWindow
 * builds the real session window and continuation context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runOneShotInner: vi.fn(),
}));

vi.mock("../dispatch.js", () => ({
  runOneShotInner: mocks.runOneShotInner,
}));

// ── imports (after mock registration) ─────────────────────────────────────────

import { _runPromptImpl, _resolveSessionId, type _RunPromptDeps } from "./index.js";
import { readFsConversationEvents } from "../../core/conversationFilesystemStore.js";
import { buildContinuationContext } from "../../llm/sessionWindow.js";
import { createEventBus } from "../eventBus.js";
import type { StoreState } from "./store.js";
import type { CliConfig } from "../config.js";
import type { OneShotOpts } from "../dispatch.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(repoPath: string): CliConfig {
  return {
    memoryEnabled: true,
    repoPath,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    commitOnSuccess: false,
  } as unknown as CliConfig;
}

function makeStoreCapture(state: Partial<StoreState> | null): _RunPromptDeps["storeCapture"] {
  return {
    state: state as StoreState | null,
    lastCommitData: null,
    lastFeedbackData: null,
    dispatch: null,
  };
}

// Only the fields _runPromptImpl and _writeTurnRecord actually read.
function makeFlowResult(patchPreview?: string) {
  return {
    ok: true,
    fileDiffs: [],
    ...(patchPreview !== undefined ? { patchPreview } : {}),
  } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("cross-turn context — Issue 1 (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "zone-cross-turn-"));
    mocks.runOneShotInner.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── _resolveSessionId unit (Change B) ─────────────────────────────────────

  it("_resolveSessionId: returns localSessionId when storeState is null", () => {
    const localId = randomUUID();
    expect(_resolveSessionId(null, localId)).toBe(localId);
  });

  it("_resolveSessionId: prefers storeState.sessionId when populated", () => {
    const localId = randomUUID();
    const storeId = randomUUID();
    expect(_resolveSessionId({ sessionId: storeId }, localId)).toBe(storeId);
  });

  // ── Test A: turn-1 write survives the first-tick race ────────────────────
  //
  // Before the fix: storeCapture.state?.sessionId = undefined → if (sessionId) = false
  //   → _writeTurnRecord skipped → no file → assertion fails.
  // After the fix:  _resolveSessionId(null, localSessionId) = localSessionId
  //   → if (sessionId) = true → file written → assertion passes.

  it("A: turn-1 JSONL is written even when storeCapture.state is null", async () => {
    const localSessionId = randomUUID();
    const patchPreview = "Section 1: Analysis\nSection 2: Findings\nSection 3: Summary";

    mocks.runOneShotInner.mockResolvedValueOnce(makeFlowResult(patchPreview));

    await _runPromptImpl("generate full report", new AbortController(), "normal", undefined, {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null), // null = React hasn't populated state yet
      bus: createEventBus(),
      localSessionId,
    });

    // File must exist at the expected path
    const filePath = path.join(tmpDir, ".zone", "conversations", `${localSessionId}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    // Must have a type:turn event with non-empty fullAnswer
    const events = readFsConversationEvents({ repoPath: tmpDir, threadId: localSessionId });
    const turnEvent = events.find(e => e.type === "turn");
    expect(turnEvent).toBeDefined();
    expect(String(turnEvent!.fullAnswer)).toContain("Section 1: Analysis");
  });

  // ── Test B: turn-2 continuation injection ─────────────────────────────────
  //
  // Proves: same-sessionId read path works AND the dropped priorSessionSummary &&
  // gate (Change C) allows injection when the base window is fresh from turn 1.

  it("B: turn-2 priorSessionSummary contains turn-1 fullAnswer on continue-intent", async () => {
    const localSessionId = randomUUID();
    const patchPreview = "Section 1: Analysis\nSection 2: Findings\nSection 3: Summary";

    // Turn 1: state=null (first-tick race), writes JSONL with fullAnswer
    mocks.runOneShotInner.mockResolvedValueOnce(makeFlowResult(patchPreview));

    await _runPromptImpl("generate full report", new AbortController(), "normal", undefined, {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
    });

    // Sanity: turn 1 wrote a fullAnswer
    const eventsAfterTurn1 = readFsConversationEvents({ repoPath: tmpDir, threadId: localSessionId });
    expect(eventsAfterTurn1.find(e => e.type === "turn" && e.fullAnswer)).toBeDefined();

    // Turn 2: state now populated (React called onStateChange after first render)
    let capturedPriorSessionSummary: string | undefined;
    mocks.runOneShotInner.mockImplementationOnce(async (
      _task: string,
      _config: CliConfig,
      _runId: string,
      opts: OneShotOpts
    ) => {
      capturedPriorSessionSummary = opts.priorSessionSummary;
      return makeFlowResult("Turn 2 result");
    });

    await _runPromptImpl(
      "continue from section 2 of the report",
      new AbortController(),
      "normal",
      undefined,
      {
        config: makeConfig(tmpDir),
        storeCapture: makeStoreCapture({ sessionId: localSessionId }),
        bus: createEventBus(),
        localSessionId,
      }
    );

    // Must have injected the full content block from turn 1
    expect(capturedPriorSessionSummary).toBeDefined();
    expect(capturedPriorSessionSummary).toContain("PRIOR TURN FULL CONTENT (continuation requested)");
    expect(capturedPriorSessionSummary).toContain("Section 1: Analysis");
    expect(capturedPriorSessionSummary).toContain("Section 2: Findings");
  });

  // ── Test C: no spurious injection when fullAnswer is absent ───────────────
  //
  // Proves: buildContinuationContext(null) → block not injected, no crash.

  it("C: no continuation block injected when turn-1 has no patchPreview", async () => {
    const localSessionId = randomUUID();

    // Turn 1: no patchPreview → no fullAnswer written
    mocks.runOneShotInner.mockResolvedValueOnce(makeFlowResult(/* no patchPreview */));

    await _runPromptImpl("do something", new AbortController(), "normal", undefined, {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
    });

    // Verify: turn event exists but has no fullAnswer
    const eventsAfterTurn1 = readFsConversationEvents({ repoPath: tmpDir, threadId: localSessionId });
    const turnEvent = eventsAfterTurn1.find(e => e.type === "turn");
    expect(turnEvent).toBeDefined();
    expect(turnEvent?.fullAnswer).toBeUndefined();
    expect(buildContinuationContext(eventsAfterTurn1)).toBeNull();

    // Turn 2: continue-intent — capture what the LLM receives
    let capturedPriorSessionSummary: string | undefined;
    mocks.runOneShotInner.mockImplementationOnce(async (
      _task: string,
      _config: CliConfig,
      _runId: string,
      opts: OneShotOpts
    ) => {
      capturedPriorSessionSummary = opts.priorSessionSummary;
      return makeFlowResult();
    });

    await _runPromptImpl(
      "continue from section 2",
      new AbortController(),
      "normal",
      undefined,
      {
        config: makeConfig(tmpDir),
        storeCapture: makeStoreCapture({ sessionId: localSessionId }),
        bus: createEventBus(),
        localSessionId,
      }
    );

    // Must NOT have injected the continuation block
    if (capturedPriorSessionSummary !== undefined) {
      expect(capturedPriorSessionSummary).not.toContain("PRIOR TURN FULL CONTENT");
    }
  });
});
