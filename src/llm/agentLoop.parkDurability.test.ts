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

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  recordRunSummary: vi.fn(),
}));

// recordRunSummary has no directory override and writes to the real
// ~/.zone/usage/. Mocked both to assert on the latency it persists and to stop
// these tests appending records to the user's own usage log.
vi.mock("../usage/usageTracker.js", () => ({
  recordRunSummary: mocks.recordRunSummary,
  recordRunRetry: vi.fn(() => Promise.resolve()),
  getUsage: vi.fn(() => Promise.resolve({ totalCostUsd: 0 })),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import {
  runAgentLoop,
  reconcileDanglingToolCalls,
  UNANSWERED_ON_RESUME_REPLY,
} from "./agentLoop.js";
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
  mocks.recordRunSummary.mockReset();
  mocks.recordRunSummary.mockResolvedValue(undefined);
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
        void loadRunEnvelope("run-park").then((env) => {
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

    expect(await loadRunEnvelope("run-sub")).toBeNull();
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
        void loadRunEnvelope("run-huge").then((env) => {
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

// ── suspend across turns ─────────────────────────────────────────────────────

describe("stopping with a question outstanding", () => {
  it("returns awaiting_user_input instead of throwing, and records the question", async () => {
    // Defect 2: the envelope stamp sits in a try with only a finally, so a throw
    // from here sails past it and leaves status "running" with a LIVE pid —
    // which isResumable reads as "a run is in progress" and excludes for the
    // rest of the session. The run becomes unresumable precisely when the user
    // most wants to resume it.
    const ac = new AbortController();
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({
      task: "pick an auth module",
      repoPath,
      runId: "run-suspend",
      sessionId: SESSION_ID,
      interactiveChannel: "tui",
      abortSignal: ac.signal,
      onStructuredEvent: (evt: unknown) => {
        if ((evt as { type?: string })?.type === "user_question_required") ac.abort();
      },
    });

    expect(result.terminationReason).toBe("awaiting_user_input");
    expect(result.success).toBe(false);

    const env = await loadRunEnvelope("run-suspend");
    expect(env).not.toBeNull();
    expect(env!.status).toBe("awaiting_user_input");
    expect(env!.pendingQuestion?.question).toBe(QUESTION);
    // The tool_call_id is the part that matters mechanically: the restored
    // conversation ends with an assistant tool_call that still needs a reply.
    expect(env!.pendingQuestion?.toolCallId).toBe("t2");
    expect(flatten(env!.messages!)).toContain(QUESTION);
  });
});

// ── defect 3: one session, many runs, one file each ──────────────────────────

describe("a suspended envelope and the next thing the user does", () => {
  /** Suspends a run on a question and returns nothing but the side effects. */
  async function suspendOn(runId: string): Promise<void> {
    const ac = new AbortController();
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
      .mockResolvedValueOnce(doneResponse());
    await runAgentLoop({
      task: "pick an auth module",
      repoPath,
      runId,
      sessionId: SESSION_ID,
      interactiveChannel: "tui",
      abortSignal: ac.signal,
      onStructuredEvent: (evt: unknown) => {
        if ((evt as { type?: string })?.type === "user_question_required") ac.abort();
      },
    });
  }

  it("survives a second run in the same session", async () => {
    // The TUI mints one sessionId per PROCESS, so before per-run keying every run
    // wrote the same file and run 2's first checkpoint — which fires before its
    // first LLM call — destroyed the suspended conversation. Doing something else
    // was enough to lose it, with no read-before-write and no warning.
    await suspendOn("run-suspended");

    mocks.createChatCompletion.mockReset();
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t9", "read_file", { filePath: "src/b.ts", lineRange: null }))
      .mockResolvedValueOnce(doneResponse());
    await runAgentLoop({
      task: "something else entirely",
      repoPath,
      runId: "run-unrelated",
      sessionId: SESSION_ID,          // same session — the whole point
      interactiveChannel: "tui",
    });

    const suspended = await loadRunEnvelope("run-suspended");
    expect(suspended, "the suspended envelope was clobbered").not.toBeNull();
    expect(suspended!.status).toBe("awaiting_user_input");
    expect(suspended!.pendingQuestion?.question).toBe(QUESTION);
    expect(suspended!.task).toBe("pick an auth module");
    expect(flatten(suspended!.messages!)).toContain(QUESTION);
  });

  it("records the iteration the ask happened on", async () => {
    // Carried so a dismissal at the turn boundary reports the same shape as the
    // in-run decline rather than inventing a value for a field it cannot know.
    await suspendOn("run-iter");
    const env = await loadRunEnvelope("run-iter");
    expect(typeof env!.pendingQuestion?.iter).toBe("number");
  });
});

describe("a resume adopts its source envelope", () => {
  const ADOPTED = "envelope-being-resumed";
  const FRESH_RUN_ID = "run-freshly-minted";

  const envelopes = (): string[] =>
    fs.readdirSync(envelopeDir).filter(f => f.endsWith(".envelope.json"));

  it("writes to the adopted key, not to its own runId", async () => {
    // buildResumeFlowInput mints a fresh runId, so without adoption a resumed run
    // writes a SECOND envelope beside the one it is continuing.
    //
    // Asserted on a run that does NOT end cleanly, because a clean exit deletes
    // the envelope and erases the very difference under test — an earlier version
    // of this test ended cleanly and passed with adoption removed.
    const ac = new AbortController();
    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "continue the interrupted work",
      repoPath,
      runId: FRESH_RUN_ID,
      sessionId: SESSION_ID,
      envelopeKey: ADOPTED,
      resumeContextBlock: "RESUMED RUN — continuing an interrupted run.",
      interactiveChannel: "tui",
      abortSignal: ac.signal,
      onStructuredEvent: (evt: unknown) => {
        if ((evt as { type?: string })?.type === "user_question_required") ac.abort();
      },
    });

    expect(envelopes()).toEqual([`${ADOPTED}.envelope.json`]);
  });

  it("deletes the envelope it resumed when the run finally succeeds", async () => {
    // The source envelope must be pre-existing, or there is nothing for a
    // non-adopting run to leave behind and the assertion proves nothing.
    fs.writeFileSync(
      path.join(envelopeDir, `${ADOPTED}.envelope.json`),
      JSON.stringify({
        version: 1, sessionId: SESSION_ID, pid: process.pid, repoPath,
        model: "", task: "the interrupted work", createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z", status: "awaiting_user_input",
        executionPlan: null, todos: [], failureHistory: [], staging: [],
        flushedPaths: [], priorSessionSummary: "",
      }),
      "utf-8",
    );

    mocks.createChatCompletion
      .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "continue the interrupted work",
      repoPath,
      runId: FRESH_RUN_ID,
      sessionId: SESSION_ID,
      envelopeKey: ADOPTED,
      resumeContextBlock: "RESUMED RUN — continuing an interrupted run.",
      interactiveChannel: "tui",
    });

    // Nothing survives: without adoption the delete targets FRESH_RUN_ID and the
    // envelope the user resumed is immortal.
    expect(envelopes()).toEqual([]);
  });
});

// ── parked time is not latency ───────────────────────────────────────────────

describe("the latency a run persists", () => {
  it("excludes time spent parked on a human", async () => {
    // This figure lands in ~/.zone/usage/*.jsonl under model "__run_summary__"
    // and is read by metricsAggregator — the ONE place a long human pause would
    // outlive the session as recorded inference time.
    const recorded: number[] = [];
    mocks.recordRunSummary.mockImplementation(
      (p: { latencyMs: number }) => { recorded.push(p.latencyMs); return Promise.resolve(); }
    );

    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      mocks.createChatCompletion
        .mockResolvedValueOnce(toolCallResponse("t1", "read_file", { filePath: "src/a.ts", lineRange: null }))
        .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: QUESTION }))
        .mockResolvedValueOnce(doneResponse());

      await runAgentLoop({
        task: "pick an auth module",
        repoPath,
        runId: "run-latency",
        sessionId: SESSION_ID,
        interactiveChannel: "tui",
        onStructuredEvent: (evt: unknown) => {
          const e = evt as { type?: string; questionId?: string };
          if (e?.type === "user_question_required") {
            clock += 3_600_000;  // the user took an hour
            resolveUserQuestion({ questionId: String(e.questionId), runId: "run-latency", answer: "ok" });
          }
        },
      });

      expect(recorded).toHaveLength(1);
      // An hour parked must not read as an hour of inference.
      expect(recorded[0]).toBeLessThan(60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ── the answer reaches the model on BOTH resume branches ─────────────────────

describe("a carried-over answer", () => {
  const QUESTION_ASKED = "Which auth module is canonical?";
  const ANSWER = "src/auth/session.ts is canonical";

  /** The conversation as the envelope stores it, ending on the unanswered ask. */
  const suspendedMessages = (): unknown[] => ([
    { role: "system", content: "sys" },
    { role: "user", content: "pick an auth module" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t2", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: QUESTION_ASKED }) } }],
    },
  ]);

  async function runWithAnswer(resumeMessages: unknown[] | undefined): Promise<string> {
    mocks.createChatCompletion.mockReset();
    mocks.createChatCompletion.mockResolvedValueOnce(doneResponse());
    await runAgentLoop({
      task: "pick an auth module",
      repoPath,
      runId: "run-answering",
      sessionId: SESSION_ID,
      envelopeKey: "envelope-resumed",
      interactiveChannel: "tui",
      resumeContextBlock: "RESUMED RUN — continuing an interrupted run.",
      resumeMessages,
      resumeAnswer: ANSWER,
      resumePendingQuestion: { toolCallId: "t2", question: QUESTION_ASKED, iter: 1 },
    });
    return flatten(mocks.createChatCompletion.mock.calls[0]![0].messages as unknown[]);
  }

  it("fills the dangling ask_user reply when the conversation was restored", async () => {
    const sent = await runWithAnswer(suspendedMessages());
    expect(sent).toContain(ANSWER);
    // The whole point: NOT the "user was unavailable" text, which is what the
    // resume path produced before any UI put the question back to them.
    expect(sent).not.toContain(UNANSWERED_ON_RESUME_REPLY);
  });

  it("still reaches the model when the conversation was too large to save", async () => {
    // messagesOmitted ⇒ resumeMessages is undefined ⇒ isWarmResume is false ⇒
    // reconcileDanglingToolCalls never runs. Without the cold-branch route the
    // user answers a question and the answer is discarded before the first API
    // call, which is a worse version of the bug this path exists to fix.
    const sent = await runWithAnswer(undefined);
    expect(sent).toContain(ANSWER);
    expect(sent).toContain(QUESTION_ASKED);
  });
});

describe("reconcileDanglingToolCalls", () => {
  const asked = () => ([
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user", arguments: "{}" } }],
    },
  ]);

  it("fills the unanswered ask with the user's answer", async () => {
    const out = reconcileDanglingToolCalls(asked(), "use the second one");
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "q1", content: "use the second one" });
  });

  it("says plainly that no answer exists rather than inventing one", async () => {
    // The default arm. Fabricating an answer here would put words in the user's
    // mouth and the model would act on them as though they were instructions.
    const out = reconcileDanglingToolCalls(asked());
    expect(String((out[2] as { content?: string }).content)).toBe(UNANSWERED_ON_RESUME_REPLY);
    expect(String((out[2] as { content?: string }).content)).toContain("No answer is available");
  });

  it("treats an empty answer as no answer", async () => {
    const out = reconcileDanglingToolCalls(asked(), "");
    expect((out[2] as { content?: string }).content).toBe(UNANSWERED_ON_RESUME_REPLY);
  });

  it("repairs a run killed mid-tool-execution, not just a park", async () => {
    // Same shape, different cause: a process killed between issuing a tool call
    // and recording its result. Chat Completions rejects the whole request when
    // an assistant tool_call has no matching tool message, so without this the
    // resume dies at the API with an error that names none of this.
    const out = reconcileDanglingToolCalls([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "r1", type: "function", function: { name: "run_command", arguments: "{}" } }],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(String((out[1] as { content?: string }).content)).toContain("did not complete");
  });

  it("leaves a complete conversation exactly as it was", async () => {
    const complete = [
      { role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a1", content: "contents" },
    ];
    expect(reconcileDanglingToolCalls(complete)).toBe(complete);
  });

  it("passes existing messages through by reference", async () => {
    const msgs = asked();
    const out = reconcileDanglingToolCalls(msgs, "x");
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });
});

describe("resuming into the answer", () => {
  it("the answer becomes the reply to the parked tool_call, and nothing dangles", async () => {
    // The protocol assertion: after resume, every assistant tool_call in what we
    // send has a matching tool message. Without reconciliation the request is
    // malformed and the provider rejects all of it.
    mocks.createChatCompletion.mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "pick an auth module",
      repoPath,
      runId: "run-resumed",
      sessionId: "sess-resumed-0002",
      resumeMessages: [
        { role: "system", content: "old system" },
        { role: "user", content: "pick an auth module" },
        { role: "assistant", content: null, tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: QUESTION }) } }] },
      ],
      resumeAnswer: "src/auth/session.ts is canonical",
    });

    const sent = (mocks.createChatCompletion.mock.calls[0]![0] as {
      messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
    }).messages;

    const replied = new Set(sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const m of sent) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      for (const c of m.tool_calls as Array<{ id: string }>) {
        expect(replied.has(c.id), `tool_call ${c.id} has no reply`).toBe(true);
      }
    }
    expect(sent.some((m) => m.role === "tool" && m.content === "src/auth/session.ts is canonical")).toBe(true);
  });
});
