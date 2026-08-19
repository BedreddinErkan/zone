import { Text } from "ink";
import { glyph } from "../theme.js";

export function IterMarker({ phase }: { phase: string }): React.ReactElement {
  const sep = glyph.separator + glyph.separator;
  return <Text dimColor>{`${sep} Phase ${phase} ${sep}`}</Text>;
}
