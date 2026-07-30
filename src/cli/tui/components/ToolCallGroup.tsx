import React from "react";
import { Box, Text } from "ink";
import { getToolDisplayName } from "./toolCallFormat.js";

export interface ToolCallGroupProps {
  calls: Array<{ toolName: string }>;
}

/**
 * One collapsed line for a run of consecutive successful read-only calls.
 * Every entry here already succeeded (store-core.ts never batches a failure —
 * it flushes and commits that call individually instead), so there is no
 * success/failure branching to do: just count by display name.
 */
export function ToolCallGroup({ calls }: ToolCallGroupProps): React.ReactElement {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const display = getToolDisplayName(call.toolName);
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) => `${name} ×${count}`);
  return (
    <Box>
      {/* No explicit color: matches getStatusGlyph's own success case (icon only, no color). */}
      <Text>{"● "}</Text>
      <Text dimColor>{parts.join(", ")}</Text>
    </Box>
  );
}
