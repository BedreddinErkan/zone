import { randomUUID } from "node:crypto";
import { Box, Text, useInput, usePaste } from "ink";
import { useStore } from "../store.js";
import { loadDiskKeys, setDiskKey, removeDiskKey, maskKey } from "../../../api/diskKeys.js";
import type { DiskApiKey } from "../../../api/diskKeys.js";
import { role, glyph } from "../theme.js";

/**
 * One line describing a gateway row's pricing, and specifically whether a $0 cache rate is there
 * because the user DECLARED it or because they SKIPPED it. Same number, different facts: without
 * this the only way to explain an unexpectedly low reported cost is to remember what you typed.
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

export function ApiKeysView(): React.ReactElement {
  const { state, dispatch } = useStore();
  const { keysList: list, keysSelectedIndex: sel, keysEditMode: mode,
          keysEditInput: editInput, keysEditProvider: editProvider,
          keysDraftProfileId: draftId, keysDraftBaseUrl: draftUrl,
          keysPriceProvider: priceProvider, keysPriceModelId: priceModelId,
          keysPriceDraft: priceDraft } = state;

  const PRICE_MODES = ["price-model-id", "price-input", "price-output", "price-cache-read", "price-cache-write"] as const;
  const inPricing = (PRICE_MODES as readonly string[]).includes(mode);

  /**
   * Write the pricing draft onto its row, merging with whatever that row already had.
   *
   * Merged rather than replaced so pricing a second model does not silently drop the first, and so
   * the row's baseUrl/protocol/label survive — `setDiskKey` replaces the whole row, and there is no
   * separate updater to reach for: a new runtime export from diskKeys.ts would break six test files
   * that mock the module with object-literal factories.
   */
  const savePricing = (finalDraft: typeof priceDraft): void => {
    const row = list.find(k => k.provider === priceProvider);
    if (!row || finalDraft.input === undefined || finalDraft.output === undefined) return;
    const merged = {
      ...(row.pricing ?? {}),
      [priceModelId]: {
        input: finalDraft.input,
        output: finalDraft.output,
        // Spread conditionally: a skipped bucket must stay ABSENT on disk, not become 0.
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

  const refresh = (): void => {
    void loadDiskKeys().then(store => {
      dispatch({ type: "KEYS_OPEN", list: store.keys });
    });
  };

  useInput((input, key) => {
    if (mode === "view") {
      if (key.escape) { dispatch({ type: "KEYS_CLOSE" }); return; }
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
        const isCache = mode === "price-cache-read" || mode === "price-cache-write";
        const field = mode === "price-input" ? "input" as const
          : mode === "price-output" ? "output" as const
          : mode === "price-cache-read" ? "cache_read" as const
          : "cache_write" as const;
        if (!raw) {
          // Empty Enter skips a CACHE bucket (leaving it undeclared) but is not a valid answer for
          // input/output, which have no defensible default.
          if (!isCache) return;
          if (mode === "price-cache-write") savePricing(priceDraft);
          dispatch({ type: "KEYS_PRICE_SKIP", field: field as "cache_read" | "cache_write" });
          return;
        }
        const value = Number(raw);
        // Number.isFinite, not parseFloat: parseFloat("1abc") is 1 and parseFloat("abc") is NaN,
        // either of which would silently poison a rate.
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
      // The two gateway steps share the buffer actions with the key step; only Enter differs.
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
          // `draftUrl` is set only by the gateway flow, and it is what makes the row a gateway.
          // A vendor key still writes the same three fields it always did.
          const savedGatewayId = draftUrl ? editProvider : null;
          void setDiskKey(editProvider, editInput.trim(), draftUrl ? { baseUrl: draftUrl } : undefined)
            .then(() => {
              refresh();
              dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: "Key saved — active on next run.", level: "info" } });
              // A gateway is unpriced until told otherwise, which leaves --max-budget-usd inert.
              // Offer to price it now rather than leaving that to be discovered from a warning.
              // `refresh` dispatches KEYS_OPEN (which resets to "view"), so this must follow it.
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
    // All three text steps accept a paste — a base URL is exactly the kind of thing that gets
    // pasted, and leaving it out would make that step silently swallow the paste.
    if (mode !== "input" && mode !== "input-profile-id" && mode !== "input-base-url" && !inPricing) return;
    const cleaned = text.replace(/[\x00-\x1f\x7f]/g, "");
    if (cleaned) dispatch({ type: "KEYS_INPUT_CHAR", ch: cleaned });
  }, { isActive: true });

  return (
    <Box borderStyle="round" borderColor={role.caution} flexDirection="column" paddingX={1} marginX={2}>
      <Text bold color={role.caution}>API Keys</Text>
      {mode === "view" && (
        <>
          <Text dimColor>Keys (~/.zone/keys.json):</Text>
          <Box height={1} />
          {list.length === 0 ? (
            <Text dimColor>No keys. N to add one.</Text>
          ) : (
            list.map((entry, i) => (
              <Box key={entry.provider} flexDirection="column">
                <Text color={i === sel ? role.caution : undefined}>
                  {i === sel ? glyph.selectionCursor : "  "}{entry.provider.padEnd(12)} {maskKey(entry.key).padEnd(20)} {entry.addedAt.slice(0, 10)}{entry.baseUrl ? ` → ${entry.baseUrl}` : ""}
                </Text>
                {entry.baseUrl && (
                  <Text dimColor>{`      ${describePricing(entry.pricing)}`}</Text>
                )}
              </Box>
            ))
          )}
          <Box height={1} />
          <Text dimColor>↑↓ navigate  N new  E edit  P price  Del remove  Esc close</Text>
        </>
      )}
      {mode === "select-provider" && (
        <>
          <Box height={1} />
          <Text>Select provider: <Text color={role.accent}>[A]</Text>nthropic  <Text color={role.accent}>[O]</Text>penAI  <Text color={role.accent}>[G]</Text>ateway  Esc cancel</Text>
        </>
      )}
      {mode === "input-profile-id" && (
        <>
          <Box height={1} />
          <Text dimColor>Gateway profile id — the name you will pass to /model and --provider:</Text>
          <Text>{"> "}{editInput}<Text inverse> </Text></Text>
        </>
      )}
      {mode === "input-base-url" && (
        <>
          <Box height={1} />
          <Text dimColor>Base URL for <Text color={role.caution}>{draftId}</Text> (e.g. http://localhost:4000/v1):</Text>
          <Text>{"> "}{editInput}<Text inverse> </Text></Text>
        </>
      )}
      {mode === "input" && (
        <>
          <Box height={1} />
          <Text dimColor>Enter key for <Text color={role.caution}>{editProvider}</Text> (Enter save, Esc cancel):</Text>
          {draftUrl && <Text dimColor>(Gateway at {draftUrl})</Text>}
          {editProvider && list.find(k => k.provider === editProvider) && (
            <Text dimColor>(Current: {maskKey(list.find(k => k.provider === editProvider)!.key)})</Text>
          )}
          <Text>{"> "}{"•".repeat(editInput.length)}<Text inverse> </Text></Text>
        </>
      )}
      {inPricing && (
        <>
          <Box height={1} />
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
        </>
      )}
      {mode === "confirm-delete" && (
        <>
          <Box height={1} />
          <Text>Remove <Text color={role.caution}>{editProvider}</Text> key? <Text color={role.success}>[Y]</Text>es  <Text color={role.danger}>[N]</Text>o  Esc cancel</Text>
        </>
      )}
    </Box>
  );
}
