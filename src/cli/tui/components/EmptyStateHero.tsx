import React from "react";
import { Box, Text } from "ink";
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
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" alignItems="center">
        {LOGO.map((line, i) => (
          <Text key={i} color={role.brand}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={spacing.sm}>
        <Text color={role.brand}>a coding agent that{"'"}s actually yours</Text>
      </Box>
      <Box flexDirection="column" alignItems="center" marginTop={spacing.md}>
        <Text color={role.muted}>per-token billing, on your own key</Text>
        <Text color={role.muted}>no limits, never blocked mid-session</Text>
        <Text color={role.muted}>exact dollars per run, logged locally</Text>
      </Box>
      <Box marginTop={spacing.md}>
        <Text color={role.muted}>shift+tab mode · /help · /sessions resume</Text>
      </Box>
    </Box>
  );
}
