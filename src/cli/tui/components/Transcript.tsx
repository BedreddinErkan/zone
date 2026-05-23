import { Box, Static, Text } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { ToolCall } from "./ToolCall.js";
import { ErrorLine } from "./ErrorLine.js";
import { IterMarker } from "./IterMarker.js";
import { RunSummary } from "./RunSummary.js";

function renderEntry(entry: TranscriptEntry, index: number): React.ReactElement {
  switch (entry.kind) {
    case "assistant":
      return (
        <Box key={index}>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "tool_call":
      return <ToolCall key={index} toolName={entry.toolName} args={entry.args} results={entry.results} />;
    case "error":
      return <ErrorLine key={index} text={entry.text} />;
    case "phase_marker":
      return <IterMarker key={index} phase={entry.phase} />;
    case "run_summary":
      return <RunSummary key={index} text={entry.text} />;
  }
}

export function Transcript(): React.ReactElement {
  const { state } = useStore();
  const liveToolCall = state.liveTail.currentToolCall;

  return (
    <Box flexDirection="column">
      <Static items={state.transcript.map((entry, index) => ({ entry, index }))}>
        {(item) => renderEntry(item.entry, item.index)}
      </Static>
      {liveToolCall && (
        <Text color="cyan">{`▸ ${liveToolCall.toolName}(${liveToolCall.args.length > 60 ? liveToolCall.args.slice(0, 57) + "..." : liveToolCall.args})`}</Text>
      )}
      <AssistantTurn />
    </Box>
  );
}
