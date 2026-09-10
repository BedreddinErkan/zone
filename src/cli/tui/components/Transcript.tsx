import { Box, Static, Text, useStdout } from "ink";
import { useStore, type TranscriptEntry } from "../store.js";
import { ToolCall } from "./ToolCall.js";
import { ToolCallGroup } from "./ToolCallGroup.js";
import { ErrorLine } from "./ErrorLine.js";
import { getToolDisplayName, formatToolArgs } from "./toolCallFormat.js";
import { MarkdownText } from "./MarkdownText.js";
import { DiffView } from "./DiffView.js";
import { PlanBody } from "./PlanBody.js";
import { role, glyph, spacing } from "../theme.js";

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
        <Box key={index} marginTop={spacing.sm}>
          <ToolCall toolName={entry.toolName} args={entry.args} results={entry.results} patch={entry.patch} />
        </Box>
      );
    case "tool_call_group":
      return (
        <Box key={index} marginTop={spacing.sm}>
          <ToolCallGroup calls={entry.calls} />
        </Box>
      );
    case "error":
      return <ErrorLine key={index} text={entry.text} />;
    case "user_prompt":
      return (
        // Same pairing as Composer's box: role.surface is an app-painted fill, so the text on it
        // sets role.surfaceForeground rather than inheriting the terminal's default. The marker
        // keeps role.accent deliberately — it is the one run here that should read as a colour
        // rather than as body text, and its ratio against the fill stays terminal-dependent, which
        // surfacePairing.test.ts does not claim to fix.
        <Box key={index} backgroundColor={role.surface} width={colWidth}
             paddingX={spacing.md} marginTop={spacing.sm} marginBottom={spacing.sm}>
          <Text bold color={role.accent}>{glyph.promptMarker}</Text>
          <Box flexGrow={1}>
            <Text bold color={role.surfaceForeground}>{entry.text}</Text>
          </Box>
        </Box>
      );
    case "assistant_final":
      return (
        <Box key={index} flexDirection="column" marginTop={spacing.sm} marginBottom={spacing.sm}>
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
        <Box key={index} flexDirection="column" marginTop={spacing.sm}>
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
    case "compact_summary": {
      const { totalCompacted, counts } = entry;
      const parts: string[] = [`${totalCompacted} earlier events compacted`];
      if (counts.toolCalls > 0) parts.push(`${counts.toolCalls} tool call${counts.toolCalls === 1 ? "" : "s"}`);
      if (counts.narrations > 0) parts.push(`${counts.narrations} narration${counts.narrations === 1 ? "" : "s"}`);
      if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
      if (counts.subagents > 0) parts.push(`${counts.subagents} subagent${counts.subagents === 1 ? "" : "s"}`);
      return (
        <Box key={index}>
          <Text color={role.muted}>{glyph.separator} [{parts.join(" · ")}] {glyph.separator}</Text>
        </Box>
      );
    }
    case "plan_ready":
      return (
        <Box key={index} marginTop={spacing.sm} marginBottom={spacing.sm}>
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
