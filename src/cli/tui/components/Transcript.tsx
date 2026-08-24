import { Box, Static, Text, useStdout } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { ToolCall } from "./ToolCall.js";
import { ToolCallGroup } from "./ToolCallGroup.js";
import { ErrorLine } from "./ErrorLine.js";
import { IterMarker } from "./IterMarker.js";
import { getToolDisplayName, formatToolArgs } from "./toolCallFormat.js";
import { MarkdownText } from "./MarkdownText.js";
import { DiffView } from "./DiffView.js";
import { PlanBody } from "./PlanBody.js";
import { role, glyph } from "../theme.js";

function renderEntry(entry: TranscriptEntry, index: number, colWidth: number): React.ReactElement {
  switch (entry.kind) {
    case "narration": {
      const lines = entry.text.split("\n");
      return (
        <Box key={index} flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              {i === 0 ? <Text color={role.accent}>{glyph.entryMarker}</Text> : <Text>{"  "}</Text>}
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
              {i === 0 ? <Text color={role.muted}>{glyph.entryMarker}</Text> : <Text>{"  "}</Text>}
              <Box flexGrow={1}>
                <Text color={role.muted}>{line}</Text>
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
    case "tool_call_group":
      return (
        <Box key={index} marginTop={1}>
          <ToolCallGroup calls={entry.calls} />
        </Box>
      );
    case "error":
      return <ErrorLine key={index} text={entry.text} />;
    case "phase_marker":
      return <IterMarker key={index} phase={entry.phase} />;
    case "user_prompt":
      return (
        <Box key={index} backgroundColor={role.surface} width={colWidth}
             paddingX={2} marginTop={1} marginBottom={1}>
          <Text bold color={role.accent}>{glyph.promptMarker}</Text>
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
      // The aggregation (header, path, +N/-M) is what this block adds over the inline tool-call
      // rendering and is always shown. The diff body is shown only for files whose diff was NOT
      // already rendered inline — see diffsAlreadyShownInline in store-core.ts, which computes
      // this at dispatch. A write_file overwrite and a multi_edit both land here with their diff
      // intact, because neither produces a matching inline one.
      const alreadyShown = new Set(entry.diffShownInline ?? []);
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text dimColor>── {files.length} file{files.length === 1 ? "" : "s"} changed ──</Text>
          {files.map((f) => (
            <Box key={f.path} flexDirection="column">
              <Text bold>{f.path}</Text>
              {(f.added > 0 || f.removed > 0) && (
                <Text dimColor>{f.added > 0 ? `+${f.added}` : ""}{f.removed > 0 ? ` -${f.removed}` : ""}</Text>
              )}
              {!alreadyShown.has(f.path) && <DiffView patch={f.findReplace} />}
            </Box>
          ))}
        </Box>
      );
    }
    case "plan_ready":
      return (
        <Box key={index} marginTop={1} marginBottom={1}>
          <PlanBody
            objective={entry.objective}
            steps={entry.steps}
            scopeNotes={entry.scopeNotes}
            noChangeReason={entry.noChangeReason}
            cannotVerifyReason={entry.cannotVerifyReason}
            answerOnlyReason={entry.answerOnlyReason}
            riskHints={entry.riskHints}
            scopeSummary={entry.scopeSummary}
            narrative={entry.narrative}
            filesLikely={entry.filesLikely}
          />
        </Box>
      );
  }
}

export function Transcript(): React.ReactElement {
  const { state } = useStore();
  const { stdout } = useStdout();
  const liveToolCall = state.liveTail.currentToolCall;
  const liveNarration = state.liveTail.narrationBuffer;
  const liveStreamingAnswer = state.liveTail.streamingAnswer;
  const pendingBatchCount = state.liveTail.pendingReadOnlyBatch.length;

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
          <Text color={role.accent}>{glyph.entryMarker}</Text>
          <Box flexGrow={1}>
            <Text>{liveNarration}</Text>
          </Box>
        </Box>
      )}
      {liveStreamingAnswer && (
        // Live-only, never committed — see STREAMING_ANSWER_SET's own comment in
        // store-core.ts. ASSISTANT_FINAL commits the authoritative, markdown-formatted
        // entry to <Static> separately; this box always disappears when that happens.
        <Box>
          <Text dimColor>{liveStreamingAnswer}</Text>
        </Box>
      )}
      {liveToolCall && (
        <Text dimColor>
          ○ {getToolDisplayName(liveToolCall.toolName)}({formatToolArgs(liveToolCall.toolName, liveToolCall.args)})
          {pendingBatchCount > 0 ? ` · +${pendingBatchCount} more this batch` : ""}
        </Text>
      )}
    </Box>
  );
}
