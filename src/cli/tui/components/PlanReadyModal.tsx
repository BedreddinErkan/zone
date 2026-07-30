import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolvePlanApproval } from "../../../llm/planApprovals.js";

interface PlanReadyModalProps {
  proposal: NonNullable<StoreState["planReadyProposal"]>;
  dispatch: Dispatch<StoreAction>;
}

// Shared by both the slice and its length comparison so the two can't drift —
// a bound duplicated across them is one guard with two failure modes: it can
// hide content silently (comparison bumped, slice not), or claim truncation
// that never happened (comparison stuck low, or mutated true, while the slice
// is fine).
const SCOPE_SUMMARY_MAX = 200;
const RISK_HINT_MAX = 120;    // per-entry char cap
const RISK_HINTS_LIMIT = 5;   // entry-count cap
const FILES_LIKELY_MAX = 10;  // per-step file-list cap
const STEPS_MAX = 8;          // step-list cap
const STEP_DESCRIPTION_MAX = 48; // per-step description char cap

function renderFeedbackBuffer(buf: string, pos: number): string {
  return buf.slice(0, pos) + "▋" + buf.slice(pos);
}

// Greedy word-wrap line counter, matching Ink's default textWrap="wrap"
// (word-boundary breaks, not character-boundary — a word straddling the
// width is pushed whole to the next line). `\n` is a hard break, split
// first; an empty segment between two `\n`s is still a blank row Ink
// renders (a wholly empty string is the one case that renders as zero
// rows — that's `estimateWrappedLines`'s own early return, not this one).
export function estimateWrappedLines(text: string, width: number): number {
  if (text.length === 0) return 0;
  return text.split("\n").reduce((total, segment) => total + estimateSegmentLines(segment, width), 0);
}

function estimateSegmentLines(segment: string, width: number): number {
  if (segment.length === 0) return 1;
  let lines = 1;
  let lineLen = 0;
  for (const word of segment.split(" ")) {
    if (word.length > width) {
      if (lineLen > 0) lines += 1;
      lines += Math.ceil(word.length / width) - 1;
      lineLen = word.length % width || width;
      continue;
    }
    const nextLen = lineLen === 0 ? word.length : lineLen + 1 + word.length;
    if (nextLen > width) {
      lines += 1;
      lineLen = word.length;
    } else {
      lineLen = nextLen;
    }
  }
  return lines;
}

// Magnitudes, not membership — riskHintsShown/filesLikelyShown/stepsShown/
// descriptionsShown each start at their field's existing cap and only ever
// decrease, so a future budget walk can narrow them one step at a time
// instead of jumping straight to zero. dropSummary stays boolean: scopeSummary
// is one field and presence is the whole decision, nothing to make numeric.
export interface CutState {
  descriptionsShown: number;
  dropSummary: boolean;
  riskHintsShown: number;
  filesLikelyShown: number;
  stepsShown: number;
}

export const NO_CUTS: CutState = {
  descriptionsShown: STEPS_MAX,
  dropSummary: false,
  riskHintsShown: RISK_HINTS_LIMIT,
  filesLikelyShown: FILES_LIKELY_MAX,
  stepsShown: STEPS_MAX,
};

/**
 * Total content-line count for exactly what would render under a given cut
 * state, at a given terminal width — everything in PlanReadyModal's frame
 * EXCEPT chrome (borders, paddingY, the always-on "Ready to code?"/
 * "Objective:" labels and their surrounding spacers) and the footer, which
 * don't vary with proposal content and are measured separately.
 *
 * Not wired into the component's render yet — `NO_CUTS` is the only value
 * passed to it this pass.
 */
export function estimatePlanContentLines(
  proposal: PlanReadyModalProps["proposal"],
  columns: number,
  cutState: CutState,
): number {
  const contentWidth = columns - 6;        // border(2) + paddingX(4)
  const indentedWidth = contentWidth - 5;  // marginLeft=5 / row-sibling prefix width

  let lines = estimateWrappedLines(proposal.objective.slice(0, 200), contentWidth);

  if (!cutState.dropSummary && proposal.scopeSummary) {
    const summaryText = `${proposal.scopeSummary.slice(0, SCOPE_SUMMARY_MAX)}${proposal.scopeSummary.length > SCOPE_SUMMARY_MAX ? "…" : ""}`;
    lines += 2 + estimateWrappedLines(summaryText, contentWidth); // spacer + label
  }

  if (proposal.noChangeReason || proposal.cannotVerifyReason) {
    const reasonText = (proposal.noChangeReason ?? proposal.cannotVerifyReason ?? "").slice(0, 200);
    lines += 2 + estimateWrappedLines(reasonText, contentWidth); // label + marginBottom
  }

  const stepsShown = Math.min(proposal.steps.length, cutState.stepsShown);
  for (let i = 0; i < stepsShown; i++) {
    const step = proposal.steps[i];
    lines += estimateWrappedLines(step.title, indentedWidth);
    if (step.description && i < cutState.descriptionsShown) {
      const descText = `${step.description.slice(0, STEP_DESCRIPTION_MAX)}${step.description.length > STEP_DESCRIPTION_MAX ? "…" : ""}`;
      lines += estimateWrappedLines(descText, indentedWidth);
    }
    if (step.filesLikely.length > 0 && cutState.filesLikelyShown > 0) {
      const filesText = `(${step.filesLikely.slice(0, cutState.filesLikelyShown).join(", ")})`;
      lines += estimateWrappedLines(filesText, indentedWidth);
    }
    if (step.filesLikely.length > cutState.filesLikelyShown) {
      lines += 1; // "+N more file(s)"
    }
  }
  if (proposal.steps.length > cutState.stepsShown) {
    lines += 1; // "+N more step(s)"
  }

  if (proposal.riskHints.length > 0) {
    lines += 2; // spacer + "Risks:" label
    for (const hint of proposal.riskHints.slice(0, cutState.riskHintsShown)) {
      const hintText = `  • ${hint.slice(0, RISK_HINT_MAX)}${hint.length > RISK_HINT_MAX ? "…" : ""}`;
      lines += estimateWrappedLines(hintText, contentWidth);
    }
    if (proposal.riskHints.length > cutState.riskHintsShown) {
      lines += 1; // "+N more risk(s)"
    }
  }

  if (proposal.scopeNotes) {
    const notesText = `Scope: ${proposal.scopeNotes.slice(0, 200)}`;
    lines += 1 + estimateWrappedLines(notesText, contentWidth); // spacer
  }

  return lines;
}

export function PlanReadyModal({ proposal, dispatch }: PlanReadyModalProps): React.ReactElement {
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
    if (!feedbackMode) return;
    setFeedbackBuffer(feedbackBuffer.slice(0, feedbackCursor) + text + feedbackBuffer.slice(feedbackCursor));
    setFeedbackCursor(feedbackCursor + text.length);
  }, { isActive: true });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Ready to code?</Text>
      <Text> </Text>
      <Text dimColor>Objective:</Text>
      <Text>{proposal.objective.slice(0, 200)}</Text>
      {!!proposal.scopeSummary && (
        <>
          <Text> </Text>
          <Text dimColor>Summary:</Text>
          <Text>{`${proposal.scopeSummary.slice(0, SCOPE_SUMMARY_MAX)}${proposal.scopeSummary.length > SCOPE_SUMMARY_MAX ? "…" : ""}`}</Text>
        </>
      )}
      <Text> </Text>
      {(proposal.noChangeReason || proposal.cannotVerifyReason) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">
            {proposal.noChangeReason ? "No changes needed:" : "Could not verify:"}
          </Text>
          <Text color="yellow">
            {(proposal.noChangeReason ?? proposal.cannotVerifyReason ?? "").slice(0, 200)}
          </Text>
        </Box>
      )}
      {proposal.steps.slice(0, STEPS_MAX).map((step, i) => (
        <Box key={i} flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor>{`  ${i + 1}. `}</Text>
            <Text>{step.title}</Text>
          </Box>
          {!!step.description && (
            <Box flexGrow={1} marginLeft={5}>
              <Text dimColor>{`${step.description.slice(0, STEP_DESCRIPTION_MAX)}${step.description.length > STEP_DESCRIPTION_MAX ? "…" : ""}`}</Text>
            </Box>
          )}
          {step.filesLikely.length > 0 && (
            <Box marginLeft={5}>
              <Text dimColor>{`(${step.filesLikely.slice(0, FILES_LIKELY_MAX).join(", ")})`}</Text>
            </Box>
          )}
          {step.filesLikely.length > FILES_LIKELY_MAX && (
            <Box marginLeft={5}>
              <Text dimColor>{`  … +${step.filesLikely.length - FILES_LIKELY_MAX} more file(s)`}</Text>
            </Box>
          )}
        </Box>
      ))}
      {proposal.steps.length > STEPS_MAX && (
        <Text dimColor>{`  … +${proposal.steps.length - STEPS_MAX} more step(s)`}</Text>
      )}
      {proposal.riskHints.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>Risks:</Text>
          {proposal.riskHints.slice(0, RISK_HINTS_LIMIT).map((hint, i) => (
            <Text key={i}>{`  • ${hint.slice(0, RISK_HINT_MAX)}${hint.length > RISK_HINT_MAX ? "…" : ""}`}</Text>
          ))}
          {proposal.riskHints.length > RISK_HINTS_LIMIT && (
            <Text dimColor>{`  … +${proposal.riskHints.length - RISK_HINTS_LIMIT} more risk(s)`}</Text>
          )}
        </>
      )}
      {!!proposal.scopeNotes && (
        <>
          <Text> </Text>
          <Box flexDirection="row">
            <Text dimColor>{"Scope: "}</Text>
            <Text dimColor>{proposal.scopeNotes.slice(0, 200)}</Text>
          </Box>
        </>
      )}
      <Text> </Text>
      {feedbackMode ? (
        <>
          <Text dimColor>{pendingDecision === "approve_with_feedback" ? "Feedback (then run):" : "Feedback (then revise):"}</Text>
          <Box borderStyle="single" borderColor="cyan">
            <Text>{renderFeedbackBuffer(feedbackBuffer, feedbackCursor)}</Text>
          </Box>
          <Text dimColor>{"Enter to submit  ·  Esc to cancel"}</Text>
        </>
      ) : (
        <Text dimColor>{"[1] auto-accept all  ·  [2] manually approve changes  ·  [3] give feedback  ·  [4] feedback+run  ·  Esc cancel"}</Text>
      )}
    </Box>
  );
}
