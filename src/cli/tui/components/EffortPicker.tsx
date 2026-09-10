import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { supportsEffort, getDefaultModelId, effortLevelsFor } from "../../../llm/modelRegistry.js";
import type { EffortLevel } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { role, glyph, spacing } from "../theme.js";

const ALL_EFFORT_LABELS: Record<EffortLevel, string> = {
  low:    "Low — Faster, less deliberation",
  medium: "Medium — Balanced (default)",
  high:   "High — Slower, deeper analysis",
  xhigh:  "XHigh — Extended reasoning (not supported by every model)",
  max:    "Max — Maximum reasoning budget",
};

/**
 * Phase 2d — content-only effort picker. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads the same slice
 * of state EffortModal.tsx reads; dispatches OVERLAY_POP on Esc instead of
 * EFFORT_MODAL_CLOSE so the central stack owns the lifecycle.
 */
export function EffortPicker(): React.ReactElement {
  const { state, dispatch } = useStore();
  const sel = state.effortSelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();
  const modelSupports = supportsEffort(currentModel);
  const EFFORTS = effortLevelsFor(currentModel);
  const currentEffort = state.modelSettings?.effort;

  useInput((_input, key) => {
    // Esc handled by central handler (Phase 3b).
    if (key.upArrow) {
      dispatch({ type: "EFFORT_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "EFFORT_NAV", direction: "down" });
    } else if (key.return) {
      const effort = EFFORTS[sel];
      if (effort) {
        const updated = state.modelSettings
          ? { ...state.modelSettings, effort, updatedAt: new Date().toISOString() }
          : { version: 2 as const, model: currentModel, provider: "anthropic" as const, effort, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "EFFORT_APPLY", effort });
        dispatch({ type: "OVERLAY_POP" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {EFFORTS.map((effort, i) => {
        const selected = i === sel;
        const marker = currentEffort === effort ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={effort} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {ALL_EFFORT_LABELS[effort]}</Text>
          </Box>
        );
      })}
      <Box marginTop={spacing.sm}>
        <Text> Current model: <Text bold>{currentModel}</Text></Text>
      </Box>
      {modelSupports
        ? <Text color={role.success}> Supports effort: yes</Text>
        : <Text color={role.caution}> Does not use effort (preference saved for later)</Text>
      }
    </Box>
  );
}
