import { Box, Text, useStdout } from "ink";
import { role, glyph, spacing } from "../theme.js";
import type { BootData } from "../store-core.js";

/** 6×4 half-block logo: a square containing a diagonal slash from bottom-left to top-right.
 *  Composed from Unicode half-block characters (▀ ▄ █) in role.brand. */
const LOGO = [
  "█▀▀▀▀█",
  "█  ▄▀█",
  "█▄▀  █",
  "█▄▄▄▄█",
];

/** Phase 7a — one-time opening frame, Static-committed so it persists in scrollback.
 *  Exactly three elements: 6×4 logo with version, personalized line, thin rule as the
 *  bottom boundary separating the frame from the transcript. Model, provider, cap, and
 *  key source are shown by the reactive StatusBar; whatsNew was removed as noise. */
export function WelcomeFrame({ boot }: { boot: BootData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rule = glyph.separator.repeat(Math.max(cols - 4, 20));

  return (
    <Box flexDirection="column" marginBottom={spacing.sm}>
      <Box flexDirection="row">
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <Text key={i} color={role.brand}>{line}</Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingLeft={spacing.md} justifyContent="center">
          <Text color={role.brand} bold>zone</Text>
          <Text dimColor>v{boot.version}{boot.isResumed ? " (resumed)" : ""}</Text>
        </Box>
      </Box>
      <Box marginTop={spacing.xs}>
        <Text>welcome back {boot.user}</Text>
        <Text dimColor> · {boot.repoPath} · {boot.branch}</Text>
      </Box>
      <Text color={role.muted}>{rule}</Text>
    </Box>
  );
}
