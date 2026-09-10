import React from "react";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore } from "../store.js";
import { writeDailyUsdCapOverride } from "../../../visual/tierSettings.js";
import { role, spacing } from "../theme.js";

/**
 * Phase 2d — content-only spending limits editor. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component.
 */
export function LimitsEditor(): React.ReactElement {
  const { state, dispatch } = useStore();
  const currentCap = state.statusBar.capUsd;
  const [input, setInput] = useState(currentCap.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const orgPolicy = !!process.env.ZONE_ORG_POLICY_PATH;

  useInput((ch, key) => {
    if (key.escape) {
      dispatch({ type: "OVERLAY_POP" });
      return;
    }
    if (key.return) {
      const n = parseFloat(input);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        setError("Must be a positive number ≤ 1000");
        return;
      }
      writeDailyUsdCapOverride(n);
      dispatch({ type: "LIMITS_APPLY", capUsd: n });
      dispatch({ type: "OVERLAY_POP" });
      return;
    }
    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1));
      setError(null);
      return;
    }
    if (/^\d$/.test(ch)) {
      setInput(s => s + ch);
      setError(null);
      return;
    }
    if (ch === "." && !input.includes(".")) {
      setInput(s => s + ch);
      setError(null);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>Current cap: <Text color={role.emphasis}>${currentCap.toFixed(2)}</Text></Text>
      {orgPolicy && (
        <Text color={role.caution}>  Note: org policy may override this value.</Text>
      )}
      <Box marginTop={spacing.sm}>
        <Text>New cap: <Text bold>$</Text>{input}<Text inverse> </Text></Text>
      </Box>
      {error !== null && <Text color={role.danger}>  {error}</Text>}
    </Box>
  );
}
