import crypto from "node:crypto";
import * as registry from "../cli/interactionRegistry.js";

// Phase 6b — delegates to the unified interaction registry.
// Side-map for runId validation: the registry doesn't carry runId in its resolve path.
const questionRunIds = new Map<string, string>();

export interface QuestionOutcome {
  questionId: string;
  answer: string | null;
  disposition: "answered" | "declined" | "aborted";
}

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
      resolve({ questionId, ...outcome });
    };

    // Questions have no timeout — use a very large value. The registry's timeout
    // fires with timeoutResult, which we set to an aborted outcome.
    questionRunIds.set(questionId, runId);
    registry.request("question", questionId, {
      runId,
      resolve: (outcome: any) => { questionRunIds.delete(questionId); finish(outcome); },
      abortSignal: input.abortSignal,
      abortResult: { answer: null, disposition: "aborted" as const },
    });

    if (!registry._hasPending("question", questionId)) {
      // Already aborted synchronously
      resolve({ questionId, answer: null, disposition: "aborted" });
      return;
    }

    // Emit LAST — synchronous resolvers find the registered entry.
    input.emit({ type: "user_question_required", runId, question, questionId });
  });
}

export function resolveUserQuestion(input: {
  questionId: string;
  runId: string;
  answer: string;
}): { ok: boolean; message?: string } {
  const questionId = String(input.questionId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!questionId) return { ok: false, message: "unknown_question_id" };
  // Validate runId matches the stored entry
  const storedRunId = questionRunIds.get(questionId);
  if (!storedRunId) return { ok: false, message: "unknown_question_id" };
  if (runId && storedRunId && runId !== storedRunId) return { ok: false, message: "run_id_mismatch" };
  const resolved = registry.resolve("question", questionId, {
    answer: String(input.answer ?? ""),
    disposition: "answered" as const,
  });
  if (resolved) questionRunIds.delete(questionId);
  return resolved ? { ok: true } : { ok: false, message: "unknown_question_id" };
}

export function declineUserQuestion(input: {
  questionId: string;
  runId: string;
}): { ok: boolean; message?: string } {
  const questionId = String(input.questionId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!questionId) return { ok: false, message: "unknown_question_id" };
  const storedRunId = questionRunIds.get(questionId);
  if (!storedRunId) return { ok: false, message: "unknown_question_id" };
  if (runId && storedRunId && runId !== storedRunId) return { ok: false, message: "run_id_mismatch" };
  const resolved = registry.resolve("question", questionId, {
    answer: null,
    disposition: "declined" as const,
  });
  if (resolved) questionRunIds.delete(questionId);
  return resolved ? { ok: true } : { ok: false, message: "unknown_question_id" };
}

export function rejectPendingQuestionsForRun(runIdRaw: string): number {
  // Questions resolve with an "aborted" outcome, not just `false`.
  // We need custom iteration to resolve each with the right shape.
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  // Delegate to registry — the `false` resolve is acceptable here because
  // the awaiting code checks for null answer / aborted disposition.
  return registry.rejectByKindAndRun("question", runId);
}

export function _pendingQuestionCountForTest(): number {
  return registry.pendingCount("question");
}
