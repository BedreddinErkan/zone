import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useStore, type RunState, type TuiMode } from "../store.js";
import { role, glyph } from "../theme.js";

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
  waitedSec: string | null,
  liveElapsedSec: string | null,
): string {
  const m = model || "default";
  const tokStr = cumulativeTokens > 0 ? ` (${formatTokens(cumulativeTokens)} tok)` : "";
  switch (runState) {
    case "idle":
      return `idle · ${m}`;
    case "running":
      return `$${costUsd.toFixed(4)}${tokStr}${liveElapsedSec ? ` · ${liveElapsedSec}s` : ""} · ${m}`;
    case "awaiting_input":
      return `waiting for you · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
    case "done":
      return `done · $${costUsd.toFixed(4)}${tokStr}${elapsedSec ? ` · ${elapsedSec}s` : ""}`
        + `${waitedSec ? ` (+${waitedSec}s waiting on you)` : ""} · ${m}`;
    case "aborted":
      return `aborted · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
    case "failed":
      return `error · $${costUsd.toFixed(4)}${tokStr} · ${m}`;
  }
}

function rightHint(runState: RunState, questionKind: "live" | "carried" | null): string {
  switch (runState) {
    case "running":
      return "esc abort";
    case "awaiting_input":
      // Esc here never aborts the run — but it means two different things one
      // state apart, so the hint has to say which. Live: the run continues
      // without an answer. Carried: the whole suspended conversation is set
      // aside, which is the heavier of the two and must not read as "skip".
      return questionKind === "carried" ? "esc set aside" : "esc skip question";
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
  const { runState, runStartMs, runEndMs, parkedMs, mode } = state;
  // webSearch defaults ON (absence = enabled); show indicator when active
  const webSearch = state.modelSettings?.webSearchEnabled !== false;

  // Per-task execution time: start (task begin) → end (task complete), frozen at
  // completion so it doesn't keep ticking while the "done" status is displayed.
  // Parked time is the user's, not the run's. Subtracting it keeps this figure
  // comparable across runs that did and did not stop to ask something; it is
  // surfaced separately below so wall-clock stays derivable.
  const elapsedSec =
    (runState === "done" || runState === "failed") && runStartMs != null && runEndMs != null
      ? (Math.max(0, runEndMs - runStartMs - parkedMs) / 1000).toFixed(1)
      : null;
  const waitedSec = elapsedSec != null && parkedMs > 0 ? (parkedMs / 1000).toFixed(1) : null;

  // Live ticker, running only — not isRunInFlight (which also covers
  // awaiting_input): parkedMs banks a park's duration only once it ends, so
  // ticking through an active park would show raw wall-clock including the
  // pending wait, against parkedMs's own purpose (store-core.ts:121-129).
  // New per-second re-render pressure for the run's duration — Spinner's own
  // timer is local to Spinner and never touches the store, so this does not
  // ride along with it for free.
  //
  // Also frozen while a human decision is pending (plan-ready, staged-diffs,
  // or a command/edit/trust approval): runState stays "running" through all
  // three — none of their reducer cases touch it — so without this guard the
  // 1Hz re-render continues the whole time the proposal sits waiting, which
  // is what was destroying mouse selection during plan approval. A pending
  // approval is a waiting state, not a working one; nothing needs animating.
  const runBlockedOnHuman =
    state.modalView === "plan_ready" || state.modalView === "staged_diffs" || state.pendingApproval !== null;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (runState !== "running" || runBlockedOnHuman) return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [runState, runBlockedOnHuman]);
  const liveElapsedSec =
    runState === "running" && runStartMs != null
      ? (Math.max(0, Date.now() - runStartMs - parkedMs) / 1000).toFixed(1)
      : null;

  const tokenColor =
    tokenBudgetRatio >= 0.9 ? role.danger : tokenBudgetRatio >= 0.7 ? role.caution : undefined;

  const cols = process.stdout.columns ?? 80;
  const sep = glyph.separator.repeat(cols);
  const narrow = cols < 60;
  const pill = modePill(mode, narrow);
  const pillColor: typeof role.caution | typeof role.accent = mode === "autoAccept" ? role.caution : role.accent;

  const modelLabel = model || "default";
  // Absent for models that don't support effort (EffortModal.tsx:52's own read pattern).
  const effort = state.modelSettings?.effort;
  const effortStr = effort ? ` · effort: ${effort}` : "";
  const usedStr = dailyUsedUsd > 0 ? ` · used $${dailyUsedUsd.toFixed(2)}` : "";
  const badgeLine = `${modelLabel}${effortStr}${usedStr} · cap $${(capUsd ?? 10).toFixed(2)}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{sep}</Text>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={tokenColor}>{leftText(runState, costUsd, model, elapsedSec, cumulativeTokens, waitedSec, liveElapsedSec)}{webSearch ? " · [W]" : ""}</Text>
        {pill ? <Text color={pillColor}>{pill}</Text> : null}
        <Text dimColor>{rightHint(runState, state.pendingQuestion?.kind ?? null)}</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{badgeLine}</Text>
      </Box>
      <Text dimColor>{sep}</Text>
    </Box>
  );
}
