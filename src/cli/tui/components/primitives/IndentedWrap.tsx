import React from "react";
import { Box, Text } from "ink";

export type IndentedWrapProps = {
  /** Text to render. Ink's Box wraps it at the container boundary; every wrapped line starts
   *  at the paddingLeft column, not column 0 — that's the column-0 wrap defect this
   *  primitive exists to fix (model picker's long option descriptions). */
  text: string;
  /** Indent in cells. paddingLeft on the Box, which Ink honours on every wrapped line. */
  indent: number;
};

/**
 * Free-text block whose wrapped continuation lines keep alignment with the first line.
 *
 * The defect this addresses: ModelModal's option descriptions were rendered as a single
 * `<Text>{text}</Text>` inside an unindented Box. When a description exceeded the container
 * width, Ink wrapped it at column 0 — the first line was prefixed (by the row's own cursor)
 * but every wrapped line had no prefix, which read as a broken bullet list. Wrapping the text
 * in a Box whose own paddingLeft equals the prefix width fixes the alignment for free: Ink's
 * layout engine re-indents every wrapped line to the Box's content column.
 */
export function IndentedWrap({ text, indent }: IndentedWrapProps): React.ReactElement {
  return (
    <Box paddingLeft={indent}>
      <Text>{text}</Text>
    </Box>
  );
}
