import { Box, Text } from "ink";

interface ToolResultEntry {
  ok: boolean;
  detail: string;
}

interface ToolCallProps {
  toolName: string;
  args: string;
  results: ToolResultEntry[];
}

export function ToolCall({ toolName, args, results }: ToolCallProps): React.ReactElement {
  const truncatedArgs = args.length > 60 ? args.slice(0, 57) + "..." : args;

  return (
    <Box flexDirection="column">
      <Text color="cyan">{`▸ ${toolName}(${truncatedArgs})`}</Text>
      {results.map((r, i) => (
        <Box key={i} marginLeft={2}>
          <Text color={r.ok ? "green" : "red"}>{r.ok ? "✓" : "✗"} </Text>
          <Text dimColor>{r.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ToolResult({ ok, detail }: ToolResultEntry): React.ReactElement {
  return (
    <Box marginLeft={2}>
      <Text color={ok ? "green" : "red"}>{ok ? "✓" : "✗"} </Text>
      <Text dimColor>{detail}</Text>
    </Box>
  );
}
