import { Box, Text, useInput, useStdout } from "ink";
import { type Dispatch } from "react";
import { randomUUID } from "node:crypto";
import type { StoreAction } from "../store.js";
import type { SnapshotManifest } from "../../../snapshots/snapshotStore.js";
import { restoreSnapshot } from "../../../snapshots/snapshotStore.js";

interface Props {
  data: { manifest: SnapshotManifest; driftedPaths: string[] };
  dispatch: Dispatch<StoreAction>;
}

export function UndoModal({ data, dispatch }: Props): React.ReactElement | null {
  const { stdout } = useStdout();

  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") {
      dispatch({ type: "UNDO_MODAL_CLOSE" });
      return;
    }
    if (key.return || input === "y" || input === "Y") {
      const { manifest } = data;
      dispatch({ type: "UNDO_MODAL_CLOSE" });
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

  const { manifest, driftedPaths } = data;
  const driftedSet = new Set(driftedPaths);
  const cols = stdout?.columns ?? 80;
  const width = Math.min(cols - 4, 62);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Text bold color="yellow"> Undo last run?</Text>
      <Text> </Text>
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
            {isDrifted ? <Text color="yellow"> ⚠ </Text> : <Text>{"   "}</Text>}
            <Text>{entry.path}</Text>
            {suffix ? <Text dimColor>{suffix}</Text> : null}
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>  [Y/Enter] Confirm   [N/Esc] Cancel</Text>
    </Box>
  );
}
