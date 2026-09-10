import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { resolveTrustApproval } from "../../../api/trustApprovals.js";
import { role, spacing } from "../theme.js";

/**
 * Phase 2d — content-only trust prompt. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads pendingApproval
 * from the store (kind: "trust"); resolves the trust decision and dispatches
 * PENDING_APPROVAL_RESOLVED + OVERLAY_POP.
 */
export function TrustPrompt(): React.ReactElement | null {
  const { state, dispatch } = useStore();
  const approval = state.pendingApproval;
  if (!approval || approval.kind !== "trust") return null;

  const runId = approval.runId;
  const projectPath = approval.command;

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") {
      resolveTrustApproval(runId, true);
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
      dispatch({ type: "OVERLAY_POP" });
    } else if (ch === "n" || key.escape) {
      resolveTrustApproval(runId, false);
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
      dispatch({ type: "OVERLAY_POP" });
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={role.accent}>{"  "}{projectPath}</Text>
      </Box>
      <Box marginTop={spacing.sm}>
        <Text>{"  "}Zone will read files here and write changes you approve.</Text>
      </Box>
      <Box marginTop={spacing.sm}>
        <Text>{"  "}<Text color={role.success}>[y]</Text>{" Trust   "}<Text bold color={role.danger}>[N]</Text>{" Don't trust (no changes will be made)"}</Text>
      </Box>
    </Box>
  );
}
