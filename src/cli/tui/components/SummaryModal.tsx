import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { getDefaultModelId } from "../../../llm/modelRegistry.js";
import { role, glyph } from "../theme.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

const FORMATS: Array<"compact" | "detailed"> = ["compact", "detailed"];
const FORMAT_LABELS: Record<"compact" | "detailed", string> = {
  compact: "Compact — terse 4-section summary (default)",
  detailed: "Detailed — longer bullets, paragraph Why, Files list",
};

export function SummaryModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.summarySelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "SUMMARY_MODAL_CLOSE" });
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
      }
    }
  });

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 60);
  const currentFormat = state.modelSettings?.summaryFormat ?? "compact";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.accent}
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color={role.accent}> Summary format</Text>
      <Text> </Text>
      {FORMATS.map((fmt, i) => {
        const selected = i === sel;
        const marker = currentFormat === fmt ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={fmt} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {FORMAT_LABELS[fmt]}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor> {glyph.navigateArrows} navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
