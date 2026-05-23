import { Text } from "ink";

export function DimLine({ text }: { text: string }): React.ReactElement {
  return <Text dimColor>{text}</Text>;
}
