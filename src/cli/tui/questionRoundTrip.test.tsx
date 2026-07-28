/**
 * The ask_user round trip through the TUI: a real park, resolved by real
 * keystrokes.
 *
 * Nothing here spies on the resolver. The loop-side promise returned by
 * requestUserAnswer is awaited directly, so each test proves the keystroke
 * actually unparked the agent rather than that a function was called.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import { createEventBus, type EventBus } from "../eventBus.js";
import {
  requestUserAnswer,
  _pendingQuestionCountForTest,
  type QuestionOutcome,
} from "../../api/questionApprovals.js";
import { reducer, buildInitialState, isRunInFlight, type StoreState } from "./store-core.js";

const RUN_ID = "test-run";

function wait(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parks a real question and pushes the event onto the bus, exactly as the loop does. */
function park(bus: EventBus, question = "Which auth module is canonical?"): Promise<QuestionOutcome> {
  return requestUserAnswer({
    runId: RUN_ID,
    question,
    emit: (evt) =>
      bus.emit("user_question_required", {
        ...evt,
        ts: Date.now(),
      } as unknown as import("../../core/agentLifecycleEvents.js").ZoneStructuredProgressEvent),
  });
}

let bus: EventBus;

beforeEach(() => {
  bus = createEventBus();
});

afterEach(() => {
  expect(_pendingQuestionCountForTest()).toBe(0);
});

// ── the reducer ──────────────────────────────────────────────────────────────

describe("reducer — awaiting_input and pendingQuestion", () => {
  function run(state: StoreState, ...actions: Parameters<typeof reducer>[1][]): StoreState {
    return actions.reduce(reducer, state);
  }

  it("parks into awaiting_input and drops the spinner", () => {
    // A spinner next to a question reads as "still working", i.e. "don't type".
    const s = run(
      buildInitialState({ model: "m", capUsd: 10 }),
      { type: "SPINNER_START", label: "Working" },
      { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "Which?" }
    );
    expect(s.runState).toBe("awaiting_input");
    expect(s.pendingQuestion).toEqual({
      kind: "live", questionId: "q1", runId: RUN_ID, question: "Which?",
    });
    expect(s.spinner).toBeNull();
  });

  it("resolving returns to running and echoes the answer into the transcript", () => {
    // The pinned panel goes away with the question, so without the echo there is
    // no record of what was agreed.
    const s = run(
      buildInitialState({ model: "m", capUsd: 10 }),
      { type: "SPINNER_START", label: "Working" },
      { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "Which?" },
      { type: "USER_QUESTION_RESOLVED", echo: "the second one" }
    );
    expect(s.runState).toBe("running");
    expect(s.pendingQuestion).toBeNull();
    expect(s.transcript.at(-1)).toEqual({ kind: "user_prompt", text: "the second one" });
  });

  it("a park does not restart the run timer — the wait is not inference time", () => {
    // SPINNER_START resets runStartMs when ENTERING a run. Parking leaves
    // "running", so a naive `=== "running"` guard treats the next spinner as a
    // brand new task and zeroes the elapsed clock.
    //
    // The clock is stubbed because reducer calls land in the same millisecond,
    // which made an earlier version of this test pass against a deliberately
    // broken guard.
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
    try {
      const started = run(
        buildInitialState({ model: "m", capUsd: 10 }),
        { type: "SPINNER_START", label: "Working" }
      );
      const startMs = started.runStartMs;
      expect(startMs).toBe(2_000);

      const afterPark = run(
        started,
        { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "Which?" },
        { type: "SPINNER_START", label: "Working" }
      );
      expect(afterPark.runStartMs).toBe(startMs);
      expect(isRunInFlight("awaiting_input")).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("parked time is banked and excluded from the reported duration", () => {
    // A run parked for an hour would otherwise report an hour of work. That
    // corrupts latency telemetry across exactly the boundary this feature
    // introduces — the same shape as the cost-log discontinuity the OpenAI
    // cache-write mapping created.
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      clock = 1_000;
      let s = reducer(buildInitialState({ model: "m", capUsd: 10 }), { type: "SPINNER_START", label: "W" });
      expect(s.runStartMs).toBe(1_000);

      clock = 3_000; // 2s of real work before the question
      s = reducer(s, { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "Which?" });

      clock = 63_000; // the human took a minute
      s = reducer(s, { type: "USER_QUESTION_RESOLVED", echo: "this one" });
      expect(s.parkedMs).toBe(60_000);

      clock = 65_000; // 2s more work, then done
      s = reducer(s, { type: "RUN_DONE" });

      const wallClock = s.runEndMs! - s.runStartMs!;
      expect(wallClock).toBe(64_000);
      // What the user is shown: 4s of work, not 64s.
      expect(wallClock - s.parkedMs).toBe(4_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("two parks in one run both count", () => {
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      clock = 1_000;
      let s = reducer(buildInitialState({ model: "m", capUsd: 10 }), { type: "SPINNER_START", label: "W" });
      for (const [askAt, answerAt] of [[2_000, 12_000], [20_000, 25_000]]) {
        clock = askAt;
        s = reducer(s, { type: "USER_QUESTION_ASKED", questionId: "q", runId: RUN_ID, question: "?" });
        clock = answerAt;
        s = reducer(s, { type: "USER_QUESTION_RESOLVED" });
      }
      expect(s.parkedMs).toBe(15_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a new run starts its parked accumulator at zero", () => {
    // Otherwise the previous run's wait is deducted from the next run's work and
    // the duration reads as faster than it was.
    let s = reducer(buildInitialState({ model: "m", capUsd: 10 }), { type: "SPINNER_START", label: "W" });
    s = reducer(s, { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "?" });
    s = reducer(s, { type: "USER_QUESTION_RESOLVED" });
    s = reducer(s, { type: "RUN_DONE" });
    expect(s.parkedMs).toBeGreaterThanOrEqual(0);
    const next = reducer(s, { type: "SPINNER_START", label: "W" });
    expect(next.parkedMs).toBe(0);
  });

  it("a run that ends while parked clears the question", () => {
    // Otherwise the pinned panel outlives the run it belongs to and the next
    // keystroke resolves a question nobody is waiting on.
    for (const term of ["RUN_DONE", "RUN_ABORTED", "RUN_FAILED"] as const) {
      const s = run(
        buildInitialState({ model: "m", capUsd: 10 }),
        { type: "USER_QUESTION_ASKED", questionId: "q1", runId: RUN_ID, question: "Which?" },
        { type: term }
      );
      expect(s.pendingQuestion, term).toBeNull();
    }
  });
});

// ── the round trip ───────────────────────────────────────────────────────────

describe("answering", () => {
  it("a typed answer unparks the loop without starting a new task", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<App bus={bus} onSubmit={onSubmit} />);

    const parked = park(bus);
    await wait();

    // Pinned, not in the transcript — the transcript is <Static> and would
    // scroll the question away while the user is still deciding.
    expect(lastFrame()).toContain("Which auth module is canonical?");
    expect(lastFrame()).toContain("waiting for you");
    expect(lastFrame()).toContain("esc skip question");

    stdin.write("the second one");
    await wait();
    stdin.write("\r");

    const outcome = await parked;
    expect(outcome).toMatchObject({ answer: "the second one", disposition: "answered" });

    await wait();
    // The answer is not a new task: onSubmit would mint a fresh runId and a fresh
    // AbortController, orphaning the run that asked.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain("Which auth module is canonical?");
    unmount();
  });

  it("Esc declines without killing the run", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<App bus={bus} onSubmit={onSubmit} />);

    const parked = park(bus);
    await wait();
    expect(lastFrame()).toContain("Which auth module is canonical?");

    stdin.write("\x1B"); // Esc

    const outcome = await parked;
    // Declined, not aborted: the loop is parked awaiting a tool_result and needs
    // an instruction back, and the distinction is what user_declined telemetry
    // counts.
    expect(outcome).toMatchObject({ answer: null, disposition: "declined" });

    await wait();
    expect(lastFrame()).not.toContain("Which auth module is canonical?");
    // Still the same run — Esc here skipped the question, it did not abort.
    expect(lastFrame()).not.toContain("aborted");
    unmount();
  });

  it("Enter on an empty buffer is not an answer", async () => {
    const { stdin, lastFrame, unmount } = render(<App bus={bus} />);
    const parked = park(bus);
    await wait();

    stdin.write("\r");
    await wait();
    expect(lastFrame()).toContain("Which auth module is canonical?");

    stdin.write("vitest");
    await wait();
    stdin.write("\r");
    await expect(parked).resolves.toMatchObject({ answer: "vitest" });
    unmount();
  });
});

// ── carried over from a previous process ─────────────────────────────────────

describe("a question carried across the turn boundary", () => {
  const carried = {
    kind: "carried" as const,
    question: "Which auth module is canonical?",
    toolCallId: "t2",
    runId: "run-that-asked",
    iter: 3,
    conversationLost: false,
  };

  it("renders marked as carried over, and the session opens waiting on the user", () => {
    const s = buildInitialState({ model: "m", capUsd: 10, carriedQuestion: carried });
    expect(s.pendingQuestion).toEqual(carried);
    // Not "idle": a question with an idle status line reads as nobody waiting.
    expect(s.runState).toBe("awaiting_input");
  });

  it("an answer starts the resumed run instead of resolving a registry entry", async () => {
    // The registry did not survive the process, so resolveUserQuestion would
    // return unknown_question_id and swallow the answer. This is the assertion
    // that the carried path takes the other branch.
    const onSubmit = vi.fn();
    const onCarriedAnswer = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <App bus={bus} onSubmit={onSubmit} onCarriedAnswer={onCarriedAnswer} initialCarriedQuestion={carried} />
    );
    await wait();

    expect(lastFrame()).toContain("Which auth module is canonical?");
    expect(lastFrame()).toContain("carried over from the previous turn");
    expect(lastFrame()).toContain("esc set aside");

    stdin.write("src/auth/session.ts");
    await wait();
    stdin.write("\r");
    await wait();

    expect(onCarriedAnswer).toHaveBeenCalledTimes(1);
    expect(onCarriedAnswer.mock.calls[0]![0]).toBe("src/auth/session.ts");
    // Not a new task: that would start a fresh run and abandon the conversation.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain("Which auth module is canonical?");
    unmount();
  });

  it("says the conversation was lost BEFORE the user answers", async () => {
    // Both flags can be true at once. Finding out afterwards that the agent
    // cannot see the conversation you just answered about is a worse version of
    // losing the question in the first place.
    const { lastFrame, unmount } = render(
      <App bus={bus} initialCarriedQuestion={{ ...carried, conversationLost: true }} />
    );
    await wait();
    expect(lastFrame()).toContain("too large to save");
    unmount();
  });
});

// ── the slash ambiguity ──────────────────────────────────────────────────────

describe("slash input at a pending question", () => {
  it("a known command executes as a command and leaves the question pending", async () => {
    const { stdin, lastFrame, unmount } = render(<App bus={bus} />);
    const parked = park(bus);
    await wait();

    stdin.write("/help");
    await wait();
    stdin.write("\r");
    await wait();

    // The command ran; the question is still waiting for a real answer.
    expect(lastFrame()).toContain("Which auth module is canonical?");

    stdin.write("answered at last");
    await wait();
    stdin.write("\r");
    await expect(parked).resolves.toMatchObject({ answer: "answered at last" });
    unmount();
  });

  it("a leading slash that matches nothing is the answer", async () => {
    // The fallthrough case. Treating unmatched slash text as a failed command
    // would silently swallow an answer the user believes they gave.
    const { stdin, unmount } = render(<App bus={bus} />);
    const parked = park(bus, "Which flag?");
    await wait();

    stdin.write("/nosuchcommand-use-this-flag");
    await wait();
    stdin.write("\r");

    await expect(parked).resolves.toMatchObject({
      answer: "/nosuchcommand-use-this-flag",
      disposition: "answered",
    });
    unmount();
  });
});
