import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore } from "../store.js";
import { writeDailyUsdCapOverride } from "../../../visual/tierSettings.js";

export function LimitsModal(): React.ReactElement {
  const { state, dispatch } = useStore();
  const currentCap = state.statusBar.capUsd;
  const [input, setInput] = useState(currentCap.toFixed(2));
  const [error, setError] = useState<string | null>(null);

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 52);
  const orgPolicy = !!process.env.ZONE_ORG_POLICY_PATH;

  useInput((ch, key) => {
    if (key.escape) {
      dispatch({ type: "LIMITS_MODAL_CLOSE" });
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color="cyan"> Daily USD Cap</Text>
      <Text> </Text>
      <Text dimColor>Current cap: <Text color="white">${currentCap.toFixed(2)}</Text></Text>
      {orgPolicy && (
        <Text color="yellow">  Note: org policy may override this value.</Text>
      )}
      <Text> </Text>
      <Text>New cap: <Text bold>$</Text>{input}<Text inverse> </Text></Text>
      {error !== null && <Text color="red">  {error}</Text>}
      <Text> </Text>
      <Text dimColor>↵ apply · Esc cancel</Text>
    </Box>
  );
}
