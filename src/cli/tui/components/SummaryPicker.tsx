import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { getDefaultModelId } from "../../../llm/modelRegistry.js";
import { role, glyph } from "../theme.js";

const FORMATS: Array<"compact" | "detailed"> = ["compact", "detailed"];
const FORMAT_LABELS: Record<"compact" | "detailed", string> = {
  compact: "Compact — terse 4-section summary (default)",
  detailed: "Detailed — longer bullets, paragraph Why, Files list",
};

/**
 * Phase 2d — content-only summary format picker. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component.
 */
export function SummaryPicker(): React.ReactElement {
  const { state, dispatch } = useStore();
  const sel = state.summarySelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();
  const currentFormat = state.modelSettings?.summaryFormat ?? "compact";

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "OVERLAY_POP" });
    } else if (key.upArrow) {
      dispatch({ type: "SUMMARY_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "SUMMARY_NAV", direction: "down" });
    } else if (key.return) {
      const summaryFormat = FORMATS[sel];
      if (summaryFormat) {
        const updated = state.modelSettings
          ? { ...state.modelSettings, summaryFormat, updatedAt: new Date().toISOString() }
          : { version: 2 as const, model: currentModel, provider: "anthropic" as const, summaryFormat, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "SUMMARY_APPLY", summaryFormat });
        dispatch({ type: "OVERLAY_POP" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {FORMATS.map((fmt, i) => {
        const selected = i === sel;
        const marker = currentFormat === fmt ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={fmt} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {FORMAT_LABELS[fmt]}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
