import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { loadSession } from "../../../api/diskSessions.js";
import { role, glyph } from "../theme.js";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Phase 2d — content-only session browser. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component.
 */
export function SessionBrowser(): React.ReactElement {
  const { state, dispatch } = useStore();
  const list = state.sessionsList;
  const sel = state.sessionsSelectedIndex;
  const cols = process.stdout.columns ?? 80;
  const narrow = cols < 60;

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "OVERLAY_POP" });
    } else if (key.upArrow) {
      dispatch({ type: "SESSIONS_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "SESSIONS_NAV", direction: "down" });
    } else if (key.return) {
      const meta = list[sel];
      if (meta) {
        void loadSession(process.cwd(), meta.filename).then(session => {
          if (session) {
            dispatch({ type: "SESSION_RESUME", session });
            dispatch({ type: "OVERLAY_POP" });
          } else {
            dispatch({ type: "OVERLAY_POP" });
          }
        });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>Past sessions — Enter to resume:</Text>
      <Box height={1} />
      {list.length === 0 ? (
        <Text dimColor>No saved sessions found.</Text>
      ) : (
        list.map((meta, i) => {
          const selected = i === sel;
          const dateStr = meta.startedAt.slice(0, 16).replace("T", " ");
          const prefix = `${selected ? glyph.selectionCursor : "  "}${String(i + 1).padStart(2)}.`;
          if (narrow) {
            return (
              <Box key={meta.sessionId} flexDirection="column">
                <Text color={selected ? role.accent : undefined}>{prefix} {dateStr}</Text>
                {selected && meta.firstUserMessage ? (
                  <Text dimColor>{"     "}{truncate(meta.firstUserMessage, cols - 6)}</Text>
                ) : null}
              </Box>
            );
          }
          const msgLabel = meta.messageCount > 0
            ? ` (${meta.messageCount} msg${meta.messageCount !== 1 ? "s" : ""})`
            : "";
          const costStr = `$${meta.totalCostUsd.toFixed(2)}`;
          const modelStr = truncate(meta.model || "default", 20);
          const msgStr = meta.firstUserMessage
            ? `"${truncate(meta.firstUserMessage, 40)}"`
            : "";
          return (
            <Box key={meta.sessionId}>
              <Text color={selected ? role.accent : undefined}>
                {prefix} {dateStr}{"  "}{modelStr}{"  "}{costStr}{msgLabel}{msgStr ? `  ${msgStr}` : ""}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
