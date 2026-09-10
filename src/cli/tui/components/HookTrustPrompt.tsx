import React from "react";
import { Box, Text, useInput } from "ink";
import type { UserHookEntry } from "../../../api/diskHooks.js";
import { useStore } from "../store.js";
import { role, glyph, spacing } from "../theme.js";

function renderHookEntry(entry: UserHookEntry, index: number): React.ReactElement {
  const label = entry.description ? `[${entry.description}]` : `[hook ${index + 1}]`;
  return (
    <Box key={index} paddingLeft={spacing.md}>
      <Text>{glyph.groupMarker} </Text>
      <Text color={role.caution}>{label}</Text>
      <Text>{" "}{entry.command}</Text>
    </Box>
  );
}

/**
 * Phase 2d — content-only hook trust prompt. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads pendingHookTrust
 * from the store; records trust on approve, denies on deny/Esc.
 */
export function HookTrustPrompt(): React.ReactElement | null {
  const { state, dispatch } = useStore();
  const pending = state.pendingHookTrust;
  if (!pending) return null;

  const { config, projectPath } = pending;

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      import("../../../api/diskTrustedHooks.js").then(({ recordHooksTrust }) => {
        if (state.pendingHookTrust) {
          recordHooksTrust(state.pendingHookTrust.projectPath, state.pendingHookTrust.hash);
        }
        dispatch({ type: "HOOKS_TRUST_APPROVED", hash: pending.hash, projectPath: pending.projectPath });
        dispatch({ type: "OVERLAY_POP" });
      }).catch(() => {
        dispatch({ type: "HOOKS_TRUST_DENIED" });
        dispatch({ type: "OVERLAY_POP" });
      });
    } else if (input === "n" || input === "N" || key.escape) {
      dispatch({ type: "HOOKS_TRUST_DENIED" });
      dispatch({ type: "OVERLAY_POP" });
    }
  });

  const preHooks = config.hooks.PreToolUse ?? [];
  const postHooks = config.hooks.PostToolUse ?? [];
  const totalCount = preHooks.length + postHooks.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>This project defines {totalCount} shell hook{totalCount !== 1 ? "s" : ""} in .zone/hooks.json</Text>
      </Box>
      <Text dimColor>Project: {projectPath}</Text>
      <Box marginTop={spacing.sm} flexDirection="column">
        <Text dimColor>These commands will run during agent tool execution:</Text>
      </Box>
      {preHooks.length > 0 && (
        <Box flexDirection="column" marginTop={spacing.sm}>
          <Text bold>PreToolUse ({preHooks.length} hook{preHooks.length !== 1 ? "s" : ""}):</Text>
          {preHooks.map((entry, i) => renderHookEntry(entry, i))}
        </Box>
      )}
      {postHooks.length > 0 && (
        <Box flexDirection="column" marginTop={spacing.sm}>
          <Text bold>PostToolUse ({postHooks.length} hook{postHooks.length !== 1 ? "s" : ""}):</Text>
          {postHooks.map((entry, i) => renderHookEntry(entry, i))}
        </Box>
      )}
      <Box marginTop={spacing.sm}>
        <Text bold color={role.success}>{"[y]"}</Text>
        <Text> Approve and arm  </Text>
        <Text bold color={role.danger}>{"[N]"}</Text>
        <Text> Keep disabled</Text>
      </Box>
    </Box>
  );
}
