/**
 * Durability at the park.
 *
 * The park is the longest window in a run during which the process can die —
 * it has no timeout, so it lasts as long as the human does. What has to survive
 * that window is the question itself, and the ordinary per-iteration checkpoint
 * cannot carry it: latestMessages is assigned once per iteration immediately
 * BEFORE the LLM call, so no checkpoint ever contains the assistant turn from
 * its own iteration.
 *
 * These tests reload the envelope from disk rather than spying on the flush, so
 * they fail if the bytes are wrong even when the call site is right.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";
import {
  loadRunEnvelope,
  buildResumeContextBlock,
  _setEnvelopeDirForTest,
  type RunEnvelope,
} from "../api/diskRunEnvelope.js";
import { resolveUserQuestion } from "../api/questionApprovals.js";

const SESSION_ID = "sess-park-0001";
const QUESTION = "Which auth module is canonical?";

function toolCallResponse(id: string, name: string, args: unknown) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const doneResponse = () => ({
  choices: [{
    message: { content: "done [ZONE_VERIFICATION: tests_skipped_no_infra]", tool_calls: null },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** Every message the model sees, flattened to text, for substring assertions. */
function flatten(messages: unknown[]): string {
  return JSON.stringify(messages);
}

let repoPath: string;
let envelopeDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-park-repo-"));
  envelopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-park-env-"));
  _setEnvelopeDirForTest(envelopeDir);
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file contents" });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  _setEnvelopeDirForTest(null);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.rmSync(envelopeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the forceFlush round trip", () => {
  it("the question is on disk before the loop waits on a human", async () => {
    // Read back from disk mid-park: if the flush happened after the wait (or not
    // at all), a crash during the wait loses the question and the resumed run
    // has no idea what it was blocked on.
    let envelopeDuringPark: RunEnvelope | null = null;

    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "pick an auth module",
      repoPath,
      runId: "run-park",
      sessionId: SESSION_ID,
      interactiveChannel: "tui",
      onStructuredEvent: (evt: unknown) => {
        const e = evt as { type?: string; questionId?: string };
        if (e?.type !== "user_question_required") return;
        // Still parked at this point — the emit happens inside the park.
        void loadRunEnvelope(SESSION_ID).then((env) => {
          envelopeDuringPark = env;
          resolveUserQuestion({ questionId: String(e.questionId), runId: "run-park", answer: "the second one" });
        });
      },
    });

    expect(envelopeDuringPark).not.toBeNull();
    const env = envelopeDuringPark as unknown as RunEnvelope;
    expect(env.messages).toBeDefined();
    // The assistant turn carrying the ask — the part the ordinary checkpoint
    // structurally cannot contain.
    expect(flatten(env.messages!)).toContain(QUESTION);
    expect(flatten(env.messages!)).toContain("ask_user");
    expect(env.messagesOmitted).toBeFalsy();
  });

  it("a subagent never writes an envelope, parked or not", async () => {
    // Subagents do not own staging, and the parent owns the envelope path.
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-sub",
      sessionId: SESSION_ID,
      subagent: { id: "s1", type: "worker", parentRunId: "run-parent" },
    });

    expect(await loadRunEnvelope(SESSION_ID)).toBeNull();
  });
});

describe("the size boundary", () => {
  it("an oversized conversation is dropped LOUDLY and flagged, never silently", async () => {
    // A dropped history is invisible on read: `messages: undefined` looks exactly
    // like "no checkpoint yet". This is the unknown-input-reaches-a-plausible-
    // default shape, and the house rule is a loud marker instead.
    const HUGE = "x".repeat(1_100_000);
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
      .mockResolvedValueOnce(doneResponse());
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: HUGE });

    let envelopeDuringPark: RunEnvelope | null = null;
    await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-huge",
      sessionId: SESSION_ID,
      interactiveChannel: "tui",
      onStructuredEvent: (evt: unknown) => {
        const e = evt as { type?: string; questionId?: string };
        if (e?.type !== "user_question_required") return;
        void loadRunEnvelope(SESSION_ID).then((env) => {
          envelopeDuringPark = env;
          resolveUserQuestion({ questionId: String(e.questionId), runId: "run-huge", answer: "ok" });
        });
      },
    });

    const env = envelopeDuringPark as unknown as RunEnvelope;
    expect(env).not.toBeNull();
    expect(env.messages).toBeUndefined();
    expect(env.messagesOmitted).toBe(true);

    const marker = logSpy.mock.calls.find((c) => c[0] === "[zone-envelope-messages-omitted]");
    expect(marker).toBeDefined();
    const payload = JSON.parse(String(marker![1])) as Record<string, unknown>;
    expect(payload.bytes).toBeGreaterThan(1_000_000);
    expect(payload.capBytes).toBe(1_000_000);
    expect(payload.sessionId).toBe(SESSION_ID);
  });
});

describe("resume acts on the flag", () => {
  function envWith(overrides: Partial<RunEnvelope>): RunEnvelope {
    return {
      version: 1,
      sessionId: SESSION_ID,
      pid: 999_999_99,
      repoPath: "/repo",
      model: "m",
      task: "do the thing",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:01:00.000Z",
      status: "token_budget_exceeded",
      executionPlan: null,
      todos: [],
      failureHistory: [],
      staging: [],
      flushedPaths: [],
      priorSessionSummary: "",
      ...overrides,
    };
  }

  it("tells the model the conversation is gone rather than letting it pretend", async () => {
    // Being able to detect the omission is not the requirement — a resume that
    // silently cold-starts is worse than the original drop, because the user is
    // now actively relying on continuity.
    const block = buildResumeContextBlock(envWith({ messagesOmitted: true }), []);
    expect(block).toContain("could NOT be restored");
    expect(block).toMatch(/only the summary/i);
    expect(block).toContain("Do not refer to earlier exchanges");
  });

  it("says nothing when the conversation was restored intact", async () => {
    const block = buildResumeContextBlock(envWith({ messages: [{ role: "user", content: "hi" }] }), []);
    expect(block).not.toMatch(/could NOT be restored/i);
  });
});
