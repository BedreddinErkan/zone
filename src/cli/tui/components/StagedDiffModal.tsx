import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolveStagedApproval } from "../../../api/stagedApprovals.js";
import { DiffView } from "./DiffView.js";
import { role, glyph } from "../theme.js";

interface StagedDiffModalProps {
  proposal: NonNullable<StoreState["stagedDiffProposal"]>;
  dispatch: Dispatch<StoreAction>;
}

function renderFeedbackBuffer(buf: string, pos: number): string {
  return buf.slice(0, pos) + glyph.cursor + buf.slice(pos);
}

export function StagedDiffModal({ proposal, dispatch }: StagedDiffModalProps): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackBuffer, setFeedbackBuffer] = useState("");
  const [feedbackCursor, setFeedbackCursor] = useState(0);

  useInput((input, key) => {
    if (feedbackMode) {
      if (key.return && feedbackBuffer.trim()) {
        resolveStagedApproval({
          approvalId: proposal.approvalId,
          runId: proposal.runId,
          decision: "refine",
          feedback: feedbackBuffer.trim(),
        });
        dispatch({ type: "STAGED_DIFFS_RESOLVED" });
        return;
      }
      if (key.escape) {
        setFeedbackMode(false);
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
      resolveStagedApproval({ approvalId: proposal.approvalId, runId: proposal.runId, decision: "approve_all" });
      dispatch({ type: "STAGED_DIFFS_RESOLVED" });
      return;
    }
    if (input === "2") {
      resolveStagedApproval({ approvalId: proposal.approvalId, runId: proposal.runId, decision: "manual" });
      dispatch({ type: "STAGED_DIFFS_RESOLVED" });
      return;
    }
    if (input === "3") {
      setFeedbackMode(true);
      return;
    }
    if (key.escape) {
      resolveStagedApproval({ approvalId: proposal.approvalId, runId: proposal.runId, decision: "reject" });
      dispatch({ type: "STAGED_DIFFS_RESOLVED" });
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
    <Box flexDirection="column" borderStyle="double" borderColor={role.accent} paddingX={2} paddingY={1}>
      <Text bold color={role.accent}>Review staged changes</Text>
      <Text dimColor>
        {proposal.trigger === "natural_completion" ? "Task complete" : "Iteration limit reached"}
        {" · "}{proposal.verificationSummary}
      </Text>
      <Text> </Text>
      {proposal.files.map((f, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Text bold>{f.path}</Text>
            <Text dimColor>{`  +${f.added}  −${f.removed}`}</Text>
          </Box>
          <DiffView patch={f.findReplace} />
        </Box>
      ))}
      <Text> </Text>
      {feedbackMode ? (
        <>
          <Text dimColor>{"Refine (describe changes):"}</Text>
          <Box borderStyle="single" borderColor={role.accent}>
            <Text>{renderFeedbackBuffer(feedbackBuffer, feedbackCursor)}</Text>
          </Box>
          <Text dimColor>{"Enter to submit  ·  Esc to cancel"}</Text>
        </>
      ) : (
        <Text dimColor>{"[1] apply all  ·  [2] approve per-file  ·  [3] refine  ·  Esc reject"}</Text>
      )}
    </Box>
  );
}
