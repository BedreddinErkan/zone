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
}): React.ReactElement | null {
  const maxLines = ok ? TAIL_SUCCESS_LINES : TAIL_FAILURE_LINES;
  const lines = detail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .filter((l) => !META_LINE_REGEX.test(l.trim()));
  if (lines.length === 0) return null;
  const tail = lines.slice(-maxLines);
  return (
    <Box flexDirection="column">
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
