import { Box, Text } from "ink";
import { useStore } from "../store.js";

export function AssistantTurn(): React.ReactElement | null {
  const { state } = useStore();
  const text = state.liveTail.narrationBuffer;

  if (!text) return null;

  return (
    <Box>
      <Text color="cyan">◆ </Text>
      <Text>{text}</Text>
    </Box>
  );
}
