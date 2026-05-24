import { Box, Text, useInput, usePaste } from "ink";
import { useStore } from "../store.js";
import { loadDiskKeys, setDiskKey, removeDiskKey, maskKey } from "../../../api/diskKeys.js";

export function ApiKeysView(): React.ReactElement {
  const { state, dispatch } = useStore();
  const { keysList: list, keysSelectedIndex: sel, keysEditMode: mode,
          keysEditInput: editInput, keysEditProvider: editProvider } = state;

  const refresh = (): void => {
    void loadDiskKeys(process.cwd()).then(store => {
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
      if ((key.delete || key.backspace || input === "d") && list[sel]) {
        dispatch({ type: "KEYS_START_DELETE" }); return;
      }
    } else if (mode === "select-provider") {
      if (key.escape) { dispatch({ type: "KEYS_INPUT_CANCEL" }); return; }
      if (input === "a" || input === "A") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "anthropic" }); return; }
      if (input === "o" || input === "O") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "openai" }); return; }
    } else if (mode === "input") {
      if (key.escape) { dispatch({ type: "KEYS_INPUT_CANCEL" }); return; }
      if (key.return) {
        if (editInput.trim() && editProvider) {
          void setDiskKey(process.cwd(), editProvider, editInput.trim()).then(refresh);
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
        if (editProvider) void removeDiskKey(process.cwd(), editProvider).then(refresh);
        return;
      }
    }
  });

  usePaste((text) => {
    if (mode !== "input") return;
    const cleaned = text.replace(/[\x00-\x1f\x7f]/g, "");
    if (cleaned) dispatch({ type: "KEYS_INPUT_CHAR", ch: cleaned });
  }, { isActive: true });

  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginX={2}>
      <Text bold color="yellow">API Keys</Text>
      {mode === "view" && (
        <>
          <Text dimColor>Keys (.zone/keys.json):</Text>
          <Box height={1} />
          {list.length === 0 ? (
            <Text dimColor>No keys. N to add one.</Text>
          ) : (
            list.map((entry, i) => (
              <Box key={entry.provider}>
                <Text color={i === sel ? "yellow" : undefined}>
                  {i === sel ? "▸ " : "  "}{entry.provider.padEnd(12)} {maskKey(entry.key).padEnd(20)} {entry.addedAt.slice(0, 10)}
                </Text>
              </Box>
            ))
          )}
          <Box height={1} />
          <Text dimColor>↑↓ navigate  N new  E edit  Del remove  Esc close</Text>
        </>
      )}
      {mode === "select-provider" && (
        <>
          <Box height={1} />
          <Text>Select provider: <Text color="cyan">[A]</Text>nthropic  <Text color="cyan">[O]</Text>penAI  Esc cancel</Text>
        </>
      )}
      {mode === "input" && (
        <>
          <Box height={1} />
          <Text dimColor>Enter key for <Text color="yellow">{editProvider}</Text> (Enter save, Esc cancel):</Text>
          {editProvider && list.find(k => k.provider === editProvider) && (
            <Text dimColor>(Current: {maskKey(list.find(k => k.provider === editProvider)!.key)})</Text>
          )}
          <Text>{"> "}{"•".repeat(editInput.length)}<Text inverse> </Text></Text>
        </>
      )}
      {mode === "confirm-delete" && (
        <>
          <Box height={1} />
          <Text>Remove <Text color="yellow">{editProvider}</Text> key? <Text color="green">[Y]</Text>es  <Text color="red">[N]</Text>o  Esc cancel</Text>
        </>
      )}
    </Box>
  );
}
