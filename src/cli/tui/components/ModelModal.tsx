import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { USER_FACING_MODELS, getDefaultModelId } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

export function ModelModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.modelSelectedIndex;
  const cols = process.stdout.columns ?? 80;
  const narrow = cols < 60;
  const currentModelId = state.modelSettings?.model ?? getDefaultModelId();
  const visibleModels = USER_FACING_MODELS.filter(
    m => m.provider !== "gemini" || !!process.env.ZONE_GEMINI_ENABLE
  );
  const count = visibleModels.length;

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "MODEL_MODAL_CLOSE" });
    } else if (key.upArrow) {
      dispatch({ type: "MODEL_NAV", direction: "up", count });
    } else if (key.downArrow) {
      dispatch({ type: "MODEL_NAV", direction: "down", count });
    } else if (key.return) {
      const entry = visibleModels[sel];
      if (entry) {
        const settings: DiskModelSettings = {
          version: 2,
          model: entry.id,
          provider: entry.provider,
          effort: state.modelSettings?.effort,
          updatedAt: new Date().toISOString(),
        };
        void saveDiskModel(process.cwd(), settings);
        dispatch({ type: "MODEL_APPLY", settings });
      }
    }
  });

  const innerWidth = Math.min(cols - 4, 62);
  const rows: React.ReactElement[] = [];
  let lastProvider: string | null = null;

  visibleModels.forEach((m, flatIdx) => {
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      const sectionLabel = m.provider === "anthropic" ? "Anthropic"
        : m.provider === "gemini" ? "Gemini"
        : "OpenAI";
      rows.push(
        <Text key={`hdr-${m.provider}`} bold color="white"> {sectionLabel}</Text>
      );
    }
    const selected = flatIdx === sel;
    const marker = m.id === currentModelId ? "(•)" : "( )";
    const bg = selected ? "blue" : undefined;
    const label = narrow
      ? `   ${marker} ${m.id}`
      : `   ${marker} ${m.displayName}${m.costNote ? ` — ${m.costNote}` : ""}`;
    rows.push(
      <Box key={m.id} backgroundColor={bg}>
        <Text color={selected ? "white" : undefined}>{label}</Text>
      </Box>
    );
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color="cyan"> Model</Text>
      <Text> </Text>
      {rows}
      <Text> </Text>
      <Text dimColor> ↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
