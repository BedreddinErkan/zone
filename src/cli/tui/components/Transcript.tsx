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
    case "plan_snapshot": {
      const { todos } = entry;
      return (
        <Box key={index} flexDirection="column" marginTop={spacing.sm}>
          {todos.map((todo) => {
            const statusGlyph = todo.status === "completed"
              ? glyph.successMark
              : todo.status === "in_progress"
                ? glyph.selectionCursor
                : glyph.pendingMark;
            const dim = todo.status !== "in_progress";
            return (
              <Box key={todo.id}>
                <Text dimColor={dim} color={todo.status === "completed" ? role.success : undefined}>
                  {statusGlyph}{" "}
                </Text>
                <Text dimColor={dim} bold={todo.status === "in_progress"}>{todo.text}</Text>
              </Box>
            );
          })}
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

/** Phase 5b — group marker types for nested subagent rendering. These are
 *  rendering-only constructs, never stored in the transcript. */
type GroupedItem =
  | { kind: "entry"; entry: TranscriptEntry; index: number }
  | { kind: "group_header"; subagentId: string; subagentType: string; title: string; index: number }
  | { kind: "group_footer"; subagentId: string; index: number };

function buildGroupedItems(
  transcript: TranscriptEntry[],
  threads: Record<string, import("../store.js").SubagentThread>,
): GroupedItem[] {
  const items: GroupedItem[] = [];
  let i = 0;
  while (i < transcript.length) {
    const entry = transcript[i]!;
    const sid = (entry as any).subagentId as string | undefined;
    if (!sid) {
      items.push({ kind: "entry", entry, index: i });
      i++;
      continue;
    }
    // Start of a subagent group — collect consecutive entries with same subagentId
    const thread = threads[sid];
    items.push({
      kind: "group_header",
      subagentId: sid,
      subagentType: thread?.subagentType ?? "worker",
      title: thread?.title ?? "",
      index: i,
    });
    while (i < transcript.length && (transcript[i] as any).subagentId === sid) {
      items.push({ kind: "entry", entry: transcript[i]!, index: i });
      i++;
    }
    items.push({ kind: "group_footer", subagentId: sid, index: i });
  }
  return items;
}

export function Transcript(): React.ReactElement {
  const { state } = useStore();
  const { stdout } = useStdout();
  const liveToolCall = state.liveTail.currentToolCall;
  const liveNarration = state.liveTail.narrationBuffer;
  const liveStreamingAnswer = state.liveTail.streamingAnswer;
  const pendingBatchCount = state.liveTail.pendingReadOnlyBatch.length;
  const groupedItems = buildGroupedItems(state.transcript, state.subagentThreads);

  return (
    <Box flexDirection="column">
      <Static
        key={state.transcriptGeneration}
        items={groupedItems}
        style={{ width: stdout.columns ?? 80 }}
      >
        {(item: GroupedItem) => {
          if (item.kind === "group_header") {
            const truncated = item.title.length > 60 ? item.title.slice(0, 57) + "..." : item.title;
            return (
              <Box key={`gh-${item.index}`}>
                <Text color={role.muted}>┌─ </Text>
                <Text color={role.accent}>{item.subagentType}</Text>
                <Text color={role.muted}> · {truncated} ──────</Text>
              </Box>
            );
          }
          if (item.kind === "group_footer") {
            const thread = state.subagentThreads[item.subagentId];
            const statusMark = thread?.status === "failed"
              ? glyph.failureMark
              : thread?.status === "completed"
                ? glyph.successMark
                : glyph.pendingMark;
            const parts: string[] = [];
            if (thread?.iterations !== undefined) parts.push(`${thread.iterations} iters`);
            if (thread?.costUsd !== undefined) parts.push(`$${thread.costUsd.toFixed(4)}`);
            if (thread?.status === "running") parts.push(`${thread.toolCallCount} calls`);
            if (thread?.summary) {
              const s = thread.summary.length > 80 ? thread.summary.slice(0, 77) + "..." : thread.summary;
              parts.push(s);
            }
            return (
              <Box key={`gf-${item.index}`}>
                <Text color={role.muted}>└─ {statusMark} {parts.join(" · ")}</Text>
              </Box>
            );
          }
          // Regular entry — indent if inside a subagent group
          const sid = (item.entry as any).subagentId as string | undefined;
          return (
            <Box key={item.index} paddingLeft={sid ? 2 : 0}>
              {renderEntry(item.entry, item.index, stdout.columns ?? 80)}
            </Box>
          );
        }}
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
