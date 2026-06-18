/**
 * Tests for durable resume threading in _runPromptImpl (S9 Fix A + Fix B).
 *
 * Fix A: pendingEnvelopeResume?.sessionId becomes the envelope sessionId
 *        passed to runOneShotInner (and used as localSessionId for lifecycle).
 * Fix B: pendingEnvelopeResume?.preGeneratedPlan and .resume are threaded
 *        to runOneShotInner so plan-mode users skip re-planning/PlanReadyModal.
 *
 * Consume-once invariant: deps.pendingEnvelopeResume is nulled after first
 * call so subsequent submits run fresh (no double-resume).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runOneShotInner: vi.fn(),
  buildResumeFlowInput: vi.fn(),
}));

vi.mock("../dispatch.js", () => ({
  runOneShotInner: mocks.runOneShotInner,
  buildResumeFlowInput: mocks.buildResumeFlowInput,
}));

// ── imports (after mock registration) ─────────────────────────────────────────

import { _runPromptImpl, type _RunPromptDeps } from "./index.js";
import { createEventBus } from "../eventBus.js";
import type { StoreState } from "./store.js";
import type { CliConfig } from "../config.js";
import type { OneShotOpts } from "../dispatch.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(repoPath: string): CliConfig {
  return {
    memoryEnabled: false, // skip session-window FS reads for simplicity
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

function makeFlowResult() {
  return {
    ok: true,
    fileDiffs: [],
  } as unknown as import("../../core/runLlmPatchFlow.js").LlmPatchFlowResult;
}

const ENVELOPE_SESSION_ID = "2b37f320-bff8-46c5-b196-6cdfcb1235ed";

const RESUME_PAYLOAD = {
  stagingFiles: new Map([["src/foo.ts", "// staged content"]]),
  todos: [],
  failureHistory: [],
  contextBlock: "RESUMED RUN — continuing interrupted work.",
};

const ENVELOPE_PLAN = {
  objective: "Restore interrupted work",
  steps: [{ title: "Continue editing foo.ts", filesLikely: ["src/foo.ts"], description: "" }],
  riskHints: [],
  scopeSummary: "Continue foo.ts edit",
};

function makeEnvelopeResume(): NonNullable<_RunPromptDeps["pendingEnvelopeResume"]> {
  return {
    task: "add a greeting",
    repoPath: "/tmp/ztest",
    runId: randomUUID(),
    sessionId: ENVELOPE_SESSION_ID,
    provider: "anthropic",
    userApiKey: "sk-ant-test",
    abortSignal: undefined,
    preGeneratedPlan: ENVELOPE_PLAN,
    priorSessionSummary: undefined,
    mode: "patch",
    onProgress: undefined,
    resume: RESUME_PAYLOAD,
  } as unknown as NonNullable<_RunPromptDeps["pendingEnvelopeResume"]>;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("durable resume — _runPromptImpl threading (Fix A + Fix B)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "zone-resume-"));
    mocks.runOneShotInner.mockReset();
    mocks.runOneShotInner.mockResolvedValue(makeFlowResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Fix A: sessionId from envelope ───────────────────────────────────────

  it("A: pendingEnvelopeResume set → runOneShotInner receives envelope sessionId", async () => {
    const localSessionId = randomUUID();
    const deps: _RunPromptDeps = {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
      pendingEnvelopeResume: makeEnvelopeResume(),
    };

    await _runPromptImpl("add a greeting", new AbortController(), "normal", undefined, deps);

    expect(mocks.runOneShotInner).toHaveBeenCalledOnce();
    const opts = mocks.runOneShotInner.mock.calls[0]![3] as OneShotOpts;
    expect(opts.sessionId).toBe(ENVELOPE_SESSION_ID);
  });

  // ── Fix B: resume + preGeneratedPlan threaded ─────────────────────────────

  it("B1: pendingEnvelopeResume set → runOneShotInner receives resume payload", async () => {
    const localSessionId = randomUUID();
    const deps: _RunPromptDeps = {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
      pendingEnvelopeResume: makeEnvelopeResume(),
    };

    await _runPromptImpl("add a greeting", new AbortController(), "normal", undefined, deps);

    const opts = mocks.runOneShotInner.mock.calls[0]![3] as OneShotOpts;
    expect(opts.resume).toEqual(RESUME_PAYLOAD);
  });

  it("B2: pendingEnvelopeResume set → runOneShotInner receives preGeneratedPlan", async () => {
    const localSessionId = randomUUID();
    const deps: _RunPromptDeps = {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
      pendingEnvelopeResume: makeEnvelopeResume(),
    };

    await _runPromptImpl("add a greeting", new AbortController(), "plan", undefined, deps);

    const opts = mocks.runOneShotInner.mock.calls[0]![3] as OneShotOpts;
    expect((opts.preGeneratedPlan as typeof ENVELOPE_PLAN | undefined)?.objective).toBe(
      ENVELOPE_PLAN.objective
    );
  });

  // ── Normal path unchanged ─────────────────────────────────────────────────

  it("C: pendingEnvelopeResume = null → runOneShotInner has no resume, no preGeneratedPlan", async () => {
    const localSessionId = randomUUID();
    const deps: _RunPromptDeps = {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
      pendingEnvelopeResume: null,
    };

    await _runPromptImpl("do a task", new AbortController(), "normal", undefined, deps);

    const opts = mocks.runOneShotInner.mock.calls[0]![3] as OneShotOpts;
    expect(opts.preGeneratedPlan).toBeUndefined();
    expect(opts.resume).toBeUndefined();
  });

  // ── Consume-once invariant ────────────────────────────────────────────────

  it("D: pendingEnvelopeResume is null after first call → second call gets no resume", async () => {
    const localSessionId = randomUUID();
    const deps: _RunPromptDeps = {
      config: makeConfig(tmpDir),
      storeCapture: makeStoreCapture(null),
      bus: createEventBus(),
      localSessionId,
      pendingEnvelopeResume: makeEnvelopeResume(),
    };

    // First call — consumes the envelope resume
    await _runPromptImpl("add a greeting", new AbortController(), "normal", undefined, deps);
    expect(deps.pendingEnvelopeResume).toBeNull();

    // Second call — no envelope, fresh run
    await _runPromptImpl("a follow-up task", new AbortController(), "normal", undefined, deps);

    expect(mocks.runOneShotInner).toHaveBeenCalledTimes(2);
    const secondOpts = mocks.runOneShotInner.mock.calls[1]![3] as OneShotOpts;
    expect(secondOpts.resume).toBeUndefined();
    expect(secondOpts.preGeneratedPlan).toBeUndefined();
    // sessionId falls back to localSessionId (store is null → _resolveSessionId → localSessionId)
    expect(secondOpts.sessionId).not.toBe(ENVELOPE_SESSION_ID);
  });
});
