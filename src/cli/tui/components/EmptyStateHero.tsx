import React, { useRef } from "react";
import { Box, Text, useBoxMetrics } from "ink";
import { role, spacing } from "../theme.js";

/** 6×4 half-block logo (same as WelcomeFrame). */
const LOGO = [
  "█▀▀▀▀█",
  "█  ▄▀█",
  "█▄▀  █",
  "█▄▄▄▄█",
];

/** Phase 7.5a — centered hero shown ONLY when the transcript is empty and no run is active.
 *  Disappears as soon as the first transcript entry lands. The WelcomeFrame (Static) stays
 *  above in scrollback; together they form the opening screen. */
export function EmptyStateHero(): React.ReactElement {
  const ref = useRef(null);
  const { height, hasMeasured } = useBoxMetrics(ref);
  const compact = hasMeasured && height < 16;
  return (
    <Box ref={ref} flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        {LOGO.map((line, i) => (
          <Text key={i} color={role.brand}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={spacing.sm} flexShrink={0}>
        <Text color={role.brand}>a coding agent that{"'"}s actually yours</Text>
      </Box>
      {!compact && <Box flexDirection="column" alignItems="center" marginTop={spacing.md} flexShrink={0}>
        <Text color={role.muted}>per-token billing, on your own key</Text>
        <Text color={role.muted}>no limits, never blocked mid-session</Text>
        <Text color={role.muted}>exact dollars per run, logged locally</Text>
      </Box>}
      {!compact && <Box marginTop={spacing.md} flexShrink={0}>
        <Text color={role.muted}>shift+tab mode · /help · /sessions resume</Text>
      </Box>}
    </Box>
  );
}
