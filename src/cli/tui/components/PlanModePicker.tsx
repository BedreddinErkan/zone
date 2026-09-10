import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { getDefaultModelId } from "../../../llm/modelRegistry.js";
import { role, glyph } from "../theme.js";

const DEPTHS: Array<"quick" | "strict"> = ["quick", "strict"];
const DEPTH_LABELS: Record<"quick" | "strict", string> = {
  quick:  "Plan-first (default) — prose plan, approve, execute once",
  strict: "Strict — staged diff checkpoint before flush (opt-in)",
};

/**
 * Phase 2d — content-only plan depth picker. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component.
 */
export function PlanModePicker(): React.ReactElement {
  const { state, dispatch } = useStore();
  const sel = state.planModeSelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();
  const rawDepth = state.modelSettings?.planDepth ?? "quick";
  const currentDepth: "quick" | "strict" = rawDepth === "investigate" ? "strict" : (rawDepth as "quick" | "strict");

  useInput((_input, key) => {
    // Esc handled by central handler (Phase 3b).
    if (key.upArrow) {
      dispatch({ type: "PLANMODE_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "PLANMODE_NAV", direction: "down" });
    } else if (key.return) {
      const planDepth = DEPTHS[sel];
      if (planDepth) {
        const updated = state.modelSettings
          ? { ...state.modelSettings, planDepth, updatedAt: new Date().toISOString() }
          : { version: 2 as const, model: currentModel, provider: "anthropic" as const, planDepth, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "PLANMODE_APPLY", planDepth });
        dispatch({ type: "OVERLAY_POP" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {DEPTHS.map((d, i) => {
        const selected = i === sel;
        const marker = currentDepth === d ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={d} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {DEPTH_LABELS[d]}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
