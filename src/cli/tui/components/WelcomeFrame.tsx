import { Box, Text, useStdout } from "ink";
import { role, glyph, spacing } from "../theme.js";
import type { BootData } from "../store-core.js";

/** Phase 7a — one-time opening frame, Static-committed so it persists in scrollback.
 *  Composes exclusively from existing theme tokens: lowercase labels, single teal accent
 *  (role.brand), thin rule (glyph.separator), generous whitespace. */
export function WelcomeFrame({ boot }: { boot: BootData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rule = glyph.separator.repeat(Math.max(cols - 4, 20));
  const capStr = boot.dailyCapUsd >= 1
    ? `cap $${boot.dailyCapUsd.toFixed(0)}`
    : `cap $${boot.dailyCapUsd.toFixed(2)}`;

  return (
    <Box flexDirection="column" marginBottom={spacing.sm}>
      <Box>
        <Text color={role.brand}>{glyph.entryMarker.trim()}</Text>
        <Text color={role.brand}> zone </Text>
        <Text dimColor>v{boot.version}</Text>
      </Box>
      <Box>
        <Text>welcome back {boot.user}</Text>
        <Text dimColor> · {boot.repoPath} · {boot.branch}</Text>
      </Box>
      <Box>
        <Text dimColor>{boot.keySource} · {boot.provider} · {boot.model} · {capStr}</Text>
      </Box>
      <Text color={role.muted}>{rule}</Text>
      <Box>
        <Text dimColor>shift+tab cycle mode · /help commands · /sessions resume</Text>
      </Box>
      {boot.whatsNew.map((line, i) => (
        <Box key={i}>
          <Text color={role.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}
