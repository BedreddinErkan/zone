import { Text } from "ink";

export function IterMarker({ phase }: { phase: string }): React.ReactElement {
  return <Text dimColor>{`── Phase ${phase} ──`}</Text>;
}
