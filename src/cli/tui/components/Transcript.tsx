import { Box, Static, Text, useStdout } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { ToolCall } from "./ToolCall.js";
import { ErrorLine } from "./ErrorLine.js";
import { IterMarker } from "./IterMarker.js";
import { getToolDisplayName, formatToolArgs } from "./toolCallFormat.js";
import { MarkdownText } from "./MarkdownText.js";
import { DiffView } from "./DiffView.js";

function renderEntry(entry: TranscriptEntry, index: number, colWidth: number): React.ReactElement {
  switch (entry.kind) {
    case "narration": {
      const lines = entry.text.split("\n");
      return (
        <Box key={index} flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              {i === 0 ? <Text color="cyan">{"◆ "}</Text> : <Text>{"  "}</Text>}
              <Box flexGrow={1}>
                <Text>{line}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case "thinking": {
      const lines = entry.text.split("\n");
      return (
        <Box key={index} flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              {i === 0 ? <Text color="gray">{"◆ "}</Text> : <Text>{"  "}</Text>}
              <Box flexGrow={1}>
                <Text color="gray">{line}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case "tool_call":
      return (
        <Box key={index} marginTop={1}>
          <ToolCall toolName={entry.toolName} args={entry.args} results={entry.results} patch={entry.patch} />
        </Box>
      );
    case "error":
      return <ErrorLine key={index} text={entry.text} />;
    case "phase_marker":
      return <IterMarker key={index} phase={entry.phase} />;
    case "user_prompt":
      return (
        <Box key={index} backgroundColor="blackBright" width={colWidth}
             paddingX={2} marginTop={1} marginBottom={1}>
          <Text bold color="cyan">{"▸ "}</Text>
          <Box flexGrow={1}>
            <Text bold>{entry.text}</Text>
          </Box>
        </Box>
      );
    case "assistant_final":
      return (
        <Box key={index} flexDirection="column" marginTop={1} marginBottom={1}>
          <MarkdownText text={entry.text} />
        </Box>
      );
    case "post_execute_diffs": {
      const { files } = entry;
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text dimColor>── {files.length} file{files.length === 1 ? "" : "s"} changed ──</Text>
          {files.map((f) => (
            <Box key={f.path} flexDirection="column">
              <Text bold>{f.path}</Text>
              {(f.added > 0 || f.removed > 0) && (
                <Text dimColor>{f.added > 0 ? `+${f.added}` : ""}{f.removed > 0 ? ` -${f.removed}` : ""}</Text>
              )}
              <DiffView patch={f.findReplace} />
            </Box>
          ))}
        </Box>
      );
    }
  }
}

export function Transcript(): React.ReactElement {
  const { state } = useStore();
  const { stdout } = useStdout();
  const liveToolCall = state.liveTail.currentToolCall;
  const liveNarration = state.liveTail.narrationBuffer;

  return (
    <Box flexDirection="column">
      <Static
        key={state.transcriptGeneration}
        items={state.transcript.map((entry, index) => ({ entry, index }))}
        style={{ width: stdout.columns ?? 80 }}
      >
        {(item: { entry: TranscriptEntry; index: number }) =>
          renderEntry(item.entry, item.index, stdout.columns ?? 80)
        }
      </Static>
      {liveNarration && (
        <Box>
          <Text color="cyan">{"◆ "}</Text>
          <Box flexGrow={1}>
            <Text>{liveNarration}</Text>
          </Box>
        </Box>
      )}
      {liveToolCall && (
        <Text dimColor>○ {getToolDisplayName(liveToolCall.toolName)}({formatToolArgs(liveToolCall.toolName, liveToolCall.args)})</Text>
      )}
    </Box>
  );
}
