import { Box, Text } from "ink";

interface ToolResultEntry {
  ok: boolean;
  detail: string;
  blocked?: true;
}

interface ToolCallProps {
  toolName: string;
  args: string;
  results: ToolResultEntry[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function previewDetail(detail: string): { preview: string; moreLines: number } {
  const lines = detail.split("\n").filter(Boolean);
  if (lines.length <= 3) return { preview: lines.join(" · "), moreLines: 0 };
  return { preview: lines.slice(0, 3).join(" · "), moreLines: lines.length - 3 };
}

export function ToolCall({ toolName, args, results }: ToolCallProps): React.ReactElement {
  const truncatedArgs = truncate(args, 50);
  const lastResult = results[results.length - 1];

  return (
    <Box justifyContent="space-between">
      <Text color="cyan">{"  "}{toolName}  {truncatedArgs}</Text>
      {lastResult != null ? (
        lastResult.blocked ? (
          <Text color="yellow">⚠ blocked</Text>
        ) : (() => {
          const { preview, moreLines } = previewDetail(lastResult.detail);
          return (
            <Text color={lastResult.ok ? "green" : "red"}>
              {lastResult.ok ? "✓" : "✗"}{preview ? ` ${preview}` : ""}{moreLines > 0 ? ` … ${moreLines} more` : ""}
            </Text>
          );
        })()
      ) : (
        <Text dimColor>…</Text>
      )}
    </Box>
  );
}
