import React from "react";
import { Box, Text, useInput } from "ink";
import type { UserHooksConfig, UserHookEntry } from "../../../api/diskHooks.js";

interface HookTrustModalProps {
  config: UserHooksConfig;
  projectPath: string;
  onApprove: () => void;
  onDeny: () => void;
}

function renderHookEntry(entry: UserHookEntry, index: number): React.ReactElement {
  const label = entry.description ? `[${entry.description}]` : `[hook ${index + 1}]`;
  return (
    <Box key={index} paddingLeft={2}>
      <Text>{"● "}</Text>
      <Text color="yellow">{label}</Text>
      <Text>{" "}{entry.command}</Text>
    </Box>
  );
}

export function HookTrustModal({ config, projectPath, onApprove, onDeny }: HookTrustModalProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "a" || input === "A") {
      onApprove();
    } else if (input === "n" || input === "N" || key.escape) {
      onDeny();
    }
  });

  const preHooks = config.hooks.PreToolUse ?? [];
  const postHooks = config.hooks.PostToolUse ?? [];
  const totalCount = preHooks.length + postHooks.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1} marginY={1}>
      <Text bold color="yellow">⚠  Hook Trust Required</Text>
      <Box marginTop={1}>
        <Text>This project defines {totalCount} shell hook{totalCount !== 1 ? "s" : ""} in .zone/hooks.json</Text>
      </Box>
      <Text dimColor>Project: {projectPath}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>These commands will run during agent tool execution:</Text>
      </Box>
      {preHooks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>PreToolUse ({preHooks.length} hook{preHooks.length !== 1 ? "s" : ""}):</Text>
          {preHooks.map((entry, i) => renderHookEntry(entry, i))}
        </Box>
      )}
      {postHooks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>PostToolUse ({postHooks.length} hook{postHooks.length !== 1 ? "s" : ""}):</Text>
          {postHooks.map((entry, i) => renderHookEntry(entry, i))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold color="green">{"[a]"}</Text>
        <Text> Approve and arm  </Text>
        <Text bold color="red">{"[N]"}</Text>
        <Text> Keep disabled</Text>
      </Box>
    </Box>
  );
}
