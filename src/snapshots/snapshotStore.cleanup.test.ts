import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createSnapshot,
  listSnapshots,
  cleanupOldSnapshots,
  maybeCleanupOldSnapshots,
  getSnapshotsRoot,
  getRepoSnapshotDir,
} from "./snapshotStore.js";

let tmpDir: string;
let snapshotsRoot: string;
let repoDir: string;
const prevEnv = process.env["ZONE_SNAPSHOTS_ROOT"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-cleanup-test-"));
  snapshotsRoot = path.join(tmpDir, "snapshots");
  repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(snapshotsRoot, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });
  process.env["ZONE_SNAPSHOTS_ROOT"] = snapshotsRoot;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env["ZONE_SNAPSHOTS_ROOT"];
  else process.env["ZONE_SNAPSHOTS_ROOT"] = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function setManifestTimestamp(
  repo: string,
  runId: string,
  ts: number
): Promise<void> {
  const repoSnapDir = getRepoSnapshotDir(repo);
  const manPath = path.join(repoSnapDir, runId, "manifest.json");
  const raw = await fs.readFile(manPath, "utf8");
  const m = JSON.parse(raw);
  m.timestamp = ts;
  await fs.writeFile(manPath, JSON.stringify(m, null, 2), "utf8");
}

async function makeRun(repo: string, runId: string, ageMs: number): Promise<void> {
  await fs.writeFile(path.join(repo, "f.txt"), "x");
  await createSnapshot({
    runId,
    repoPath: repo,
    files: [
      {
        path: "f.txt",
        preFlushContent: Buffer.from("x"),
        postFlushContent: Buffer.from("x"),
      },
    ],
  });
  await setManifestTimestamp(repo, runId, Date.now() - ageMs);
}

describe("cleanupOldSnapshots", () => {
  it("removes snapshots older than maxAgeDays", async () => {
    for (const id of ["a", "b", "c"]) {
      await makeRun(repoDir, id, 10 * 24 * 60 * 60 * 1000);
    }
    const before = await listSnapshots(repoDir);
    const result = await cleanupOldSnapshots({ maxAgeDays: 7 });
    const after = await listSnapshots(repoDir);

    expect(before.length).toBe(3);
    expect(result.removed).toBe(3);
    expect(after.length).toBe(0);
  });

  it("caps survivors per repo by maxRunsPerRepo, keeping the newest", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < ids.length; i += 1) {
      await makeRun(repoDir, ids[i], (5 - i) * 1000);
    }
    const result = await cleanupOldSnapshots({
      maxAgeDays: 30,
      maxRunsPerRepo: 2,
    });
    const after = await listSnapshots(repoDir);

    expect(result.removed).toBe(3);
    expect(after.length).toBe(2);
    expect(after[0].runId).toBe("e");
    expect(after[1].runId).toBe("d");
  });

  it("removes the abandoned repo directory once all its snapshots are pruned", async () => {
    for (const id of ["a", "b"]) {
      await makeRun(repoDir, id, 10 * 24 * 60 * 60 * 1000);
    }
    const repoSnapDir = getRepoSnapshotDir(repoDir);
    expect(
      await fs
        .stat(repoSnapDir)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    await cleanupOldSnapshots({ maxAgeDays: 7 });

    const stillExists = await fs
      .stat(repoSnapDir)
      .then(() => true)
      .catch(() => false);
    expect(stillExists).toBe(false);
  });

  it("keeps the repo directory when some runs survive pruning", async () => {
    await makeRun(repoDir, "old", 10 * 24 * 60 * 60 * 1000);
    await makeRun(repoDir, "new", 1000);
    const repoSnapDir = getRepoSnapshotDir(repoDir);

    await cleanupOldSnapshots({ maxAgeDays: 7 });

    const stillExists = await fs
      .stat(repoSnapDir)
      .then(() => true)
      .catch(() => false);
    expect(stillExists).toBe(true);
  });
});

describe("maybeCleanupOldSnapshots", () => {
  it("runs and writes a marker file when none exists", async () => {
    for (const id of ["a", "b"]) {
      await makeRun(repoDir, id, 10 * 24 * 60 * 60 * 1000);
    }
    const result = await maybeCleanupOldSnapshots({ maxAgeDays: 7 });
    expect(result.ran).toBe(true);
    expect(result.removed).toBe(2);

    const markerPath = path.join(getSnapshotsRoot(), ".last-cleanup");
    const markerExists = await fs
      .stat(markerPath)
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(true);
  });

  it("is throttled and skips a second call within the same window", async () => {
    await maybeCleanupOldSnapshots({ maxAgeDays: 7 });

    for (const id of ["a", "b"]) {
      await makeRun(repoDir, id, 10 * 24 * 60 * 60 * 1000);
    }
    const result = await maybeCleanupOldSnapshots({ maxAgeDays: 7 });

    expect(result.ran).toBe(false);
    expect(result.removed).toBe(0);
    // The stale snapshots are still on disk because the throttle skipped the sweep.
    const after = await listSnapshots(repoDir);
    expect(after.length).toBe(2);
  });

  it("re-runs once the marker is older than the throttle window", async () => {
    await maybeCleanupOldSnapshots({ maxAgeDays: 7 });
    const markerPath = path.join(getSnapshotsRoot(), ".last-cleanup");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(markerPath, staleTime, staleTime);

    for (const id of ["a", "b"]) {
      await makeRun(repoDir, id, 10 * 24 * 60 * 60 * 1000);
    }
    const result = await maybeCleanupOldSnapshots({ maxAgeDays: 7 });

    expect(result.ran).toBe(true);
    expect(result.removed).toBe(2);
  });
});
