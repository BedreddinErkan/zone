import React from "react";
import { Text } from "ink";
import { useStore } from "../store.js";
import { role, glyph } from "../theme.js";

/**
 * Phase 6c — one-line live cursor for the active plan/todo state.
 *
 * HARD INVARIANT: this component renders exactly ONE line regardless of
 * todo count or terminal width. The full plan checklist is committed to
 * <Static> via plan_snapshot entries in the transcript; this cursor only
 * shows the live progress summary.
 *
 * Returns null when no todos exist or the run is not active.
 */
export function PlanCursor(): React.ReactElement | null {
  const { state } = useStore();
  const todos = state.todos;
  if (todos.length === 0) return null;
  if (state.runState !== "running" && state.runState !== "awaiting_input") return null;

  const completed = todos.filter(t => t.status === "completed").length;
  const active = todos.find(t => t.status === "in_progress");
  const total = todos.length;

  let label = `${completed}/${total}`;
  if (active) {
    // Truncate active step text to keep the line within one row
    const maxTextLen = 40;
    const stepText = active.text.length > maxTextLen
      ? active.text.slice(0, maxTextLen - 1) + "…"
      : active.text;
    label += ` · ${stepText}`;
  }

  return <Text color={role.muted}>{glyph.selectionCursor}{label}</Text>;
}
