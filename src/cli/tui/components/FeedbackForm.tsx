import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import { buildFeedbackReport } from "../../../feedback/buildFeedbackReport.js";
import type { FeedbackReport } from "../../../feedback/buildFeedbackReport.js";
import { useStore } from "../store.js";
import { copyToClipboard, openUrlInBrowser } from "../../../utils/clipboardMailto.js";
import { glyph, spacing } from "../theme.js";

const REPO_SLUG = "BedreddinErkan/zone";

/**
 * Phase 2d — content-only feedback form. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads feedbackData from
 * the store; dispatches OVERLAY_POP on Esc/close.
 */
export function FeedbackForm(): React.ReactElement {
  const { state, dispatch } = useStore();
  const { stdout } = useStdout();
  const data = state.feedbackData!;
  const [draftMsg, setDraftMsg] = useState("");
  const [status, setStatus] = useState<"editing" | "delivering" | "delivered">("editing");
  const [builtReport, setBuiltReport] = useState<FeedbackReport | null>(null);

  useInput((input, key) => {
    if (status === "delivering") return;
    // Esc falls through to central handler (Phase 3b).

    if (status === "delivered") {
      if (input === "m" && !key.ctrl && !key.meta && builtReport) {
        openUrlInBrowser(builtReport.mailtoUrl);
        dispatch({ type: "OVERLAY_POP" });
        dispatch({
          type: "TOAST_PUSH",
          entry: { id: randomUUID(), message: "Email draft opened", level: "info" },
        });
      } else {
        dispatch({ type: "OVERLAY_POP" });
      }
      return;
    }

    if (key.return) {
      setStatus("delivering");
      const msg = draftMsg.trim() || "(no message)";
      buildFeedbackReport({
        repoPath: data.repoPath,
        sessionId: data.sessionId,
        runId: data.runId,
        userMessage: msg,
        version: data.version,
        platform: process.platform,
        repoSlug: REPO_SLUG,
      }).then((r) => {
        copyToClipboard(r.markdown);
        openUrlInBrowser(r.githubIssueUrl);
        setBuiltReport(r);
        setStatus("delivered");
      }).catch(() => {
        dispatch({ type: "OVERLAY_POP" });
        dispatch({
          type: "TOAST_PUSH",
          entry: { id: randomUUID(), message: "Feedback build failed", level: "warning" },
        });
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
    <Box flexDirection="column">
      <Text dimColor> Run ID: {data.runId}</Text>
      {logLines.length > 0 && (
        <>
          <Text dimColor> Recent diagnostics:</Text>
          {logLines.map((line, i) => (
            <Text key={i} dimColor>   {line.slice(0, innerWidth - 5)}</Text>
          ))}
        </>
      )}
      <Box marginTop={spacing.sm}>
        <Text> Message:</Text>
      </Box>
      <Text>   {draftMsg}{glyph.cursor}</Text>
      {status === "delivering" && <Text dimColor> Opening GitHub issue…</Text>}
      {status === "delivered" && <Text dimColor> Copied · GitHub opened · m for email · any key to close</Text>}
    </Box>
  );
}
