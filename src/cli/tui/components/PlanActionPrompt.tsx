import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolvePlanApproval } from "../../../llm/planApprovals.js";
import { role, glyph } from "../theme.js";

interface PlanActionPromptProps {
  proposal: NonNullable<StoreState["planReadyProposal"]>;
  dispatch: Dispatch<StoreAction>;
}

function renderFeedbackBuffer(buf: string, pos: number): string {
  return buf.slice(0, pos) + glyph.cursor + buf.slice(pos);
}

// Phase 2e — conditionally mounted by App.tsx (only when planReadyProposal is non-null).
// No self-gating needed: the component is either fully mounted (hooks active) or absent.
export function PlanActionPrompt({ proposal, dispatch }: PlanActionPromptProps): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<"feedback" | "approve_with_feedback" | null>(null);
  const [feedbackBuffer, setFeedbackBuffer] = useState("");
  const [feedbackCursor, setFeedbackCursor] = useState(0);

  useInput((input, key) => {
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
    if (!feedbackMode) return;
    setFeedbackBuffer(feedbackBuffer.slice(0, feedbackCursor) + text + feedbackBuffer.slice(feedbackCursor));
    setFeedbackCursor(feedbackCursor + text.length);
  }, { isActive: true });

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
          <Box borderStyle="single" borderColor={role.accent}>
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
