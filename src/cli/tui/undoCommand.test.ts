import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListSnapshots = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());
const mockGetDriftedPaths = vi.hoisted(() => vi.fn<[], Promise<string[]>>());

vi.mock("../../snapshots/snapshotStore.js", () => ({
  listSnapshots: mockListSnapshots,
  getDriftedPaths: mockGetDriftedPaths,
}));

import { resolveUndoData } from "./undoCommand.js";
import type { SnapshotManifest } from "../../snapshots/snapshotStore.js";

function makeManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schemaVersion: 1,
    runId: "run-abc",
    repoPath: "/repo",
    timestamp: 1000,
    files: [{ path: "src/foo.ts", kind: "modified", preFlushSha256: "aaa", postFlushSha256: "bbb", snapshotFile: "0.snapshot" }],
    ...overrides,
  };
}

beforeEach(() => {
  mockListSnapshots.mockReset();
  mockGetDriftedPaths.mockReset();
  mockGetDriftedPaths.mockResolvedValue([]);
});

describe("resolveUndoData", () => {
  it("T-NOOP: no snapshots → returns null", async () => {
    mockListSnapshots.mockResolvedValue([]);
    const result = await resolveUndoData("/repo");
    expect(result).toBeNull();
  });

  it("T-ALL-UNDONE: all snapshots already undone → returns null (consume scenario)", async () => {
    mockListSnapshots.mockResolvedValue([
      makeManifest({ runId: "run-1", timestamp: 2000, undone: { timestamp: 9999 } }),
      makeManifest({ runId: "run-2", timestamp: 1000, undone: { timestamp: 8888 } }),
    ]);
    const result = await resolveUndoData("/repo");
    expect(result).toBeNull();
  });

  it("T-HAPPY: one non-undone snapshot, no drift → returns manifest + empty driftedPaths", async () => {
    const manifest = makeManifest({ runId: "run-ok" });
    mockListSnapshots.mockResolvedValue([manifest]);
    mockGetDriftedPaths.mockResolvedValue([]);
    const result = await resolveUndoData("/repo");
    expect(result).not.toBeNull();
    expect(result!.manifest.runId).toBe("run-ok");
    expect(result!.driftedPaths).toEqual([]);
  });

  it("T-DRIFT: getDriftedPaths returns paths → driftedPaths in result", async () => {
    const manifest = makeManifest({ runId: "run-drift" });
    mockListSnapshots.mockResolvedValue([manifest]);
    mockGetDriftedPaths.mockResolvedValue(["src/baz.ts"]);
    const result = await resolveUndoData("/repo");
    expect(result!.driftedPaths).toEqual(["src/baz.ts"]);
  });

  it("T-CONSUME: two snapshots, latest has undone → second (non-undone) is returned", async () => {
    const first = makeManifest({ runId: "run-1", timestamp: 2000, undone: { timestamp: 9999 } });
    const second = makeManifest({ runId: "run-2", timestamp: 1000 });
    mockListSnapshots.mockResolvedValue([first, second]);
    mockGetDriftedPaths.mockResolvedValue([]);
    const result = await resolveUndoData("/repo");
    expect(result!.manifest.runId).toBe("run-2");
  });

  it("passes repoPath to getDriftedPaths and listSnapshots", async () => {
    const manifest = makeManifest();
    mockListSnapshots.mockResolvedValue([manifest]);
    mockGetDriftedPaths.mockResolvedValue([]);
    await resolveUndoData("/custom/repo");
    expect(mockListSnapshots).toHaveBeenCalledWith("/custom/repo");
    expect(mockGetDriftedPaths).toHaveBeenCalledWith(manifest, "/custom/repo");
  });
});
