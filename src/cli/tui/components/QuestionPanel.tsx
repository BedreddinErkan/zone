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
  conversationLost = false,
}: {
  question: string;
  carriedOver?: boolean;
  /**
   * The envelope hit the size cap and the conversation could not be restored.
   * Shown BEFORE the user types: they are about to answer a question whose
   * context the agent can no longer see, and finding that out afterwards is the
   * failure this whole path exists to prevent.
   */
  conversationLost?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text color="cyan">? </Text>
        <Box flexGrow={1}>
          <Text>{question}</Text>
        </Box>
      </Box>
      {carriedOver && conversationLost && (
        <Box>
          <Text color="yellow">
            {"  the earlier conversation was too large to save — only the summary survived"}
          </Text>
        </Box>
      )}
      <Box>
        <Text dimColor>
          {carriedOver
            ? "  carried over from the previous turn — type to answer, esc to set aside"
            : "  type your answer, or esc to skip"}
        </Text>
      </Box>
    </Box>
  );
}
