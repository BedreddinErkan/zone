import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { USER_FACING_MODELS, getDefaultModelId } from "../../../llm/modelRegistry.js";
import { saveDiskModel } from "../../../api/diskModel.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";
import { role, glyph } from "../theme.js";
import { visibleModelRows, hiddenRowCount } from "../modelPickerList.js";

interface Props {
  dispatch: Dispatch<StoreAction>;
}

export function ModelModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const sel = state.modelSelectedIndex;
  const cols = process.stdout.columns ?? 80;
  const narrow = cols < 60;
  const currentModelId = state.modelSettings?.model ?? getDefaultModelId();
  // Same helper the reducer seeds modelSelectedIndex with, so `sel` indexes THIS array. Deriving
  // the list here independently is the defect this module exists to prevent.
  const visibleModels = visibleModelRows(USER_FACING_MODELS, state.providersWithKey, currentModelId);
  const hidden = hiddenRowCount(USER_FACING_MODELS, visibleModels);
  const count = visibleModels.length;

  const customMode = state.modelCustomMode;
  const customInput = state.modelCustomInput;
  const gateways = state.gatewayIds;

  const applyModel = (model: string, provider: string): void => {
    const settings: DiskModelSettings = {
      version: 2,
      model,
      provider,
      effort: state.modelSettings?.effort,
      updatedAt: new Date().toISOString(),
    };
    void saveDiskModel(process.cwd(), settings);
    dispatch({ type: "MODEL_APPLY", settings });
  };

  useInput((input, key) => {
    if (customMode === "input") {
      if (key.escape) { dispatch({ type: "MODEL_CUSTOM_CANCEL" }); return; }
      if (key.return) {
        const typed = customInput.trim();
        if (!typed) { dispatch({ type: "MODEL_CUSTOM_CANCEL" }); return; }
        // The three gateway counts, each decided explicitly rather than left to an inference that
        // happens to work for one of them. ZERO refuses: an id outside the catalog with no gateway
        // to serve it is silently substituted downstream by getModelName for the vendor's
        // standard-tier default, so writing it would produce a run on a model the user did not pick.
        if (gateways.length === 0) {
          dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), level: "error",
            message: "No gateway configured — /keys → [G]ateway first, then this id can be routed." } });
          dispatch({ type: "MODEL_CUSTOM_CANCEL" });
          return;
        }
        // TWO OR MORE: cannot pick, so it asks. Never chooses on the user's behalf.
        if (gateways.length > 1) { dispatch({ type: "MODEL_CUSTOM_PICK_GATEWAY" }); return; }
        // EXACTLY ONE: applied, and the routing was displayed above the field before Enter.
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
    if (key.escape) {
      dispatch({ type: "MODEL_MODAL_CLOSE" });
    } else if (key.upArrow) {
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
        <Text color={selected ? role.selectionForeground : undefined}>{label}</Text>
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
      {customMode === "none" && rows}
      {customMode === "input" && (
        <>
          <Text dimColor> Model id served by your gateway (e.g. openai/gpt-4o-mini):</Text>
          <Text> {"> "}{customInput}<Text inverse> </Text></Text>
          {/* The one-gateway case shows where this will go BEFORE Enter, so the routing is
              displayed rather than inferred silently. The other two counts are handled on Enter. */}
          {gateways.length === 1 && (
            <Text dimColor>{`   → via ${gateways[0]}`}</Text>
          )}
          {gateways.length > 1 && (
            <Text dimColor>{`   ${gateways.length} gateways configured — Enter to choose one`}</Text>
          )}
          {gateways.length === 0 && (
            <Text color={role.caution}>{`   ${glyph.warningMark} no gateway configured — /keys → [G]ateway first`}</Text>
          )}
        </>
      )}
      {customMode === "pick-gateway" && (
        <>
          <Text dimColor>{` Route "${customInput.trim()}" through which gateway?`}</Text>
          {gateways.map((g, i) => (
            <Text key={g} color={i === state.modelGatewayIndex ? role.accent : undefined}>
              {` ${i === state.modelGatewayIndex ? glyph.selectionCursor : "  "}${g}`}
            </Text>
          ))}
        </>
      )}
      <Text> </Text>
      {customMode === "none" && hidden > 0 && (
        <Text dimColor>{` ${hidden} hidden — no API key for that provider · /keys to add`}</Text>
      )}
      {/* The list-mode footer is byte-identical to what it has always been, deliberately: two
          tests in composer.test.tsx use this exact string as their proxy for "the /model modal
          opened", so appending to it would move an assertion that is not about the footer at all.
          The new affordance gets its own line above instead. */}
      {customMode === "none" && <Text dimColor> C — enter a custom model id served by a gateway</Text>}
      <Text dimColor>
        {customMode === "none"
          ? " ↑↓ navigate · Enter select · Esc cancel"
          : customMode === "input"
            ? " Enter confirm · Esc cancel"
            : " ↑↓ navigate · Enter route · Esc cancel"}
      </Text>
    </Box>
  );
}
