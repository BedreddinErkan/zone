import React from "react";
import { Box, Text } from "ink";
import { role, glyph, spacing } from "../../theme.js";

export type RowProps = {
  /** Left column. Always rendered. */
  label: string;
  /** Optional middle column (the value the row represents). */
  value?: string;
  /** Optional right-aligned trailing column (a unit, a count, a hint). */
  right?: string;
  /** When true, the label is prefixed with glyph.selectionCursor and colored role.emphasis —
   *  the navigable-list selection state. When false, the label renders in the default
   *  foreground with a two-space prefix that matches the cursor's width, so unselected rows
   *  line up with selected rows. */
  selected?: boolean;
};

/**
 * One navigable-list row: selection cursor, label, optional value, optional right-aligned
 * tail. Pure presentation.
 *
 * Continuation lines (when the row wraps) are not the Row's responsibility — Ink's Box lays
 * out each child on its own line, and a wrapping row today means the caller split the content
 * across multiple Row children. The "wrap with continuation indent" requirement in the spec
 * is addressed by IndentedWrap.tsx for the free-text case; Row's contract is a single line
 * with up to three columns.
 */
export function Row({ label, value, right, selected }: RowProps): React.ReactElement {
  const prefix = selected ? glyph.selectionCursor : "  ";
  const labelColor = selected ? role.emphasis : undefined;
  return (
    <Box>
      <Text color={labelColor}>
        {prefix}
        {label}
      </Text>
      {value != null && (
        <Box marginLeft={spacing.sm} flexGrow={1}>
          <Text>{value}</Text>
        </Box>
      )}
      {right != null && (
        <Box marginLeft={spacing.sm}>
          <Text color={role.muted}>{right}</Text>
        </Box>
      )}
    </Box>
  );
}
