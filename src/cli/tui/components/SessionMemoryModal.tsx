import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import { getDefaultModelId } from "../../../llm/modelRegistry.js";
import { role, glyph } from "../theme.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
  onSessionClear?: (oldSessionId: string) => void;
}

const MEMORY_OPTIONS = [false, true] as const;
const MEMORY_LABELS: Record<string, string> = {
  false: "Off — one-shot, no memory",
  true: "On — inject prior task summary each run (default)",
};

export function SessionMemoryModal({ dispatch, onSessionClear }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.memorySelectedIndex;
  const currentModel = state.modelSettings?.model ?? getDefaultModelId();

  useInput((_input, key) => {
    if (key.escape) {
      dispatch({ type: "MEMORY_MODAL_CLOSE" });
    } else if (key.upArrow) {
      dispatch({ type: "MEMORY_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "MEMORY_NAV", direction: "down" });
    } else if (key.return) {
      if (sel === 2) {
        // Clear: capture old sessionId BEFORE dispatch mutates state, then GC the old .jsonl.
        const oldSessionId = state.sessionId;
        const newSessionId = randomUUID();
        onSessionClear?.(oldSessionId);   // best-effort delete old .jsonl (fire-and-forget)
        dispatch({ type: "SESSION_MEMORY_CLEAR", newSessionId });
      } else {
        const memoryEnabled = MEMORY_OPTIONS[sel] ?? true;
        const updated = state.modelSettings
          ? { ...state.modelSettings, memoryEnabled, updatedAt: new Date().toISOString() }
          : { version: 2 as const, model: currentModel, provider: "anthropic" as const, memoryEnabled, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "MEMORY_APPLY", memoryEnabled });
      }
    }
  });

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 60);
  const currentMemory = state.modelSettings?.memoryEnabled ?? true;  // ?? true matches TUI default

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.accent}
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color={role.accent}> Session memory</Text>
      <Text> </Text>
      {MEMORY_OPTIONS.map((opt, i) => {
        const selected = i === sel;
        const marker = currentMemory === opt ? glyph.radioSelected : glyph.radioUnselected;
        return (
          <Box key={String(opt)} backgroundColor={selected ? role.selectionBackground : undefined}>
            <Text color={selected ? role.emphasis : undefined}>   {marker} {MEMORY_LABELS[String(opt)]}</Text>
          </Box>
        );
      })}
      <Box backgroundColor={sel === 2 ? role.selectionBackground : undefined}>
        <Text color={sel === 2 ? role.emphasis : role.caution}>   ⟳  Clear — start fresh next run</Text>
      </Box>
      <Text> </Text>
      <Text dimColor> {glyph.navigateArrows} navigate · Enter select/clear · Esc cancel</Text>
    </Box>
  );
}
