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
import { DiffView } from "./DiffView.js";
import { CommandTail } from "./CommandTail.js";

const BASH_TOOLS = new Set(["run_command", "run_command_background", "run_command_readonly"]);

interface ToolResultEntry {
  ok: boolean;
  detail: string;
  blocked?: true;
}

interface ToolCallProps {
  toolName: string;
  args: string;
  results: ToolResultEntry[];
  patch?: string;
}

export function ToolCall({ toolName, args, results, patch }: ToolCallProps): React.ReactElement {
  const isBash = BASH_TOOLS.has(toolName);
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

  let secondLine: string | null = null;
  let secondLineColor: "red" | "yellow" | undefined = undefined;
  if (lastResult?.blocked) {
    secondLine = inlineMsg ? `blocked: ${inlineMsg}` : "blocked";
    secondLineColor = "yellow";
  } else if (lastResult && !lastResult.ok) {
    secondLine = isBash ? null : inlineMsg;
    secondLineColor = isBash ? undefined : "red";
  } else {
    secondLine = (toolName === "apply_patch" && patch) || isBash ? null : successPreview;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={glyph.color}>{glyph.icon} </Text>
        <Text>{display}({formattedArgs})</Text>
        {lastResult?.ok && !lastResult.blocked && metadata && (
          <Text dimColor> {metadata}</Text>
        )}
      </Box>
      {secondLine && (
        <Box paddingLeft={2}>
          {secondLineColor ? (
            <Text color={secondLineColor}>└ {secondLine}</Text>
          ) : (
            <Text dimColor>└ {secondLine}</Text>
          )}
        </Box>
      )}
      {toolName === "apply_patch" && patch && lastResult?.ok && !lastResult.blocked && (
        <Box paddingLeft={2}>
          <DiffView patch={patch} />
        </Box>
      )}
      {isBash && lastResult && !lastResult.blocked && (
        <Box paddingLeft={2}>
          <CommandTail detail={lastResult.detail} ok={lastResult.ok} />
        </Box>
      )}
    </Box>
  );
}
