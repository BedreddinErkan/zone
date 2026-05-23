import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { classifyTokenBudgetStatus } from "../../../core/eventProcessors.js";

export function StatusBar(): React.ReactElement {
  const { state } = useStore();
  const { iter, costUsd, model, tokenBudgetRatio } = state.statusBar;
  const status = classifyTokenBudgetStatus(tokenBudgetRatio);

  const color = status === "critical" ? "red" : status === "warning" ? "yellow" : undefined;

  const parts = [
    `iter ${iter}`,
    `$${costUsd.toFixed(4)}`,
    model || "default",
  ];

  return (
    <Box>
      <Text dimColor>[</Text>
      <Text color={color}>{parts.join(" · ")}</Text>
      <Text dimColor>]</Text>
    </Box>
  );
}
