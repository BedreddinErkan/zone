import React from "react";
import { Box, Text, useInput } from "ink";
import { randomUUID } from "node:crypto";
import { useStore } from "../store.js";
import { restoreSnapshot } from "../../../snapshots/snapshotStore.js";
import { role, glyph } from "../theme.js";

/**
 * Phase 2d — content-only undo confirmation. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads undoModalData from
 * the store; dispatches OVERLAY_POP on Esc/cancel/after-confirm.
 */
export function UndoConfirm(): React.ReactElement | null {
  const { state, dispatch } = useStore();
  const data = state.undoModalData;
  if (!data) return null;

  const { manifest, driftedPaths } = data;
  const driftedSet = new Set(driftedPaths);

  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") {
      dispatch({ type: "OVERLAY_POP" });
      return;
    }
    if (key.return || input === "y" || input === "Y") {
      dispatch({ type: "OVERLAY_POP" });
      restoreSnapshot(manifest.runId, manifest.repoPath)
        .then((result) => {
          if (result.alreadyUndone) {
            dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: "Already undone", level: "info" } });
          } else {
            dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: `Reverted ${result.reverted} file(s)`, level: "info" } });
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: msg, level: "warning" } });
        });
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{` Revert ${manifest.files.length} file(s) to state before last run:`}</Text>
      {manifest.files.map((entry) => {
        const isDrifted = driftedSet.has(entry.path);
        const isCreated = entry.kind === "created";
        let suffix = "";
        if (isCreated && !isDrifted) suffix = "  (created — will be deleted)";
        if (!isCreated && isDrifted) suffix = "  (changed since run — will overwrite)";
        if (isCreated && isDrifted) suffix = "  (edited since run — will delete)";
        return (
          <Box key={entry.path}>
            {isDrifted ? <Text color={role.caution}> {glyph.warningMark} </Text> : <Text>{"   "}</Text>}
            <Text>{entry.path}</Text>
            {suffix ? <Text dimColor>{suffix}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
