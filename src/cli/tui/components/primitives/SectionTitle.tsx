import React from "react";
import { Box, Text, useStdout } from "ink";
import { role, glyph } from "../../theme.js";

export type SectionTitleProps = {
  /** Rendered lowercased, per the existing modal section-header convention (ModelModal,
   *  ApiKeysView both lowercase locally today). */
  title: string;
};

/**
 * Dim section header: lowercase title followed by a trailing horizontal rule drawn to the
 * terminal width. The rule uses glyph.separator (─) repeated to fill the container, matching
 * how Spinner already renders the rotating rule frame.
 *
 * Pure presentation — no store, no dispatch. The rule length is clamped at the terminal width
 * minus a 4-cell title gutter so the line never wraps; a wider rule than the container would
 * push the border onto the next line and break the modal's visual frame.
 */
export function SectionTitle({ title }: SectionTitleProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  // 4 cells = 2 for the title's trailing space + 2 for Box gutter/padding around the rule.
  // Measured against ModelModal.tsx's existing section header layout.
  const ruleLen = Math.max(0, cols - title.length - 4);
  const rule = glyph.separator.repeat(ruleLen);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={role.muted}>{title.toLowerCase()}</Text>
        <Text color={role.muted}>{" "}{rule}</Text>
      </Box>
    </Box>
  );
}
