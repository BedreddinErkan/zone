import { Box, Static, Text } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { ToolCall } from "./ToolCall.js";
import { ErrorLine } from "./ErrorLine.js";
import { IterMarker } from "./IterMarker.js";
import { getToolDisplayName, formatToolArgs } from "./toolCallFormat.js";

function renderEntry(entry: TranscriptEntry, index: number): React.ReactElement {
  switch (entry.kind) {
    case "narration":
      return (
        <Box key={index}>
          <Text color="cyan">◆ </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "tool_call":
      return <ToolCall key={index} toolName={entry.toolName} args={entry.args} results={entry.results} />;
    case "error":
      return <ErrorLine key={index} text={entry.text} />;
    case "phase_marker":
      return <IterMarker key={index} phase={entry.phase} />;
    case "user_prompt":
      return (
        <Box key={index} borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} marginBottom={1}>
          <Text bold color="cyan">▸ </Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    case "assistant_final":
      return (
        <Box key={index} flexDirection="column" marginTop={1} marginBottom={1}>
          <Text>{entry.text}</Text>
        </Box>
      );
  }
}

export function Transcript(): React.ReactElement {
  const { state } = useStore();
  const liveToolCall = state.liveTail.currentToolCall;
  const liveNarration = state.liveTail.narrationBuffer;

  return (
    <Box flexDirection="column">
      <Static
        key={state.transcriptGeneration}
        items={state.transcript.map((entry, index) => ({ entry, index }))}
      >
        {(item: { entry: TranscriptEntry; index: number }) =>
          renderEntry(item.entry, item.index)
        }
      </Static>
      {liveNarration && (
        <Box>
          <Text color="cyan">◆ </Text>
          <Text>{liveNarration}</Text>
        </Box>
      )}
      {liveToolCall && (
        <Text dimColor>○ {getToolDisplayName(liveToolCall.toolName)}({formatToolArgs(liveToolCall.toolName, liveToolCall.args)})</Text>
      )}
    </Box>
  );
}
