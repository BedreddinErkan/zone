import { Box, Text } from "ink";

export function RunSummary({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Run summary</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor={i > 0}>{line}</Text>
      ))}
    </Box>
  );
}
