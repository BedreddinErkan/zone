import { Box, Text, useInput, useStdout } from "ink";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { copyToClipboard, openMailtoFeedback } from "../../../utils/clipboardMailto.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

export function FeedbackModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const { stdout } = useStdout();
  const data = state.feedbackData!;
  const [draftMsg, setDraftMsg] = useState("");
  const [status, setStatus] = useState<"editing" | "delivering">("editing");

  useInput((input, key) => {
    if (status === "delivering") return;
    if (key.escape) {
      dispatch({ type: "FEEDBACK_MODAL_CLOSE" });
      return;
    }
    if (key.return) {
      setStatus("delivering");
      const report =
        "Message: " + (draftMsg.trim() || "(no message)") +
        "\nRun ID: " + data.runId +
        (data.logs ? "\n\nDiagnostics:\n" + data.logs : "");
      copyToClipboard(report);
      openMailtoFeedback(
        "Zone feedback",
        (draftMsg.trim() || "(no message)") + "\n\nRun ID: " + data.runId,
      );
      dispatch({ type: "FEEDBACK_MODAL_CLOSE" });
      dispatch({
        type: "TOAST_PUSH",
        entry: {
          id: randomUUID(),
          message: "Copied · email draft opened · or send to feedback@zonecli.dev",
          level: "info",
        },
      });
      return;
    }
    if (key.backspace || key.delete) {
      setDraftMsg((m) => m.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraftMsg((m) => m + input);
    }
  });

  const cols = stdout?.columns ?? process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 70);
  const logLines = data.logs ? data.logs.split("\n").filter(Boolean).slice(-5) : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color="cyan"> Send feedback</Text>
      <Text> </Text>
      <Text dimColor> Run ID: {data.runId}</Text>
      {logLines.length > 0 && (
        <>
          <Text dimColor> Recent diagnostics:</Text>
          {logLines.map((line, i) => (
            <Text key={i} dimColor>   {line.slice(0, innerWidth - 5)}</Text>
          ))}
        </>
      )}
      <Text> </Text>
      <Text> Message:</Text>
      <Text>   {draftMsg}▋</Text>
      <Text> </Text>
      {status === "delivering"
        ? <Text dimColor> Delivering…</Text>
        : <Text dimColor> Type message · Enter send · Esc cancel</Text>
      }
    </Box>
  );
}
