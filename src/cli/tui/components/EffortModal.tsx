import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { supportsEffort, getDefaultModelId, effortLevelsFor } from "../../../llm/modelRegistry.js";
import type { EffortLevel } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

const ALL_EFFORT_LABELS: Record<EffortLevel, string> = {
  low:   "Low — Faster, less deliberation",
  medium: "Medium — Balanced (default)",
  high:  "High — Slower, deeper analysis",
  xhigh: "XHigh — Extended reasoning (Opus/Fable only)",
  max:   "Max — Maximum reasoning budget",
};

export function EffortModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.effortSelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();
  const modelSupports = supportsEffort(currentModel);
  const EFFORTS = effortLevelsFor(currentModel);

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "EFFORT_MODAL_CLOSE" });
    } else if (key.upArrow) {
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
      }
    }
  });

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 56);
  const currentEffort = state.modelSettings?.effort;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color="cyan"> Reasoning effort</Text>
      <Text> </Text>
      {EFFORTS.map((effort, i) => {
        const selected = i === sel;
        const marker = currentEffort === effort ? "(•)" : "( )";
        return (
          <Box key={effort} backgroundColor={selected ? "blue" : undefined}>
            <Text color={selected ? "white" : undefined}>   {marker} {ALL_EFFORT_LABELS[effort]}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text> Current model: <Text bold>{currentModel}</Text></Text>
      {modelSupports
        ? <Text color="green"> Supports effort: yes</Text>
        : <Text color="yellow"> Does not use effort (preference saved for later)</Text>
      }
      <Text> </Text>
      <Text dimColor> ↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
