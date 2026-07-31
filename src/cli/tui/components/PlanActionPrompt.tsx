import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolvePlanApproval } from "../../../llm/planApprovals.js";

interface PlanActionPromptProps {
  proposal: StoreState["planReadyProposal"];
  dispatch: Dispatch<StoreAction>;
}

function renderFeedbackBuffer(buf: string, pos: number): string {
  return buf.slice(0, pos) + "▋" + buf.slice(pos);
}

// Always mounted (App.tsx renders it unconditionally, replacing the old
// conditional-mount PlanReadyModal) — self-gated by `proposal` nullness inside
// the useInput/usePaste callbacks, exactly the way Composer already self-gates
// on state.modalView. Hooks are called unconditionally every render regardless
// of proposal; only the early-return inside each callback, and the final JSX
// return, are conditioned on proposal === null. This avoids a rules-of-hooks
// violation from a prop that toggles between null and non-null across renders.
export function PlanActionPrompt({ proposal, dispatch }: PlanActionPromptProps): React.ReactElement | null {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<"feedback" | "approve_with_feedback" | null>(null);
  const [feedbackBuffer, setFeedbackBuffer] = useState("");
  const [feedbackCursor, setFeedbackCursor] = useState(0);

  useInput((input, key) => {
    if (proposal === null) return;

    if (feedbackMode) {
      if (key.return && feedbackBuffer.trim()) {
        resolvePlanApproval({
          planId: proposal.planId,
          runId: proposal.runId,
          decision: pendingDecision!,
          feedback: feedbackBuffer.trim(),
        });
        dispatch({ type: "PLAN_READY_RESOLVED" });
        return;
      }
      if (key.escape) {
        setFeedbackMode(false);
        setPendingDecision(null);
        setFeedbackBuffer("");
        setFeedbackCursor(0);
        return;
      }
      if (key.backspace || key.delete) {
        if (feedbackCursor > 0) {
          setFeedbackBuffer(b => b.slice(0, feedbackCursor - 1) + b.slice(feedbackCursor));
          setFeedbackCursor(c => c - 1);
        }
        return;
      }
      if (key.leftArrow)  { setFeedbackCursor(c => Math.max(0, c - 1)); return; }
      if (key.rightArrow) { setFeedbackCursor(c => Math.min(feedbackBuffer.length, c + 1)); return; }
      if (input && !key.ctrl && !key.meta) {
        setFeedbackBuffer(b => b.slice(0, feedbackCursor) + input + b.slice(feedbackCursor));
        setFeedbackCursor(c => c + 1);
      }
      return;
    }

    // Normal mode
    if (input === "1") {
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "accept_all" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      return;
    }
    if (input === "2") {
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "manual" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      return;
    }
    if (input === "3") {
      setFeedbackMode(true);
      setPendingDecision("feedback");
      return;
    }
    if (input === "4") {
      setFeedbackMode(true);
      setPendingDecision("approve_with_feedback");
      return;
    }
    if (key.escape) {
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "reject" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      dispatch({ type: "RUN_ABORTED" });
      return;
    }
  });

  usePaste((text) => {
    if (proposal === null || !feedbackMode) return;
    setFeedbackBuffer(feedbackBuffer.slice(0, feedbackCursor) + text + feedbackBuffer.slice(feedbackCursor));
    setFeedbackCursor(feedbackCursor + text.length);
  }, { isActive: true });

  if (proposal === null) return null;

  return (
    <Box flexDirection="column">
      {feedbackMode ? (
        <>
          <Text dimColor>
            {pendingDecision === "approve_with_feedback"
              ? "Feedback (then run):"
              : proposal.answerOnlyReason
                ? "Feedback (then plan a fix):"
                : "Feedback (then revise):"}
          </Text>
          <Box borderStyle="single" borderColor="cyan">
            <Text>{renderFeedbackBuffer(feedbackBuffer, feedbackCursor)}</Text>
          </Box>
          <Text dimColor>{"Enter to submit  ·  Esc to cancel"}</Text>
        </>
      ) : (
        <Text dimColor>
          {proposal.answerOnlyReason
            ? "[1] answer now (read-only)  ·  [3] plan a fix instead  ·  Esc cancel"
            : "[1] auto-accept all  ·  [2] manually approve changes  ·  [3] give feedback  ·  [4] feedback+run  ·  Esc cancel"}
        </Text>
      )}
    </Box>
  );
}
