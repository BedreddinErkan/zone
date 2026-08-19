import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { USER_FACING_MODELS, getDefaultModelId } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";
import { role, glyph } from "../theme.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

export function ModelModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.modelSelectedIndex;
  const cols = process.stdout.columns ?? 80;
  const narrow = cols < 60;
  const currentModelId = state.modelSettings?.model ?? getDefaultModelId();
  const visibleModels = USER_FACING_MODELS;
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
      const sectionLabel = m.provider === "anthropic" ? "Anthropic" : "OpenAI";
      rows.push(
        <Text key={`hdr-${m.provider}`} bold color={role.emphasis}> {sectionLabel}</Text>
      );
    }
    const selected = flatIdx === sel;
    const marker = m.id === currentModelId ? glyph.radioSelected : glyph.radioUnselected;
    const bg = selected ? role.selectionBackground : undefined;
    const retentionBadge = m.retention ? ` ⚠ ${m.retention.minDays}d retention` : "";
    const label = narrow
      ? `   ${marker} ${m.id}${retentionBadge}`
      : `   ${marker} ${m.displayName}${m.costNote ? ` — ${m.costNote}` : ""}`;
    rows.push(
      <Box key={m.id} flexDirection="column" backgroundColor={bg}>
        <Text color={selected ? role.emphasis : undefined}>{label}</Text>
        {m.retention && !narrow && (
          <Text dimColor>
            {`      ⚠ Requires ${m.retention.minDays}-day data retention · ` +
             // Read the field rather than asserting it: a model that DOES offer ZDR
             // would otherwise be described as not offering it.
             `${m.retention.zdrAvailable ? "ZDR available" : "ZDR not available"} · ` +
             `longer than the 7-day API default`}
          </Text>
        )}
      </Box>
    );
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.accent}
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color={role.accent}> Model</Text>
      <Text> </Text>
      {rows}
      <Text> </Text>
      <Text dimColor> ↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
