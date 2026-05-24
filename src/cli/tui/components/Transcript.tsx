import { Box, Text } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { ToolCall } from "./ToolCall.js";
import { ErrorLine } from "./ErrorLine.js";
import { IterMarker } from "./IterMarker.js";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

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
        <Box key={index}>
          <Text color="cyan">▸ </Text>
          <Text>{entry.text}</Text>
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

  return (
    <Box flexDirection="column">
      {state.transcript.map((entry, index) => renderEntry(entry, index))}
      {liveToolCall && (
        <Box justifyContent="space-between">
          <Text color="cyan">{"  "}{liveToolCall.toolName}  {truncate(liveToolCall.args, 50)}</Text>
          <Text dimColor>…</Text>
        </Box>
      )}
    </Box>
  );
}
