import { Text } from "ink";

export function ErrorLine({ text }: { text: string }): React.ReactElement {
  return <Text color="red">{text}</Text>;
}
