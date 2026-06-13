import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSnapshot, getDriftedPaths, type SnapshotManifest } from "./snapshotStore.js";

let tmpDir: string;
let snapshotsRoot: string;
let repoDir: string;
const prevEnv = process.env["ZONE_SNAPSHOTS_ROOT"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-drift-test-"));
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

async function makeManifest(runId: string, files: { name: string; preContent: string | null; postContent: string }[]): Promise<SnapshotManifest> {
  for (const f of files) {
    const abs = path.join(repoDir, f.name);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.postContent);
  }
  const snapshotFiles = files.map((f) => ({
    path: f.name,
    preFlushContent: f.preContent !== null ? Buffer.from(f.preContent) : null,
    postFlushContent: Buffer.from(f.postContent),
  }));
  return createSnapshot({ runId, repoPath: repoDir, files: snapshotFiles });
}

describe("getDriftedPaths", () => {
  it("T-CLEAN: all files match postFlushSha256 → empty array", async () => {
    const manifest = await makeManifest("cleanrun", [
      { name: "a.ts", preContent: "old", postContent: "new" },
    ]);
    // Files on disk still have the postContent from makeManifest.
    const drifted = await getDriftedPaths(manifest, repoDir);
    expect(drifted).toEqual([]);
  });

  it("T-DRIFT: a modified file's content changed after snapshot → path in result", async () => {
    const manifest = await makeManifest("driftrun", [
      { name: "b.ts", preContent: "old", postContent: "post" },
    ]);
    // Simulate user editing the file after the run.
    await fs.writeFile(path.join(repoDir, "b.ts"), "user-edited");
    const drifted = await getDriftedPaths(manifest, repoDir);
    expect(drifted).toContain("b.ts");
    expect(drifted).toHaveLength(1);
  });

  it("T-MISSING: file deleted after snapshot → path in result (missing = drifted)", async () => {
    const manifest = await makeManifest("missingrun", [
      { name: "c.ts", preContent: null, postContent: "created-content" },
    ]);
    // Simulate file being deleted.
    await fs.unlink(path.join(repoDir, "c.ts"));
    const drifted = await getDriftedPaths(manifest, repoDir);
    expect(drifted).toContain("c.ts");
  });

  it("partial drift: only drifted files appear", async () => {
    const manifest = await makeManifest("partrun", [
      { name: "unchanged.ts", preContent: "u-pre", postContent: "u-post" },
      { name: "changed.ts", preContent: "c-pre", postContent: "c-post" },
    ]);
    await fs.writeFile(path.join(repoDir, "changed.ts"), "modified-by-user");
    const drifted = await getDriftedPaths(manifest, repoDir);
    expect(drifted).toContain("changed.ts");
    expect(drifted).not.toContain("unchanged.ts");
  });
});
