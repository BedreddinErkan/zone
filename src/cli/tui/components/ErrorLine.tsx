import { Text } from "ink";
import { role, glyph } from "../theme.js";

export function ErrorLine({ text }: { text: string }): React.ReactElement {
  return <Text color={role.danger}>{glyph.warningMark} {text}</Text>;
}
