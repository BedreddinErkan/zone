import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect } from "react";
import { randomUUID } from "node:crypto";
import { useStore } from "../store.js";
import { USER_FACING_MODELS, getDefaultModelId } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";
import { role, glyph, spacing } from "../theme.js";
import { visibleModelRows, hiddenRowCount } from "../modelPickerList.js";

/**
 * Phase 2c — content-only model picker. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads the same slice
 * of state ModelModal.tsx reads so the list, selection cursor, and custom-input sub-flow
 * behave identically; dispatches OVERLAY_POP on Esc instead of MODEL_MODAL_CLOSE so the
 * central stack — not a per-modal flag — is what closes.
 *
 * Kept separate from ModelModal.tsx (which still exists, with its own chrome, because
 * ModelModal.custom.test.tsx and ModelModal.retention.test.tsx render it directly).
 * Phase 2d will retire ModelModal.tsx once those tests point at this component.
 */
export function ModelPicker(): React.ReactElement {
  const { state, dispatch } = useStore();
  const { stdout } = useStdout();
  const sel = state.modelSelectedIndex;
  const cols = stdout.columns ?? 80;
  const narrow = cols < 60;
  const currentModelId = state.modelSettings?.model ?? getDefaultModelId();
  const visibleModels = visibleModelRows(USER_FACING_MODELS, state.providersWithKey, currentModelId);
  const hidden = hiddenRowCount(USER_FACING_MODELS, visibleModels);
  const count = visibleModels.length;

  const customMode = state.modelCustomMode;
  const customInput = state.modelCustomInput;
  const gateways = state.gatewayIds;
  const inSubMenu = customMode !== "none";

  // Phase 3b — report sub-mode so the central Esc handler defers while the user is
  // typing a custom model id or picking a gateway.
  useEffect(() => {
    dispatch(inSubMenu ? { type: "OVERLAY_SUBMODE_OPEN" } : { type: "OVERLAY_SUBMODE_CLOSE" });
  }, [inSubMenu, dispatch]);

  const applyModel = (model: string, provider: string): void => {
    const settings: DiskModelSettings = {
      ...state.modelSettings,
      version: 2,
      model,
      provider,
      effort: state.modelSettings?.effort,
      updatedAt: new Date().toISOString(),
    };
    void saveDiskModel(process.cwd(), settings);
    dispatch({ type: "MODEL_APPLY", settings });
    dispatch({ type: "OVERLAY_POP" });
  };

  useInput((input, key) => {
    if (customMode === "input") {
      if (key.escape) { dispatch({ type: "MODEL_CUSTOM_CANCEL" }); return; }
      if (key.return) {
        const typed = customInput.trim();
        if (!typed) { dispatch({ type: "MODEL_CUSTOM_CANCEL" }); return; }
        if (gateways.length === 0) {
          dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), level: "error",
            message: "No gateway configured — /keys → [G]ateway first, then this id can be routed." } });
          dispatch({ type: "MODEL_CUSTOM_CANCEL" });
          return;
        }
        if (gateways.length > 1) { dispatch({ type: "MODEL_CUSTOM_PICK_GATEWAY" }); return; }
        applyModel(typed, gateways[0]!);
        return;
      }
      if (key.backspace || key.delete) { dispatch({ type: "MODEL_CUSTOM_BACKSPACE" }); return; }
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        dispatch({ type: "MODEL_CUSTOM_CHAR", ch: input }); return;
      }
      return;
    }
    if (customMode === "pick-gateway") {
      if (key.escape) { dispatch({ type: "MODEL_CUSTOM_CANCEL" }); return; }
      if (key.upArrow) { dispatch({ type: "MODEL_GATEWAY_NAV", direction: "up" }); return; }
      if (key.downArrow) { dispatch({ type: "MODEL_GATEWAY_NAV", direction: "down" }); return; }
      if (key.return) {
        const chosen = gateways[state.modelGatewayIndex];
        if (chosen) applyModel(customInput.trim(), chosen);
      }
      return;
    }
    // Normal mode — Esc falls through to central handler (Phase 3b).
    if (key.upArrow) {
      dispatch({ type: "MODEL_NAV", direction: "up", count });
    } else if (key.downArrow) {
      dispatch({ type: "MODEL_NAV", direction: "down", count });
    } else if (input === "c" || input === "C") {
      dispatch({ type: "MODEL_CUSTOM_START" });
    } else if (key.return) {
      const entry = visibleModels[sel];
      if (entry) applyModel(entry.id, entry.provider);
    }
  });

  // Build rows with proper selection tracking: header rows do not participate in `sel`,
  // which indexes only the visibleModels array. We compute per-model selected state from
  // the flat index, not from how many JSX rows we've emitted.
  const rows: React.ReactElement[] = [];
  let lastProvider: string | null = null;
  // Shell chrome (10), status (4), and the two informational lines are
  // reserved. Each option needs at most a header, label and disclosure row.
  const windowSize = Math.max(1, Math.floor(((stdout.rows ?? 24) - 16) / 3));
  const start = Math.max(0, Math.min(sel - Math.floor(windowSize / 2), count - windowSize));

  visibleModels.slice(start, start + windowSize).forEach((m, i) => {
    const flatIdx = start + i;
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      const sectionLabel = m.provider === "anthropic" ? "Anthropic" : "OpenAI";
      rows.push(
        <Box key={`hdr-${m.provider}`} flexShrink={0}>
          <Text bold color={role.emphasis}>{sectionLabel}</Text>
        </Box>
      );
    }
    const selected = flatIdx === sel;
    const marker = m.id === currentModelId ? glyph.radioSelected : glyph.radioUnselected;
    const bg = selected ? role.selectionBackground : undefined;
    const label = narrow
      ? `${marker} ${m.id}`
      : `${marker} ${m.displayName}${m.costNote ? ` — ${m.costNote}` : ""}`;
    rows.push(
      <Box key={m.id} flexDirection="column" flexShrink={0} paddingLeft={spacing.sm} backgroundColor={bg}>
        <Text wrap="truncate-end" color={selected ? role.selectionForeground : undefined}>
          {selected ? glyph.selectionCursor : "  "}{label}
        </Text>
        {m.retention && (
          <Box paddingLeft={spacing.md}>
            <Text wrap="truncate-end" color={selected ? role.selectionForeground : undefined} dimColor={!selected}>
              {narrow ? `⚠ ${m.retention.minDays}d retention · ${m.retention.zdrAvailable ? "ZDR" : "no ZDR"}` :
               `⚠ Requires ${m.retention.minDays}-day data retention · ` +
               `${m.retention.zdrAvailable ? "ZDR available" : "ZDR not available"} · ` +
               `longer than the 7-day API default`}
            </Text>
          </Box>
        )}
      </Box>
    );
  });

  return (
    <Box flexDirection="column">
      {customMode === "none" && rows}
      {customMode === "input" && (
        <Box flexDirection="column">
          <Text wrap="truncate-end" dimColor>Model id served by your gateway (e.g. openai/gpt-4o-mini):</Text>
          <Box paddingLeft={spacing.sm}>
            <Text wrap="truncate-start">{glyph.promptMarker}{customInput}<Text inverse> </Text></Text>
          </Box>
          {gateways.length === 1 && (
            <Box paddingLeft={spacing.md}><Text dimColor>{`→ via ${gateways[0]}`}</Text></Box>
          )}
          {gateways.length > 1 && (
            <Box paddingLeft={spacing.md}><Text dimColor>{`${gateways.length} gateways configured — Enter to choose one`}</Text></Box>
          )}
          {gateways.length === 0 && (
            <Box paddingLeft={spacing.md}><Text color={role.caution}>{`${glyph.warningMark} no gateway configured — /keys → [G]ateway first`}</Text></Box>
          )}
        </Box>
      )}
      {customMode === "pick-gateway" && (
        <Box flexDirection="column">
          <Text wrap="truncate-end" dimColor>{`Route "${customInput.trim()}" through which gateway?`}</Text>
          {gateways.slice(Math.max(0, state.modelGatewayIndex - windowSize + 1), Math.max(windowSize, state.modelGatewayIndex + 1)).map((g) => (
            <Box key={g} paddingLeft={spacing.sm}>
              <Text wrap="truncate-end" color={g === gateways[state.modelGatewayIndex] ? role.accent : undefined}>
                {g === gateways[state.modelGatewayIndex] ? glyph.selectionCursor : "  "}{g}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {customMode === "none" && hidden > 0 && (
        <Box marginTop={spacing.xs}>
          <Text wrap="truncate-end" dimColor>{`${hidden} hidden — no API key for that provider · /keys to add`}</Text>
        </Box>
      )}
      {customMode === "none" && (
        <Box marginTop={spacing.xs}>
          <Text wrap="truncate-end" dimColor>C — enter a custom model id served by a gateway</Text>
        </Box>
      )}
    </Box>
  );
}
