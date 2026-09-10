import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store.js";
import { removeDiskTrustPrefix } from "../../../api/diskTrust.js";
import { role, glyph } from "../theme.js";

/**
 * Phase 2d — content-only permissions manager. No border, no title, no footer hints —
 * those come from OverlayShell when OverlayLayer wraps this component.
 */
export function PermissionsManager(): React.ReactElement {
  const { state, dispatch } = useStore();
  const list = state.permissionsList;
  const sel = state.permissionsSelectedIndex;

  useInput((input, key) => {
    // Esc handled by central handler (Phase 3b).
    if (key.upArrow) {
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
    <Box flexDirection="column">
      <Text dimColor>Trusted command prefixes (.zone/trust.json):</Text>
      <Box height={1} />
      {list.length === 0 ? (
        <Text dimColor>No trusted prefixes. T-key in approval modal to add one.</Text>
      ) : (
        list.map((entry, i) => (
          <Box key={entry.prefix}>
            <Text color={i === sel ? role.accent : undefined}>
              {i === sel ? glyph.selectionCursor : "  "}{String(i + 1).padStart(2)}. {entry.prefix.padEnd(20)} {entry.addedAt.slice(0, 16).replace("T", " ")} {entry.addedBy}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}
