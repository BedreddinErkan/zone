import React from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { getDefaultModelId } from "../../../llm/modelRegistry.js";
import { role, glyph } from "../theme.js";

const MEMORY_OPTIONS = [false, true] as const;
const MEMORY_LABELS: Record<string, string> = {
  false: "Off — one-shot, no memory",
  true: "On — inject prior task summary each run (default)",
};

/**
 * Phase 2d — content-only session memory picker. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component. The "Clear" option
 * (index 2) resets the session and generates a new session id.
 */
export function SessionMemoryPicker(): React.ReactElement {
  const { state, dispatch } = useStore();
  const sel = state.memorySelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();
  const currentMemory = state.modelSettings?.memoryEnabled ?? true;

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "OVERLAY_POP" });
    } else if (key.upArrow) {
      dispatch({ type: "MEMORY_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "MEMORY_NAV", direction: "down" });
    } else if (key.return) {
      if (sel === 2) {
        const newSessionId = randomUUID();
        dispatch({ type: "SESSION_MEMORY_CLEAR", newSessionId });
        dispatch({ type: "OVERLAY_POP" });
      } else {
        const memoryEnabled = MEMORY_OPTIONS[sel] ?? true;
        const updated = state.modelSettings
          ? { ...state.modelSettings, memoryEnabled, updatedAt: new Date().toISOString() }
          : { version: 2 as const, model: currentModel, provider: "anthropic" as const, memoryEnabled, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "MEMORY_APPLY", memoryEnabled });
        dispatch({ type: "OVERLAY_POP" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {MEMORY_OPTIONS.map((opt, i) => {
        const selected = i === sel;
        const marker = currentMemory === opt ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={String(opt)} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {MEMORY_LABELS[String(opt)]}</Text>
          </Box>
        );
      })}
      <Box backgroundColor={sel === 2 ? role.selectionBackground : undefined}>
        <Text color={sel === 2 ? role.selectionForeground : role.caution}>   ⟳  Clear — start fresh next run</Text>
      </Box>
    </Box>
  );
}
