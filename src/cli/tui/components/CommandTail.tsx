import React from "react";
import { Box, Text } from "ink";

const META_LINE_REGEX = /^\[exit_code=|^\[zone-/;
const TAIL_SUCCESS_LINES = 3;
const TAIL_FAILURE_LINES = 8;

export function CommandTail({
  detail,
  ok = true,
}: {
  detail: string;
  ok?: boolean;
}): React.ReactElement {
  const maxLines = ok ? TAIL_SUCCESS_LINES : TAIL_FAILURE_LINES;
  const lines = detail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .filter((l) => !META_LINE_REGEX.test(l.trim()));
  const tail = lines.slice(-maxLines);
  const exitCodeMatch = detail.match(/^\[exit_code=(\d+)/m);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : null;
  const indicatorText = ok
    ? "✓"
    : exitCode !== null && exitCode !== 0
    ? `✗ exit ${exitCode}`
    : "✗";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ok ? "green" : "red"}>{indicatorText}</Text>
      </Box>
      {tail.map((line, i) => (
        <Box key={i}>
          <Box flexGrow={1}>
            <Text dimColor={ok}>{line}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
