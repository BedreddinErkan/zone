import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { removeDiskTrustPrefix } from "../../../api/diskTrust.js";

export function PermissionsView(): React.ReactElement {
  const { state, dispatch } = useStore();
  const list = state.permissionsList;
  const sel = state.permissionsSelectedIndex;

  useInput((input, key) => {
    if (key.escape) {
      dispatch({ type: "PERMISSIONS_CLOSE" });
    } else if (key.upArrow) {
      dispatch({ type: "PERMISSIONS_NAV", direction: "up" });
    } else if (key.downArrow) {
      dispatch({ type: "PERMISSIONS_NAV", direction: "down" });
    } else if (key.delete || key.backspace || input === "d") {
      const entry = list[sel];
      if (entry) {
        void removeDiskTrustPrefix(process.cwd(), entry.prefix);
        dispatch({ type: "PERMISSIONS_REMOVE_SELECTED" });
      }
    }
  });

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginX={2}>
      <Text bold color="cyan">Permissions</Text>
      <Text dimColor>Trusted command prefixes (.zone/trust.json):</Text>
      <Box height={1} />
      {list.length === 0 ? (
        <Text dimColor>No trusted prefixes. T-key in approval modal to add one.</Text>
      ) : (
        list.map((entry, i) => (
          <Box key={entry.prefix}>
            <Text color={i === sel ? "cyan" : undefined}>
              {i === sel ? "▸ " : "  "}{String(i + 1).padStart(2)}. {entry.prefix.padEnd(20)} {entry.addedAt.slice(0, 16).replace("T", " ")} {entry.addedBy}
            </Text>
          </Box>
        ))
      )}
      <Box height={1} />
      <Text dimColor>↑↓ navigate  Del/d remove  Esc close</Text>
    </Box>
  );
}
