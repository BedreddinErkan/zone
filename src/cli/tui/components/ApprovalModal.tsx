import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { addDiskTrustPrefix } from "../../../api/diskTrust.js";
import type { StoreAction } from "../store.js";

interface Props {
  approvalId: string;
  runId: string;
  command: string;
  dispatch: Dispatch<StoreAction>;
}

export function ApprovalModal({ approvalId, runId, command, dispatch }: Props): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") {
      resolveCommandApproval({ approvalId, runId, approved: true });
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    } else if (ch === "n" || key.escape) {
      // Commit the blocked tool call to transcript BEFORE resolving approval.
      // This clears liveTail.currentToolCall so the subsequent tool_result
      // event's TOOL_RESULT_PUSH becomes a no-op (tc already null).
      dispatch({ type: "TOOL_RESULT_PUSH", ok: false, detail: "", blocked: true });
      dispatch({ type: "TOOL_CALL_CLOSE" });
      resolveCommandApproval({ approvalId, runId, approved: false });
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    } else if (ch === "t") {
      const prefix = command.trim().split(/\s+/)[0] ?? command.trim();
      dispatch({ type: "SESSION_TRUST_PREFIX", prefix });
      void addDiskTrustPrefix(process.cwd(), prefix);
      resolveCommandApproval({ approvalId, runId, approved: true });
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1} marginX={2}>
      <Text bold color="yellow">Command approval required</Text>
      <Box marginTop={1}>
        <Text color="cyan">  $ </Text><Text>{command}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{"  "}<Text color="green">[Y]</Text>{"es  "}<Text color="red">[N]</Text>{"o  "}<Text color="yellow">[T]</Text>{"rust prefix"}</Text>
      </Box>
    </Box>
  );
}
