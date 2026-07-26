/**
 * The ask_user park.
 *
 * The one structural difference from its sibling registries is the absence of a
 * timeout: a question has no safe default to expire into. That makes the abort
 * signal and the run-teardown sweep the only liveness guarantees, so both are
 * pinned here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestUserAnswer,
  resolveUserQuestion,
  declineUserQuestion,
  rejectPendingQuestionsForRun,
  _pendingQuestionCountForTest,
} from "./questionApprovals.js";

type Emitted = { type: string; runId: string; question: string; questionId: string };

afterEach(() => {
  rejectPendingQuestionsForRun("run-1");
  rejectPendingQuestionsForRun("run-2");
});

describe("requestUserAnswer", () => {
  it("parks until answered, then returns the answer", async () => {
    let captured: Emitted | null = null;
    const pending = requestUserAnswer({
      runId: "run-1",
      question: "Which auth module is canonical?",
      emit: (e) => { captured = e as Emitted; },
    });

    expect(captured).not.toBeNull();
    expect(captured!.question).toBe("Which auth module is canonical?");
    expect(_pendingQuestionCountForTest()).toBe(1);

    resolveUserQuestion({ questionId: captured!.questionId, runId: "run-1", answer: "src/auth/v2.ts" });

    const outcome = await pending;
    expect(outcome.answer).toBe("src/auth/v2.ts");
    expect(outcome.disposition).toBe("answered");
    expect(_pendingQuestionCountForTest()).toBe(0);
  });

  it("emits AFTER registering, so a synchronous resolver finds the entry", async () => {
    // The TUI bus dispatches synchronously. If emit ran before map registration a
    // re-entrant resolve would miss and the loop would park forever.
    const pending = requestUserAnswer({
      runId: "run-1",
      question: "q",
      emit: (e) => {
        const res = resolveUserQuestion({ questionId: e.questionId, runId: "run-1", answer: "inline" });
        expect(res.ok).toBe(true);
      },
    });
    expect((await pending).answer).toBe("inline");
  });

  it("has no timeout — it stays parked indefinitely", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = requestUserAnswer({ runId: "run-1", question: "q", emit: () => {} })
        .then((o) => { settled = true; return o; });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // an hour
      expect(settled).toBe(false);
      expect(_pendingQuestionCountForTest()).toBe(1);

      rejectPendingQuestionsForRun("run-1");
      expect((await pending).disposition).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a decline resolves with a null answer, distinguishable from an abort", async () => {
    let captured: Emitted | null = null;
    const pending = requestUserAnswer({
      runId: "run-1", question: "q", emit: (e) => { captured = e as Emitted; },
    });
    declineUserQuestion({ questionId: captured!.questionId, runId: "run-1" });

    const outcome = await pending;
    expect(outcome.answer).toBeNull();
    expect(outcome.disposition).toBe("declined");
  });

  it("an already-aborted signal resolves immediately rather than parking", async () => {
    const ac = new AbortController();
    ac.abort();
    const outcome = await requestUserAnswer({
      runId: "run-1", question: "q", emit: () => {}, abortSignal: ac.signal,
    });
    expect(outcome.disposition).toBe("aborted");
    expect(_pendingQuestionCountForTest()).toBe(0);
  });

  it("aborting mid-park resolves the parked promise", async () => {
    const ac = new AbortController();
    const pending = requestUserAnswer({
      runId: "run-1", question: "q", emit: () => {}, abortSignal: ac.signal,
    });
    expect(_pendingQuestionCountForTest()).toBe(1);
    ac.abort();
    expect((await pending).disposition).toBe("aborted");
    expect(_pendingQuestionCountForTest()).toBe(0);
  });
});

describe("resolver validation", () => {
  it("rejects an unknown id and a run mismatch without disturbing the entry", async () => {
    let captured: Emitted | null = null;
    const pending = requestUserAnswer({
      runId: "run-1", question: "q", emit: (e) => { captured = e as Emitted; },
    });

    expect(resolveUserQuestion({ questionId: "nope", runId: "run-1", answer: "x" }))
      .toEqual({ ok: false, message: "unknown_question_id" });
    expect(resolveUserQuestion({ questionId: captured!.questionId, runId: "run-2", answer: "x" }))
      .toEqual({ ok: false, message: "run_id_mismatch" });
    expect(_pendingQuestionCountForTest()).toBe(1);

    resolveUserQuestion({ questionId: captured!.questionId, runId: "run-1", answer: "ok" });
    expect((await pending).answer).toBe("ok");
  });
});

describe("rejectPendingQuestionsForRun", () => {
  it("drains only the matching run", async () => {
    const a = requestUserAnswer({ runId: "run-1", question: "a", emit: () => {} });
    const b = requestUserAnswer({ runId: "run-2", question: "b", emit: () => {} });
    expect(_pendingQuestionCountForTest()).toBe(2);

    expect(rejectPendingQuestionsForRun("run-1")).toBe(1);
    expect((await a).disposition).toBe("aborted");
    expect(_pendingQuestionCountForTest()).toBe(1);

    rejectPendingQuestionsForRun("run-2");
    await b;
    expect(_pendingQuestionCountForTest()).toBe(0);
  });

  it("is a no-op for an empty or unknown runId", () => {
    expect(rejectPendingQuestionsForRun("")).toBe(0);
    expect(rejectPendingQuestionsForRun("never-existed")).toBe(0);
  });
});
