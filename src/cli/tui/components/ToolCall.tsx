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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function ToolCall({ toolName, args, results }: ToolCallProps): React.ReactElement {
  const truncatedArgs = truncate(args, 50);
  const lastResult = results[results.length - 1];

  return (
    <Box justifyContent="space-between">
      <Text color="cyan">{"  "}{toolName}  {truncatedArgs}</Text>
      {lastResult != null ? (
        <Text color={lastResult.ok ? "green" : "red"}>
          {lastResult.ok ? "✓" : "✗"} {lastResult.detail}
        </Text>
      ) : (
        <Text dimColor>…</Text>
      )}
    </Box>
  );
}
