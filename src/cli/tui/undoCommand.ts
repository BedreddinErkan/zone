import { listSnapshots, getDriftedPaths } from "../../snapshots/snapshotStore.js";
import type { SnapshotManifest } from "../../snapshots/snapshotStore.js";

export interface UndoModalData {
  manifest: SnapshotManifest;
  driftedPaths: string[];
}

export async function resolveUndoData(repoPath: string): Promise<UndoModalData | null> {
  const snapshots = await listSnapshots(repoPath);
  const latest = snapshots.find((s) => !s.undone);
  if (!latest) return null;
  const driftedPaths = await getDriftedPaths(latest, repoPath);
  return { manifest: latest, driftedPaths };
}
