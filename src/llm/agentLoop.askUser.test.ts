/**
 * ask_user: the park, and the discipline around it.
 *
 * The cap is enforced by refusing the second call rather than hiding the tool,
 * specifically so a refused attempt stays measurable. That only pays off if the
 * four refusal reasons stay distinct — cap_exceeded, pre_investigation,
 * no_channel and user_declined indict completely different things — so each is
 * asserted separately here. An undifferentiated counter is the failure this
 * file guards against.
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

import { runAgentLoop, MAX_ASK_USER_PER_RUN } from "./agentLoop.js";
import {
  resolveUserQuestion,
  declineUserQuestion,
  _pendingQuestionCountForTest,
} from "../api/questionApprovals.js";

// ── response builders ────────────────────────────────────────────────────────

function toolCallResponse(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const askCall = (id: string, question = "Which auth module is canonical?") =>
  toolCallResponse(id, "ask_user", { question });

const readCall = (id: string, filePath = "src/a.ts") =>
  toolCallResponse(id, "read_file", { filePath, lineRange: null });

const doneResponse = (text = "done [ZONE_VERIFICATION: tests_skipped_no_infra]") => ({
  choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

// ── observation helpers ──────────────────────────────────────────────────────

/** The role:"tool" replies the loop pushed — i.e. what the model is told. */
function toolReplies(): string[] {
  const out: string[] = [];
  for (const call of mocks.createChatCompletion.mock.calls) {
    const messages = (call[0] as { messages?: Array<{ role: string; content?: unknown }> })
      ?.messages ?? [];
    for (const m of messages) {
      if (m.role === "tool" && typeof m.content === "string") out.push(m.content);
    }
  }
  return out;
}

let logSpy: ReturnType<typeof vi.spyOn>;

/** Telemetry is `log(marker, jsonString)`, and log is console.log. */
function markers(marker: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .filter((c) => c[0] === marker)
    .map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);
}

const refusals = () => markers("[zone-ask-user-refused]");
const asks = () => markers("[zone-ask-user]");
const reasons = () => refusals().map((r) => r.reason);

/**
 * Answers every question the loop parks on. The emit is synchronous inside the
 * park's promise executor, so resolving from the handler exercises exactly the
 * re-entrancy the registry orders its map-write before its emit to survive.
 */
function autoRespond(
  runId: string,
  respond: (questionId: string, index: number) => void
): (evt: unknown) => void {
  let index = 0;
  return (evt: unknown) => {
    const e = evt as { type?: string; questionId?: string; runId?: string };
    if (e?.type !== "user_question_required") return;
    expect(e.runId).toBe(runId);
    respond(String(e.questionId), index++);
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-ask-user-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file contents" });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── the allowlist ────────────────────────────────────────────────────────────

describe("the channel allowlist — only a declared TUI may park", () => {
  it("refuses with no_channel when the caller declares nothing", async () => {
    // The park has no timeout, so a caller with no human behind it would wait
    // forever. Absent channel must refuse rather than park: this is the assertion
    // that the predicate is an allowlist and not "if not headless, park".
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2"))
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({ task: "t", repoPath, runId: "run-nochannel" });

    expect(reasons()).toEqual(["no_channel"]);
    expect(refusals()[0].detail).toBe("none");
    expect(toolReplies().some((r) => r.includes("No interactive channel"))).toBe(true);
    expect(asks()).toHaveLength(0);
    expect(result.askCount).toBe(0);
  });

  it("refuses an unrecognised channel — a new caller does not inherit the park", async () => {
    // The next channel added (remote) is byte-identical to the TUI at this
    // boundary. It must arrive by adding itself to the allowlist, not by
    // defaulting into it.
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2"))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-unknown",
      // Deliberately not "tui" — stands in for a future/unknown entry point.
      interactiveChannel: "remote" as unknown as "tui",
    });

    expect(reasons()).toEqual(["no_channel"]);
    expect(refusals()[0].detail).toBe("remote");
    expect(_pendingQuestionCountForTest()).toBe(0);
  });

  it("refuses for a subagent even though the parent declared a channel", async () => {
    // A subagent's question would surface with no context for the user to answer
    // it, and the parent owns the conversation.
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2"))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-sub",
      interactiveChannel: "tui",
      subagent: { id: "s1", type: "worker", parentRunId: "run-parent" },
    });

    expect(reasons()).toEqual(["no_channel"]);
    expect(refusals()[0].detail).toBe("subagent");
  });
});

// ── the pre-investigation gate ───────────────────────────────────────────────

describe("the pre-investigation gate", () => {
  it("refuses an ask before any tool call, and does not consume the cap", async () => {
    // Asking before looking is the laziest failure mode. The refusal has to be
    // free — spending the single question on a procedural rejection would punish
    // the model for a mistake it can still correct in the same run.
    mocks.createChatCompletion
      .mockResolvedValueOnce(askCall("t1", "What should I do?")) // too early
      .mockResolvedValueOnce(readCall("t2")) // now it looks
      .mockResolvedValueOnce(askCall("t3", "Which of the two targets?")) // earned
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-early",
      interactiveChannel: "tui",
      onStructuredEvent: autoRespond("run-early", (questionId) => {
        resolveUserQuestion({ questionId, runId: "run-early", answer: "the second one" });
      }),
    });

    expect(reasons()).toEqual(["pre_investigation"]);
    expect(
      toolReplies().some((r) => r.includes("does not count against your one question"))
    ).toBe(true);
    // The cap survived the rejection: the later, earned ask still reached a human.
    expect(asks()).toHaveLength(1);
    expect(result.askCount).toBe(1);
    expect(toolReplies()).toContain("the second one");
  });
});

// ── the cap ──────────────────────────────────────────────────────────────────

describe("the cap", () => {
  it("is one", () => {
    expect(MAX_ASK_USER_PER_RUN).toBe(1);
  });

  it("refuses the second ask with cap_exceeded rather than removing the tool", async () => {
    // Removal would make the attempt invisible, and we could no longer tell
    // whether the cap is right or merely unreachable. The refusal is a
    // tool_result, which is Pattern A and leaves the tool schema cache intact.
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2", "Which module?"))
      .mockResolvedValueOnce(askCall("t3", "And which test runner?"))
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-cap",
      interactiveChannel: "tui",
      onStructuredEvent: autoRespond("run-cap", (questionId) => {
        resolveUserQuestion({ questionId, runId: "run-cap", answer: "the first one" });
      }),
    });

    expect(asks()).toHaveLength(1); // only the first reached a human
    expect(reasons()).toEqual(["cap_exceeded"]);
    expect(toolReplies().some((r) => r.includes("Question budget exhausted"))).toBe(true);
    expect(result.askCount).toBe(1);
  });
});

// ── decline ──────────────────────────────────────────────────────────────────

describe("a declined question", () => {
  it("returns the declined payload, and refunds the cap", async () => {
    // The user cancelled; the model asked in good faith. Charging it would mean a
    // stray Esc silently costs the run its only question.
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2", "Which module?"))
      .mockResolvedValueOnce(askCall("t3", "Then which test runner?"))
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-decline",
      interactiveChannel: "tui",
      onStructuredEvent: autoRespond("run-decline", (questionId, index) => {
        if (index === 0) declineUserQuestion({ questionId, runId: "run-decline" });
        else resolveUserQuestion({ questionId, runId: "run-decline", answer: "vitest" });
      }),
    });

    expect(reasons()).toEqual(["user_declined"]);
    const declinedReply = toolReplies().find((r) => r.includes("The user declined to answer"));
    expect(declinedReply).toBeDefined();
    // The loop is parked awaiting a tool_result, so the decline must return a
    // usable instruction, not an error.
    expect(declinedReply).toContain("Do not ask this question again");
    // Refunded: the second ask parked instead of hitting the cap.
    expect(asks()).toHaveLength(2);
    expect(result.askCount).toBe(1);
  });
});

// ── teardown liveness ────────────────────────────────────────────────────────

describe("run teardown", () => {
  it("an aborted run unparks with a cancellation reply and leaves no pending entry", async () => {
    const ac = new AbortController();
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2"))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-abort",
      interactiveChannel: "tui",
      abortSignal: ac.signal,
      onStructuredEvent: autoRespond("run-abort", () => ac.abort()),
    }).catch(() => {
      /* abort may surface as a rejection; the registry assertion is the point */
    });

    expect(_pendingQuestionCountForTest()).toBe(0);
    // No refusal reason: an abort is teardown, not a judgement about the ask.
    expect(reasons()).toEqual([]);
  });
});

// ── invalid input ────────────────────────────────────────────────────────────

describe("a malformed ask", () => {
  it("is rejected before the channel check, so it cannot be read as a plumbing gap", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(toolCallResponse("t2", "ask_user", { question: "   " }))
      .mockResolvedValueOnce(doneResponse());

    await runAgentLoop({ task: "t", repoPath, runId: "run-empty", interactiveChannel: "tui" });

    expect(toolReplies().some((r) => r.includes("must be a non-empty string"))).toBe(true);
    expect(refusals()).toHaveLength(0);
    expect(asks()).toHaveLength(0);
  });
});

// ── longitudinal signal ──────────────────────────────────────────────────────

describe("the end-of-run line", () => {
  it("carries askCount and parkedMs so asks/run is measurable next to finalIter", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(readCall("t1"))
      .mockResolvedValueOnce(askCall("t2"))
      .mockResolvedValueOnce(doneResponse());

    const result = await runAgentLoop({
      task: "t",
      repoPath,
      runId: "run-telemetry",
      interactiveChannel: "tui",
      onStructuredEvent: autoRespond("run-telemetry", (questionId) => {
        resolveUserQuestion({ questionId, runId: "run-telemetry", answer: "yes" });
      }),
    });

    const [archetype] = markers("[zone-archetype]");
    expect(archetype.askCount).toBe(1);
    expect(typeof archetype.parkedMs).toBe("number");
    expect(result.parkedMs).toBeGreaterThanOrEqual(0);

    // The ask itself is dimensioned: a late ask (files already written) is a
    // different pathology from a lazy one, and the two must stay separable.
    const [ask] = asks();
    expect(ask).toMatchObject({
      event: "ask_user",
      runId: "run-telemetry",
      hadWrittenFiles: false,
    });
    expect(typeof ask.iter).toBe("number");
    expect(ask.questionChars).toBeGreaterThan(0);
  });
});
