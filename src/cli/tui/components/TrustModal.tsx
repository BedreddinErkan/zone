import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { resolveTrustApproval } from "../../../api/trustApprovals.js";
import type { StoreAction } from "../store.js";
import { role, spacing } from "../theme.js";

interface Props {
  runId: string;
  projectPath: string;
  dispatch: Dispatch<StoreAction>;
}

export function TrustModal({ runId, projectPath, dispatch }: Props): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") {
      resolveTrustApproval(runId, true);
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    } else if (ch === "n" || key.escape) {
      resolveTrustApproval(runId, false);
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    }
  });

  return (
    <Box borderStyle="single" borderColor={role.caution} flexDirection="column" paddingX={spacing.sm} marginX={spacing.md}>
      <Text bold color={role.caution}>Trust this folder?</Text>
      <Box marginTop={spacing.sm}>
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
