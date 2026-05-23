import { Box, Text } from "ink";
import { useStore, type RunState } from "../store.js";

function leftText(
  runState: RunState,
  costUsd: number,
  model: string,
  elapsedSec: string | null
): string {
  const m = model || "default";
  switch (runState) {
    case "idle":
      return `idle · ${m} · perm: default`;
    case "running":
      return `$${costUsd.toFixed(4)} · ${m} · perm: default`;
    case "done":
      return `done · $${costUsd.toFixed(4)}${elapsedSec ? ` · ${elapsedSec}s` : ""} · ${m}`;
    case "aborted":
      return `aborted · $${costUsd.toFixed(4)} · ${m}`;
  }
}

function rightHint(runState: RunState): string {
  switch (runState) {
    case "running":
      return "esc abort";
    default:
      return "/help for commands";
  }
}

export function StatusBar(): React.ReactElement {
  const { state } = useStore();
  const { costUsd, model, tokenBudgetRatio } = state.statusBar;
  const { runState, runStartMs } = state;

  const elapsedSec =
    runState === "done" && runStartMs != null
      ? ((Date.now() - runStartMs) / 1000).toFixed(1)
      : null;

  const tokenColor =
    tokenBudgetRatio >= 0.9 ? "red" : tokenBudgetRatio >= 0.7 ? "yellow" : undefined;

  const cols = process.stdout.columns ?? 80;
  const sep = "─".repeat(cols);

  return (
    <Box flexDirection="column">
      <Text dimColor>{sep}</Text>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={tokenColor}>{leftText(runState, costUsd, model, elapsedSec)}</Text>
        <Text dimColor>{rightHint(runState)}</Text>
      </Box>
      <Text dimColor>{sep}</Text>
    </Box>
  );
}
