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
  const lastResult = results[results.length - 1];

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.max(20, cols - 4);
  const narrow = cols < 60;

  if (narrow) {
    const narrowArgsMax = Math.max(10, innerWidth - toolName.length - 4);
    const narrowPreviewMax = Math.max(0, innerWidth - 6);
    return (
      <Box flexDirection="column">
        <Text color="cyan">{"  "}{toolName}  {truncate(args, narrowArgsMax)}</Text>
        {lastResult != null ? (
          lastResult.blocked ? (
            <Text>{"    "}<Text color="yellow">⚠ blocked</Text></Text>
          ) : (() => {
            const { preview, moreLines } = previewDetail(lastResult.detail);
            const shortPreview = truncate(preview, narrowPreviewMax);
            return (
              <Text>{"    "}<Text color={lastResult.ok ? "green" : "red"}>
                {lastResult.ok ? "✓" : "✗"}{shortPreview ? ` ${shortPreview}` : ""}{moreLines > 0 ? ` … ${moreLines} more` : ""}
              </Text></Text>
            );
          })()
        ) : (
          <Text>{"    "}<Text dimColor>…</Text></Text>
        )}
      </Box>
    );
  }

  // Wide layout — pixel-identical to pre-change
  const truncatedArgs = truncate(args, 50);
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
