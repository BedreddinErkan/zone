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

/** Strip markdown emphasis (** and `) from a CHANGELOG bullet line. */
function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, "").replace(/`/g, "");
}

/** Truncate to maxLen chars with a trailing ellipsis. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

/** Phase 7a — one-time opening frame, Static-committed so it persists in scrollback.
 *  Single identity block: 6×4 logo + version, personalized line, context line, thin rule, whatsNew.
 *  No interaction hints (those live in Composer's Phase 7c bottom chrome). */
export function WelcomeFrame({ boot }: { boot: BootData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rule = glyph.separator.repeat(Math.max(cols - 4, 20));
  const capStr = boot.dailyCapUsd >= 1
    ? `cap $${boot.dailyCapUsd.toFixed(0)}`
    : `cap $${boot.dailyCapUsd.toFixed(2)}`;
  const maxLineLen = Math.max(cols - 8, 40);

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
      <Box>
        <Text dimColor>{boot.keySource} · {boot.provider} · {boot.model} · {capStr}</Text>
      </Box>
      <Text color={role.muted}>{rule}</Text>
      {boot.whatsNew.map((line, i) => (
        <Box key={i}>
          <Text color={role.muted}>{truncate(stripMarkdown(line), maxLineLen)}</Text>
        </Box>
      ))}
    </Box>
  );
}
