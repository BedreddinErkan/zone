import React from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { useEffect } from "react";
import { randomUUID } from "node:crypto";
import { useStore } from "../store.js";
import { loadDiskKeys, setDiskKey, removeDiskKey, maskKey } from "../../../api/diskKeys.js";
import type { DiskApiKey } from "../../../api/diskKeys.js";
import { role, glyph, spacing } from "../theme.js";

/**
 * Phase 2c — content-only API keys manager. No border, no title, no footer — those come
 * from OverlayShell when OverlayLayer wraps this component. Same state slice, same reducer
 * actions, same paste behaviour as ApiKeysView.tsx; only the close path differs (OVERLAY_POP
 * instead of KEYS_CLOSE) and the outer chrome is gone.
 *
 * ApiKeysView.tsx stays on disk: ApiKeysView.test.tsx renders it directly and asserts the
 * old modal's chrome is present. Phase 2d will retire it once that test is redirected here.
 */
function describePricing(pricing: DiskApiKey["pricing"]): string {
  const ids = pricing ? Object.keys(pricing) : [];
  if (ids.length === 0) return "unpriced — P to price it, else --max-budget-usd cannot bound it";
  const skipped = ids.filter(
    (id) => pricing![id]!.cache_read === undefined || pricing![id]!.cache_write === undefined
  );
  const head = `priced: ${ids.length} model${ids.length === 1 ? "" : "s"}`;
  return skipped.length === 0
    ? `${head}, all buckets declared`
    : `${head}; cache buckets SKIPPED for ${skipped.join(", ")} — they price at $0 by omission`;
}

export function ApiKeysManager(): React.ReactElement {
  const { state, dispatch } = useStore();
  const { keysList: list, keysSelectedIndex: sel, keysEditMode: mode,
          keysEditInput: editInput, keysEditProvider: editProvider,
          keysDraftProfileId: draftId, keysDraftBaseUrl: draftUrl,
          keysPriceProvider: priceProvider, keysPriceModelId: priceModelId,
          keysPriceDraft: priceDraft } = state;

  const PRICE_MODES = ["price-model-id", "price-input", "price-output", "price-cache-read", "price-cache-write"] as const;
  const inPricing = (PRICE_MODES as readonly string[]).includes(mode);
  const inSubMenu = mode !== "view";

  // Phase 3b — report sub-mode so the central Esc handler defers while the user is
  // in a key-input, provider-select, confirm-delete, or pricing sub-state.
  useEffect(() => {
    dispatch(inSubMenu ? { type: "OVERLAY_SUBMODE_OPEN" } : { type: "OVERLAY_SUBMODE_CLOSE" });
  }, [inSubMenu, dispatch]);

  const savePricing = (finalDraft: typeof priceDraft): void => {
    const row = list.find(k => k.provider === priceProvider);
    if (!row || finalDraft.input === undefined || finalDraft.output === undefined) return;
    const merged = {
      ...(row.pricing ?? {}),
      [priceModelId]: {
        input: finalDraft.input,
        output: finalDraft.output,
        ...(finalDraft.cache_read !== undefined ? { cache_read: finalDraft.cache_read } : {}),
        ...(finalDraft.cache_write !== undefined ? { cache_write: finalDraft.cache_write } : {}),
      },
    };
    void setDiskKey(row.provider, row.key, {
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      ...(row.protocol ? { protocol: row.protocol } : {}),
      ...(row.label ? { label: row.label } : {}),
      pricing: merged,
    })
      .then(() => {
        refresh();
        dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), level: "info",
          message: `Priced ${priceModelId} — --max-budget-usd can now bound this profile.` } });
      })
      .catch((err: unknown) => {
        dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), level: "error",
          message: err instanceof Error ? err.message : "Failed to save pricing." } });
      });
  };

  const refresh = (): Promise<void> =>
    loadDiskKeys().then(store => {
      dispatch({ type: "KEYS_OPEN", list: store.keys });
    });

  useInput((input, key) => {
    if (mode === "view") {
      // Esc falls through to central handler (Phase 3b).
      if (key.upArrow) { dispatch({ type: "KEYS_NAV", direction: "up" }); return; }
      if (key.downArrow) { dispatch({ type: "KEYS_NAV", direction: "down" }); return; }
      if (input === "n" || input === "N") { dispatch({ type: "KEYS_START_ADD" }); return; }
      if ((input === "e" || input === "E") && list[sel]) {
        dispatch({ type: "KEYS_START_EDIT", provider: list[sel].provider }); return;
      }
      if ((input === "p" || input === "P") && list[sel]?.baseUrl) {
        dispatch({ type: "KEYS_PRICE_START", provider: list[sel].provider }); return;
      }
      if ((key.delete || key.backspace || input === "d") && list[sel]) {
        dispatch({ type: "KEYS_START_DELETE" }); return;
      }
    } else if (inPricing) {
      if (key.escape) { dispatch({ type: "KEYS_PRICE_CANCEL" }); return; }
      if (key.return) {
        const raw = editInput.trim();
        if (mode === "price-model-id") { dispatch({ type: "KEYS_PRICE_MODEL_SUBMIT" }); return; }
        if (mode === "price-output") {
          if (!raw) return;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0) return;
          savePricing({ ...priceDraft, output: value });
          dispatch({ type: "KEYS_PRICE_NUMBER_SUBMIT", field: "output", value });
          return;
        }
        const isCache = mode === "price-cache-read" || mode === "price-cache-write";
        // "price-output" is handled above (early return), so by this point mode is one of
        // price-input / price-cache-read / price-cache-write. The ternary's middle branch
        // is unreachable but kept for structural parity with ApiKeysView.tsx so the two
        // components stay byte-comparable during the Phase 2d retirement pass.
        const field = mode === "price-input" ? "input" as const
          : mode === "price-cache-read" ? "cache_read" as const
          : "cache_write" as const;
        if (!raw) {
          if (!isCache) return;
          if (mode === "price-cache-write") savePricing(priceDraft);
          dispatch({ type: "KEYS_PRICE_SKIP", field: field as "cache_read" | "cache_write" });
          return;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) return;
        if (mode === "price-cache-write") savePricing({ ...priceDraft, cache_write: value });
        dispatch({ type: "KEYS_PRICE_NUMBER_SUBMIT", field, value });
        return;
      }
      if (key.backspace || key.delete) { dispatch({ type: "KEYS_INPUT_BACKSPACE" }); return; }
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        dispatch({ type: "KEYS_INPUT_CHAR", ch: input }); return;
      }
    } else if (mode === "select-provider") {
      if (key.escape) { dispatch({ type: "KEYS_INPUT_CANCEL" }); return; }
      if (input === "a" || input === "A") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "anthropic" }); return; }
      if (input === "o" || input === "O") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "openai" }); return; }
      if (input === "g" || input === "G") { dispatch({ type: "KEYS_GATEWAY_START" }); return; }
    } else if (mode === "input-profile-id" || mode === "input-base-url") {
      if (key.escape) { dispatch({ type: "KEYS_INPUT_CANCEL" }); return; }
      if (key.return) {
        dispatch({ type: mode === "input-profile-id" ? "KEYS_GATEWAY_ID_SUBMIT" : "KEYS_GATEWAY_URL_SUBMIT" });
        return;
      }
      if (key.backspace || key.delete) { dispatch({ type: "KEYS_INPUT_BACKSPACE" }); return; }
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        dispatch({ type: "KEYS_INPUT_CHAR", ch: input }); return;
      }
    } else if (mode === "input") {
      if (key.escape) { dispatch({ type: "KEYS_INPUT_CANCEL" }); return; }
      if (key.return) {
        if (editInput.trim() && editProvider) {
          const savedGatewayId = draftUrl ? editProvider : null;
          void setDiskKey(editProvider, editInput.trim(), draftUrl ? { baseUrl: draftUrl } : undefined)
            .then(() => refresh())
            .then(() => {
              dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: "Key saved — active on next run.", level: "info" } });
              if (savedGatewayId) {
                dispatch({ type: "KEYS_PRICE_START", provider: savedGatewayId });
              }
            })
            .catch((err: unknown) => {
              dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: err instanceof Error ? err.message : "Failed to save key.", level: "error" } });
            });
        } else {
          dispatch({ type: "KEYS_INPUT_CANCEL" });
        }
        return;
      }
      if (key.backspace || key.delete) { dispatch({ type: "KEYS_INPUT_BACKSPACE" }); return; }
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        dispatch({ type: "KEYS_INPUT_CHAR", ch: input }); return;
      }
    } else if (mode === "confirm-delete") {
      if (key.escape || input === "n" || input === "N") { dispatch({ type: "KEYS_DELETE_CANCELED" }); return; }
      if (input === "y" || input === "Y") {
        if (editProvider) void removeDiskKey(editProvider).then(refresh);
        return;
      }
    }
  });

  usePaste((text) => {
    if (mode !== "input" && mode !== "input-profile-id" && mode !== "input-base-url" && !inPricing) return;
    const cleaned = text.replace(/[\x00-\x1f\x7f]/g, "");
    if (cleaned) dispatch({ type: "KEYS_INPUT_CHAR", ch: cleaned });
  }, { isActive: true });

  return (
    <Box flexDirection="column">
      {mode === "view" && (
        <>
          <Text dimColor>Keys (~/.zone/keys.json):</Text>
          <Box marginTop={spacing.sm}>
            {list.length === 0 ? (
              <Text dimColor>No keys. N to add one.</Text>
            ) : (
              <Box flexDirection="column">
                {list.map((entry, i) => (
                  <Box key={entry.provider} flexDirection="column">
                    <Text color={i === sel ? role.caution : undefined}>
                      {i === sel ? glyph.selectionCursor : "  "}{entry.provider.padEnd(12)} {maskKey(entry.key).padEnd(20)} {entry.addedAt.slice(0, 10)}{entry.baseUrl ? ` → ${entry.baseUrl}` : ""}
                    </Text>
                    {entry.baseUrl && (
                      <Box paddingLeft={spacing.md}>
                        <Text dimColor>{describePricing(entry.pricing)}</Text>
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
          <Box marginTop={spacing.sm}>
            <Text dimColor>↑↓ navigate  N new  E edit  P price  Del remove  Esc close</Text>
          </Box>
        </>
      )}
      {mode === "select-provider" && (
        <>
          <Box marginTop={spacing.sm}>
            <Text>Select provider: <Text color={role.accent}>[A]</Text>nthropic  <Text color={role.accent}>[O]</Text>penAI  <Text color={role.accent}>[G]</Text>ateway  Esc cancel</Text>
          </Box>
        </>
      )}
      {mode === "input-profile-id" && (
        <>
          <Box marginTop={spacing.sm} flexDirection="column">
            <Text dimColor>Gateway profile id — the name you will pass to /model and --provider:</Text>
            <Text>{"> "}{editInput}<Text inverse> </Text></Text>
          </Box>
        </>
      )}
      {mode === "input-base-url" && (
        <>
          <Box marginTop={spacing.sm} flexDirection="column">
            <Text dimColor>Base URL for <Text color={role.caution}>{draftId}</Text> (e.g. http://localhost:4000/v1):</Text>
            <Text>{"> "}{editInput}<Text inverse> </Text></Text>
          </Box>
        </>
      )}
      {mode === "input" && (
        <>
          <Box marginTop={spacing.sm} flexDirection="column">
            <Text dimColor>Enter key for <Text color={role.caution}>{editProvider}</Text> (Enter save, Esc cancel):</Text>
            {draftUrl && <Text dimColor>(Gateway at {draftUrl})</Text>}
            {editProvider && list.find(k => k.provider === editProvider) && (
              <Text dimColor>(Current: {maskKey(list.find(k => k.provider === editProvider)!.key)})</Text>
            )}
            <Text>{"> "}{"•".repeat(editInput.length)}<Text inverse> </Text></Text>
          </Box>
        </>
      )}
      {inPricing && (
        <>
          <Box marginTop={spacing.sm} flexDirection="column">
            <Text dimColor>
              Pricing for <Text color={role.caution}>{priceProvider}</Text> (optional — Esc to skip the rest):
            </Text>
            {mode === "price-model-id" && (
              <>
                <Text dimColor>Model id, exactly as your gateway names it:</Text>
                <Text>{"> "}{editInput}<Text inverse> </Text></Text>
              </>
            )}
            {mode === "price-input" && (
              <>
                <Text dimColor>Input rate for <Text color={role.caution}>{priceModelId}</Text>, USD per million tokens:</Text>
                <Text>{"> "}{editInput}<Text inverse> </Text></Text>
              </>
            )}
            {mode === "price-output" && (
              <>
                <Text dimColor>Output rate, USD per million tokens:</Text>
                <Text>{"> "}{editInput}<Text inverse> </Text></Text>
              </>
            )}
            {(mode === "price-cache-read" || mode === "price-cache-write") && (
              <>
                <Text dimColor>
                  {mode === "price-cache-read" ? "Cache-READ rate" : "Cache-WRITE rate"}, USD per million tokens:
                </Text>
                <Text color={role.caution}>
                  {`  ${glyph.warningMark} Enter leaves this bucket undeclared; it prices at $0 and the`}
                </Text>
                <Text color={role.caution}>{"    reported cost becomes a floor, not a total."}</Text>
                <Text>{"> "}{editInput}<Text inverse> </Text></Text>
              </>
            )}
          </Box>
        </>
      )}
      {mode === "confirm-delete" && (
        <Box marginTop={spacing.sm}>
          <Text>Remove <Text color={role.caution}>{editProvider}</Text> key? <Text color={role.success}>[Y]</Text>es  <Text color={role.danger}>[N]</Text>o  Esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}
