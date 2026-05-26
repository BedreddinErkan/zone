import React from "react";
import { Box, Text } from "ink";
import {
  getToolDisplayName,
  formatToolArgs,
  getStatusGlyph,
  shouldShowPreview,
  formatMetadata,
  formatPreview,
} from "./toolCallFormat.js";

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

export function ToolCall({ toolName, args, results }: ToolCallProps): React.ReactElement {
  const lastResult = results[results.length - 1] ?? null;
  const display = getToolDisplayName(toolName);
  const formattedArgs = formatToolArgs(toolName, args);
  const glyph = getStatusGlyph(lastResult);
  const metadata = formatMetadata(toolName, lastResult);
  const successPreview =
    lastResult?.ok && !lastResult.blocked && shouldShowPreview(toolName, lastResult)
      ? formatPreview(lastResult)
      : null;
  const inlineMsg =
    lastResult && (!lastResult.ok || lastResult.blocked) ? formatPreview(lastResult) : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={glyph.color}>{glyph.icon} </Text>
        <Text>{display}({formattedArgs})</Text>
        {lastResult?.blocked && (
          <Text color="yellow"> blocked{inlineMsg ? `: ${inlineMsg}` : ""}</Text>
        )}
        {lastResult && !lastResult.ok && !lastResult.blocked && inlineMsg && (
          <Text color="red"> {inlineMsg}</Text>
        )}
        {lastResult?.ok && !lastResult.blocked && metadata && (
          <Text dimColor> {metadata}</Text>
        )}
      </Box>
      {successPreview && (
        <Box paddingLeft={2}>
          <Text dimColor>{successPreview}</Text>
        </Box>
      )}
    </Box>
  );
}
