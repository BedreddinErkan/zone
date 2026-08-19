import React from "react";
import { Box, Text } from "ink";
import { role, glyph } from "../theme.js";

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
    ? glyph.successMark
    : exitCode !== null && exitCode !== 0
    ? `${glyph.failureMark} exit ${exitCode}`
    : glyph.failureMark;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ok ? role.success : role.danger}>{indicatorText}</Text>
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
