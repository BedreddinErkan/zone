import crypto from "node:crypto";

/**
 * Park registry for `ask_user` — the agent loop suspends here until a human
 * answers, declines, or the run aborts.
 *
 * Cloned from editApprovals with ONE deliberate difference: there is no timeout.
 * The other registries auto-deny after 5–10 minutes because a stalled approval
 * should fail safe. A question has no safe default — expiring it would either
 * invent an answer or kill a run the user is still thinking about. Liveness comes
 * from the abort signal and from rejectPendingQuestionsForRun instead.
 *
 * The consequence, and why the caller-side channel check is an allowlist: any path
 * that reaches this module without a human parks forever. This module cannot tell
 * who is calling it, so it must never be reached speculatively.
 */

/** What the parked loop receives back. `answer` is null when the user declined. */
export interface QuestionOutcome {
  questionId: string;
  answer: string | null;
  /** Distinguishes a user decline from a run teardown, for telemetry. */
  disposition: "answered" | "declined" | "aborted";
}

type PendingQuestion = {
  runId: string;
  question: string;
  resolve: (outcome: Omit<QuestionOutcome, "questionId">) => void;
};

const pendingQuestions = new Map<string, PendingQuestion>();

export function requestUserAnswer(input: {
  runId: string;
  question: string;
  emit: (evt: {
    type: "user_question_required";
    runId: string;
    question: string;
    questionId: string;
  }) => void;
  abortSignal?: AbortSignal;
}): Promise<QuestionOutcome> {
  const runId = String(input.runId || "").trim();
  const question = String(input.question || "");
  const questionId = crypto.randomUUID();

  return new Promise((resolve) => {
    const finish = (outcome: Omit<QuestionOutcome, "questionId">): void => {
      if (pendingQuestions.has(questionId)) pendingQuestions.delete(questionId);
      resolve({ questionId, ...outcome });
    };

    pendingQuestions.set(questionId, { runId, question, resolve: finish });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        finish({ answer: null, disposition: "aborted" });
        return;
      }
      const onAbort = (): void => {
        try { input.abortSignal?.removeEventListener("abort", onAbort); } catch {}
        finish({ answer: null, disposition: "aborted" });
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

    // Emit LAST — the TUI bus is synchronous, so a resolver invoked re-entrantly
    // inside emit must find the entry already registered.
    input.emit({ type: "user_question_required", runId, question, questionId });
  });
}

/** The user typed an answer. */
export function resolveUserQuestion(input: {
  questionId: string;
  runId: string;
  answer: string;
}): { ok: boolean; message?: string } {
  const questionId = String(input.questionId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingQuestions.get(questionId);
  if (!entry) return { ok: false, message: "unknown_question_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve({ answer: String(input.answer ?? ""), disposition: "answered" });
  return { ok: true };
}

/** The user dismissed the question (Esc). The run continues — see the declined
 *  payload the loop pushes as the tool_result. */
export function declineUserQuestion(input: {
  questionId: string;
  runId: string;
}): { ok: boolean; message?: string } {
  const questionId = String(input.questionId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingQuestions.get(questionId);
  if (!entry) return { ok: false, message: "unknown_question_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve({ answer: null, disposition: "declined" });
  return { ok: true };
}

/** Run teardown — the seventh sibling of the rejectPending*ForRun family. */
export function rejectPendingQuestionsForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [questionId, entry] of Array.from(pendingQuestions.entries())) {
    if (entry.runId === runId) {
      n++;
      try { entry.resolve({ answer: null, disposition: "aborted" }); } catch {}
      pendingQuestions.delete(questionId);
    }
  }
  return n;
}

/** Test-only: assert the registry does not leak entries across cases. */
export function _pendingQuestionCountForTest(): number {
  return pendingQuestions.size;
}
