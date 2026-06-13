import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { UndoModal } from "./UndoModal.js";
import type { SnapshotManifest } from "../../../snapshots/snapshotStore.js";

const mockRestoreSnapshot = vi.hoisted(() => vi.fn<[], Promise<unknown>>());

vi.mock("../../../snapshots/snapshotStore.js", () => ({
  restoreSnapshot: mockRestoreSnapshot,
}));

function wait(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MANIFEST: SnapshotManifest = {
  schemaVersion: 1,
  runId: "run-test",
  repoPath: "/repo",
  timestamp: 1000,
  files: [
    { path: "src/foo.ts", kind: "modified", preFlushSha256: "a", postFlushSha256: "b", snapshotFile: "0.snapshot" },
  ],
};

const MANIFEST_CREATED: SnapshotManifest = {
  schemaVersion: 1,
  runId: "run-created",
  repoPath: "/repo",
  timestamp: 1001,
  files: [
    { path: "src/new.ts", kind: "created", preFlushSha256: null, postFlushSha256: "c", snapshotFile: null },
  ],
};

function renderModal(manifest: SnapshotManifest, driftedPaths: string[] = []) {
  const dispatch = vi.fn();
  const { stdin, lastFrame, unmount } = render(
    <UndoModal data={{ manifest, driftedPaths }} dispatch={dispatch} />
  );
  return { stdin, lastFrame, unmount, dispatch };
}

beforeEach(() => {
  mockRestoreSnapshot.mockReset();
  mockRestoreSnapshot.mockResolvedValue({ reverted: 1, files: [], alreadyUndone: false });
});

describe("UndoModal", () => {
  it("T-RENDER: shows file list and instructions", () => {
    const { lastFrame, unmount } = renderModal(MANIFEST);
    const frame = lastFrame();
    expect(frame).toContain("Undo last run");
    expect(frame).toContain("src/foo.ts");
    expect(frame).toContain("[Y/Enter] Confirm");
    unmount();
  });

  it("T-CANCEL-ESC: Esc dispatches UNDO_MODAL_CLOSE, restoreSnapshot not called", async () => {
    const { stdin, dispatch, unmount } = renderModal(MANIFEST);
    stdin.write("\x1b");
    await wait();
    expect(dispatch).toHaveBeenCalledWith({ type: "UNDO_MODAL_CLOSE" });
    expect(mockRestoreSnapshot).not.toHaveBeenCalled();
    unmount();
  });

  it("T-CANCEL-N: pressing n dispatches UNDO_MODAL_CLOSE, restoreSnapshot not called", async () => {
    const { stdin, dispatch, unmount } = renderModal(MANIFEST);
    stdin.write("n");
    await wait();
    expect(dispatch).toHaveBeenCalledWith({ type: "UNDO_MODAL_CLOSE" });
    expect(mockRestoreSnapshot).not.toHaveBeenCalled();
    unmount();
  });

  it("T-CONFIRM-Y: pressing y calls restoreSnapshot with correct runId/repoPath", async () => {
    const { stdin, dispatch, unmount } = renderModal(MANIFEST);
    stdin.write("y");
    await wait(150);
    expect(mockRestoreSnapshot).toHaveBeenCalledWith("run-test", "/repo");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UNDO_MODAL_CLOSE" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "TOAST_PUSH",
      entry: expect.objectContaining({ message: "Reverted 1 file(s)" }),
    }));
    unmount();
  });

  it("T-CONFIRM-ENTER: pressing Enter calls restoreSnapshot", async () => {
    const { stdin, dispatch, unmount } = renderModal(MANIFEST);
    stdin.write("\r");
    await wait(150);
    expect(mockRestoreSnapshot).toHaveBeenCalledWith("run-test", "/repo");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UNDO_MODAL_CLOSE" }));
    unmount();
  });

  it("T-DRIFT-DISPLAY: drifted modified file shows ⚠ and 'will overwrite'", () => {
    const { lastFrame, unmount } = renderModal(MANIFEST, ["src/foo.ts"]);
    const frame = lastFrame();
    expect(frame).toContain("⚠");
    expect(frame).toContain("will overwrite");
    unmount();
  });

  it("T-DRIFT-CREATED: drifted created file shows 'will delete'", () => {
    const { lastFrame, unmount } = renderModal(MANIFEST_CREATED, ["src/new.ts"]);
    const frame = lastFrame();
    expect(frame).toContain("⚠");
    expect(frame).toContain("will delete");
    unmount();
  });

  it("T-CREATED-NODRIFT: created file without drift shows 'will be deleted'", () => {
    const { lastFrame, unmount } = renderModal(MANIFEST_CREATED, []);
    const frame = lastFrame();
    expect(frame).toContain("will be deleted");
    unmount();
  });

  it("T-ALREADY-UNDONE: alreadyUndone=true → specific toast", async () => {
    mockRestoreSnapshot.mockResolvedValue({ reverted: 0, files: [], alreadyUndone: true });
    const { stdin, dispatch, unmount } = renderModal(MANIFEST);
    stdin.write("y");
    await wait(150);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "TOAST_PUSH",
      entry: expect.objectContaining({ message: "Already undone" }),
    }));
    unmount();
  });
});
