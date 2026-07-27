import React from "react";
import { Box, Text } from "ink";

/**
 * The agent's pending question, pinned above the StatusBar.
 *
 * Deliberately NOT a transcript entry: the transcript renders inside <Static>,
 * so a question written there scrolls out of view while the user is still
 * deciding — and the one thing they need on screen is the thing they are being
 * asked. Same region and same reason as PlanPanel.
 */
export function QuestionPanel({
  question,
  carriedOver = false,
}: {
  question: string;
  carriedOver?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text color="cyan">? </Text>
        <Box flexGrow={1}>
          <Text>{question}</Text>
        </Box>
      </Box>
      <Box>
        <Text dimColor>
          {carriedOver
            ? "  carried over from the previous turn — type to answer, esc to discard and start fresh"
            : "  type your answer, or esc to skip"}
        </Text>
      </Box>
    </Box>
  );
}
