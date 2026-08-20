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

const DEPTHS: Array<"quick" | "strict"> = ["quick", "strict"];
const DEPTH_LABELS: Record<"quick" | "strict", string> = {
  quick:  "Plan-first (default) — prose plan, approve, execute once",
  strict: "Strict — staged diff checkpoint before flush (opt-in)",
};

export function PlanModeModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.planModeSelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "PLANMODE_MODAL_CLOSE" });
    } else if (key.upArrow) {
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
      }
    }
  });

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 60);
  const rawDepth = state.modelSettings?.planDepth ?? "quick";
  const currentDepth: "quick" | "strict" = rawDepth === "investigate" ? "strict" : (rawDepth as "quick" | "strict");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.accent}
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color={role.accent}> Plan depth</Text>
      <Text> </Text>
      {DEPTHS.map((d, i) => {
        const selected = i === sel;
        const marker = currentDepth === d ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={d} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.selectionForeground : undefined}>   {marker} {DEPTH_LABELS[d]}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor> {glyph.navigateArrows} navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
