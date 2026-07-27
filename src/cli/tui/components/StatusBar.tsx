import { Box, Text } from "ink";
import { useStore, type RunState, type TuiMode } from "../store.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function leftText(
  runState: RunState,
  costUsd: number,
  model: string,
  elapsedSec: string | null,
  cumulativeTokens: number,
): string {
  const m = model || "default";
  const tokStr = cumulativeTokens > 0 ? ` (${formatTokens(cumulativeTokens)} tok)` : "";
  switch (runState) {
    case "idle":
      return `idle · ${m} · perm: default`;
    case "running":
      return `$${costUsd.toFixed(4)}${tokStr} · ${m} · perm: default`;
    case "awaiting_input":
      return `waiting for you · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
    case "done":
      return `done · $${costUsd.toFixed(4)}${tokStr}${elapsedSec ? ` · ${elapsedSec}s` : ""} · ${m}`;
    case "aborted":
      return `aborted · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
    case "failed":
      return `error · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
  }
}

function rightHint(runState: RunState): string {
  switch (runState) {
    case "running":
      return "esc abort";
    case "awaiting_input":
      // Esc here skips the question, it does not abort the run — the hint has to
      // say which, because the same key means the other thing one state away.
      return "esc skip question";
    default:
      return "/help for commands";
  }
}

function modePill(m: TuiMode, narrow: boolean): string | null {
  if (m === "normal") return null;
  if (narrow) return m === "autoAccept" ? "[A]" : "[P]";
  return m === "autoAccept" ? "auto" : "plan";
}

export function StatusBar(): React.ReactElement {
  const { state } = useStore();
  const { costUsd, dailyUsedUsd, model, tokenBudgetRatio, cumulativeTokens, capUsd } = state.statusBar;
  const { runState, runStartMs, runEndMs, mode } = state;
  // webSearch defaults ON (absence = enabled); show indicator when active
  const webSearch = state.modelSettings?.webSearchEnabled !== false;

  // Per-task execution time: start (task begin) → end (task complete), frozen at
  // completion so it doesn't keep ticking while the "done" status is displayed.
  const elapsedSec =
    (runState === "done" || runState === "failed") && runStartMs != null && runEndMs != null
      ? ((runEndMs - runStartMs) / 1000).toFixed(1)
      : null;

  const tokenColor =
    tokenBudgetRatio >= 0.9 ? "red" : tokenBudgetRatio >= 0.7 ? "yellow" : undefined;

  const cols = process.stdout.columns ?? 80;
  const sep = "─".repeat(cols);
  const narrow = cols < 60;
  const pill = modePill(mode, narrow);
  const pillColor: "yellow" | "cyan" = mode === "autoAccept" ? "yellow" : "cyan";

  const modelLabel = model || "default";
  const usedStr = dailyUsedUsd > 0 ? ` · used $${dailyUsedUsd.toFixed(2)}` : "";
  const badgeLine = `${modelLabel}${usedStr} · cap $${(capUsd ?? 10).toFixed(2)}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{sep}</Text>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={tokenColor}>{leftText(runState, costUsd, model, elapsedSec, cumulativeTokens)}{webSearch ? " · [W]" : ""}</Text>
        {pill ? <Text color={pillColor}>{pill}</Text> : null}
        <Text dimColor>{rightHint(runState)}</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{badgeLine}</Text>
      </Box>
      <Text dimColor>{sep}</Text>
    </Box>
  );
}
