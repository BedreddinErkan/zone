import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { resolveEditApproval } from "../../../api/editApprovals.js";
import { addDiskTrustPrefix } from "../../../api/diskTrust.js";
import type { StoreAction } from "../store.js";

interface Props {
  approvalId: string;
  runId: string;
  command: string;
  kind?: "command" | "edit";
  dispatch: Dispatch<StoreAction>;
}

export function ApprovalModal({ approvalId, runId, command, kind, dispatch }: Props): React.ReactElement {
  const isEdit = kind === "edit";

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") {
      if (isEdit) {
        resolveEditApproval({ approvalId, runId, approved: true });
      } else {
        resolveCommandApproval({ approvalId, runId, approved: true });
      }
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    } else if (ch === "n" || key.escape) {
      // Commit the blocked tool call to transcript BEFORE resolving approval.
      // This clears liveTail.currentToolCall so the subsequent tool_result
      // event's TOOL_RESULT_PUSH becomes a no-op (tc already null).
      dispatch({ type: "TOOL_RESULT_PUSH", ok: false, detail: "", blocked: true });
      dispatch({ type: "TOOL_CALL_CLOSE" });
      if (isEdit) {
        resolveEditApproval({ approvalId, runId, approved: false });
      } else {
        resolveCommandApproval({ approvalId, runId, approved: false });
      }
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    } else if (ch === "t" && !isEdit) {
      // [T]rust prefix: command-only — suppressed for edits to prevent
      // polluting command trust namespace.
      const prefix = command.trim().split(/\s+/)[0] ?? command.trim();
      dispatch({ type: "SESSION_TRUST_PREFIX", prefix });
      void addDiskTrustPrefix(process.cwd(), prefix);
      resolveCommandApproval({ approvalId, runId, approved: true });
      dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1} marginX={2}>
      <Text bold color="yellow">{isEdit ? "Edit approval required" : "Command approval required"}</Text>
      <Box marginTop={1}>
        {isEdit
          ? <><Text color="cyan">  📄 </Text><Text>{command}</Text></>
          : <><Text color="cyan">  $ </Text><Text>{command}</Text></>
        }
      </Box>
      <Box marginTop={1}>
        {isEdit
          ? <Text>{"  "}<Text color="green">[Y]</Text>{"es  "}<Text color="red">[N]</Text>{"o"}</Text>
          : <Text>{"  "}<Text color="green">[Y]</Text>{"es  "}<Text color="red">[N]</Text>{"o  "}<Text color="yellow">[T]</Text>{"rust prefix"}</Text>
        }
      </Box>
    </Box>
  );
}
