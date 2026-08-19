import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import type { StoreAction, StoreState } from "../store.js";
import { resolveRevisionApproval } from "../../../llm/revisionApprovals.js";
import { role } from "../theme.js";

interface PlanModalProps {
  proposal: NonNullable<StoreState["planProposal"]>;
  dispatch: Dispatch<StoreAction>;
}

export function PlanModal({ proposal, dispatch }: PlanModalProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "a" || input === "A") {
      resolveRevisionApproval({ revisionId: proposal.revisionId, runId: proposal.runId, decision: "approve" });
      dispatch({ type: "PLAN_RESOLVED" });
      return;
    }
    if (input === "r" || input === "R" || key.escape) {
      resolveRevisionApproval({ revisionId: proposal.revisionId, runId: proposal.runId, decision: "reject" });
      dispatch({ type: "PLAN_RESOLVED" });
      dispatch({ type: "RUN_ABORTED" });
      return;
    }
  });

  const typeLine = `Type: ${proposal.revisionType}`;

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={role.accent} paddingX={2} paddingY={1}>
      <Text bold color={role.accent}>Plan Review</Text>
      <Text dimColor>{typeLine}</Text>
      <Text> </Text>
      <Text dimColor>Reason:</Text>
      <Text>{proposal.revisionReason}</Text>
      <Text> </Text>
      <Text dimColor>Original:</Text>
      <Text>{proposal.originalPlan.slice(0, 280)}</Text>
      <Text> </Text>
      <Text dimColor>Revised:</Text>
      <Text>{proposal.revisedPlanSummary.slice(0, 280)}</Text>
      {(proposal.missingFiles?.length ?? 0) > 0 && (
        <Text dimColor>{"Missing: "}{proposal.missingFiles!.join(", ")}</Text>
      )}
      <Text> </Text>
      <Text dimColor>{"A accept  ·  R reject and cancel  ·  Esc = R"}</Text>
    </Box>
  );
}
