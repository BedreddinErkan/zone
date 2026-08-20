import React from "react";
import { Box, Text } from "ink";
import { getToolDisplayName, formatToolArgs } from "./toolCallFormat.js";
import { glyph } from "../theme.js";

export interface ToolCallGroupProps {
  calls: Array<{ toolName: string; arg: string }>;
}

/**
 * One collapsed count header for a run of consecutive successful read-only
 * calls, plus one detail line per call underneath naming what it touched —
 * the count alone can't tell a reader which files or patterns were involved.
 * Every entry here already succeeded (store-core.ts never batches a failure —
 * it flushes and commits that call individually instead), so there is no
 * success/failure branching to do for either line.
 *
 * A call with an empty identifying argument (toolCallIdentifyingArg.ts) renders
 * no line at all rather than a blank one — an empty "└" would claim there was
 * nothing to show when the truth is just that this particular call had no
 * identifying content (e.g. search_in_files with an omitted pattern).
 *
 * All N calls are otherwise considered, never a truncated "first few" — the
 * batch is already capped at READ_ONLY_BATCH_MAX_SIZE (store-core.ts) by
 * construction, so N is always small; a truncation branch would be
 * complexity with nothing to truncate. Detail lines stay in call order, not
 * regrouped by tool: that's what happened, and it needs no extra sort step.
 *
 * search_in_files/find_references render italic, the other tools don't: a grep pattern and a
 * file path were otherwise indistinguishable here (same connector, same dim styling, and
 * formatToolArgs truncates without naming which tool it came from) — the header line above names
 * the aggregate counts once, but nothing on this per-item line said which kind of string it was.
 * Scoped to this component rather than to formatToolArgs itself: that function has two other call
 * sites (ToolCall.tsx, Transcript.tsx's live preview) that already print the tool's display name
 * directly next to the args and have no such ambiguity to fix.
 */
export function ToolCallGroup({ calls }: ToolCallGroupProps): React.ReactElement {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const display = getToolDisplayName(call.toolName);
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) => `${name} ×${count}`);
  return (
    <Box flexDirection="column">
      <Box>
        {/* No explicit color: matches getStatusGlyph's own success case (icon only, no color). */}
        <Text>{glyph.groupMarker} </Text>
        <Text dimColor>{parts.join(", ")}</Text>
      </Box>
      {calls.map((call, i) =>
        call.arg === "" ? null : (
          <Box key={i} paddingLeft={2}>
            <Text
              dimColor
              italic={call.toolName === "search_in_files" || call.toolName === "find_references"}
            >
              {glyph.detailConnector}{formatToolArgs(call.toolName, call.arg)}
            </Text>
          </Box>
        )
      )}
    </Box>
  );
}
