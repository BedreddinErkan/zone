import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolvePlanApproval } from "../../../llm/planApprovals.js";

interface PlanReadyModalProps {
  proposal: NonNullable<StoreState["planReadyProposal"]>;
  dispatch: Dispatch<StoreAction>;
}

export function PlanReadyModal({ proposal, dispatch }: PlanReadyModalProps): React.ReactElement {
  useInput((input, key) => {
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
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "refine" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      return;
    }
    if (input === "4") {
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "feedback" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      return;
    }
    if (key.escape) {
      resolvePlanApproval({ planId: proposal.planId, runId: proposal.runId, decision: "reject" });
      dispatch({ type: "PLAN_READY_RESOLVED" });
      dispatch({ type: "RUN_ABORTED" });
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Ready to code?</Text>
      <Text> </Text>
      <Text dimColor>Objective:</Text>
      <Text>{proposal.objective.slice(0, 200)}</Text>
      <Text> </Text>
      {proposal.steps.slice(0, 6).map((step, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>{`  ${i + 1}. `}</Text>
          <Text>{step.title}</Text>
          {step.filesLikely.length > 0 && (
            <Text dimColor>{`  (${step.filesLikely.slice(0, 3).join(", ")}${step.filesLikely.length > 3 ? ", …" : ""})`}</Text>
          )}
        </Box>
      ))}
      {proposal.steps.length > 6 && (
        <Text dimColor>{`  … +${proposal.steps.length - 6} more step(s)`}</Text>
      )}
      <Text> </Text>
      <Text dimColor>{"[1] auto-accept all  ·  [2] approve commands  ·  [3] refine (stub)  ·  [4] feedback (stub)  ·  Esc cancel"}</Text>
    </Box>
  );
}
