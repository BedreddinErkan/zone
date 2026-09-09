import React from "react";
import { Box, Text } from "ink";
import { role, glyph, spacing } from "../../theme.js";

export type ListItemProps = {
  /** Main line text. */
  text: string;
  /** When true, prefixes with glyph.selectionCursor in role.emphasis; when false, prefixes
   *  with two spaces (matching the cursor's width) so unselected rows line up with selected. */
  selected?: boolean;
  /** Additional left indent on top of the cursor prefix, in cells. Used by nested lists
   *  (e.g. plan steps under a section header). */
  indent?: number;
  /** Optional subordinate line, prefixed with glyph.detailConnector (└) and indented under
   *  the main line. Rendered in role.muted so it reads as annotation, not peer content. */
  detail?: string;
};

/**
 * Single list item with optional selection cursor and optional subordinate detail line.
 * Pure presentation.
 *
 * The detail line uses glyph.detailConnector, the same glyph ToolCall.tsx uses for its
 * subordinate path line — extracted to a primitive so future lists (permissions, sessions)
 * share the treatment without copying the glyph locally.
 */
export function ListItem({
  text,
  selected,
  indent = 0,
  detail,
}: ListItemProps): React.ReactElement {
  const prefix = selected ? glyph.selectionCursor : "  ";
  const color = selected ? role.emphasis : undefined;
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      <Box>
        <Text color={color}>
          {prefix}
          {text}
        </Text>
      </Box>
      {detail != null && (
        <Box paddingLeft={spacing.md}>
          <Text color={role.muted}>
            {glyph.detailConnector}
            {detail}
          </Text>
        </Box>
      )}
    </Box>
  );
}
