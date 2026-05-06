/**
 * Manual fixture test for snapshotStore (Tur 1 — storage layer).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/snapshots/__tests__/runSnapshotManual.ts
 *
 * Uses an isolated tmpdir + ZONE_SNAPSHOTS_ROOT override so it never
 * touches the user's real ~/.zone/ directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Set the snapshots-root override BEFORE importing the module, since
// getSnapshotsRoot() reads process.env on each call.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zone-snap-test-"));
const snapshotsRoot = path.join(tmpRoot, "snapshots");
const repoRoot = path.join(tmpRoot, "repo");
await fs.mkdir(snapshotsRoot, { recursive: true });
await fs.mkdir(repoRoot, { recursive: true });

const prevEnv = process.env.ZONE_SNAPSHOTS_ROOT;
process.env.ZONE_SNAPSHOTS_ROOT = snapshotsRoot;

const {
  createSnapshot,
  restoreSnapshot,
  listSnapshots,
  cleanupOldSnapshots,
  getSnapshotsRoot,
  getRepoSnapshotDir,
} = await import("../../../dist/snapshots/snapshotStore.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`         got: ${JSON.stringify(got)?.slice(0, 400)}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function freshRepo(label: string): Promise<string> {
  const dir = path.join(repoRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Cleanup tests walk the entire ZONE_SNAPSHOTS_ROOT, so they need a
// fresh root that no earlier case has populated.
async function freshSnapshotsRoot(label: string): Promise<void> {
  const newRoot = path.join(tmpRoot, "snapshots-" + label);
  await fs.mkdir(newRoot, { recursive: true });
  process.env.ZONE_SNAPSHOTS_ROOT = newRoot;
}

async function setManifestTimestamp(
  repo: string,
  runId: string,
  ts: number
): Promise<void> {
  const repoDir = getRepoSnapshotDir(repo);
  const manPath = path.join(repoDir, runId, "manifest.json");
  const raw = await fs.readFile(manPath, "utf8");
  const m = JSON.parse(raw);
  m.timestamp = ts;
  await fs.writeFile(manPath, JSON.stringify(m, null, 2), "utf8");
}

let exitCode = 0;
try {
  // Sanity: env override took effect
  check(
    "getSnapshotsRoot honors ZONE_SNAPSHOTS_ROOT",
    getSnapshotsRoot() === snapshotsRoot,
    { got: getSnapshotsRoot(), expected: snapshotsRoot }
  );

  // ===================================================================
  // 1. create + restore modified file
  // ===================================================================
  {
    const repo = await freshRepo("case1");
    const fileAbs = path.join(repo, "a.txt");
    await fs.writeFile(fileAbs, "before");
    const before = await fs.readFile(fileAbs);

    await fs.writeFile(fileAbs, "after");
    const after = await fs.readFile(fileAbs);

    await createSnapshot({
      runId: "run1",
      repoPath: repo,
      files: [
        { path: "a.txt", preFlushContent: before, postFlushContent: after },
      ],
    });

    const result = await restoreSnapshot("run1", repo);
    const onDisk = await fs.readFile(fileAbs, "utf8");
    check(
      "case1 disk content reverted to 'before'",
      onDisk === "before",
      { onDisk }
    );
    check(
      "case1 reverted=1, alreadyUndone=false",
      result.reverted === 1 && result.alreadyUndone === false,
      result
    );
    check(
      "case1 entry: kind=modified, diskMatchedPostFlush=true",
      result.files.length === 1 &&
        result.files[0].kind === "modified" &&
        result.files[0].diskMatchedPostFlush === true,
      result.files
    );
  }

  // ===================================================================
  // 2. create + restore created file (deletion marker)
  // ===================================================================
  {
    const repo = await freshRepo("case2");
    const fileAbs = path.join(repo, "b.txt");
    // file does NOT exist beforehand
    await fs.writeFile(fileAbs, "x");

    await createSnapshot({
      runId: "run2",
      repoPath: repo,
      files: [
        {
          path: "b.txt",
          preFlushContent: null,
          postFlushContent: Buffer.from("x"),
        },
      ],
    });

    const result = await restoreSnapshot("run2", repo);
    check(
      "case2 b.txt no longer exists after restore",
      !(await exists(fileAbs)),
      { existsAfter: await exists(fileAbs) }
    );
    check(
      "case2 result.files[0].kind=created, diskMatchedPostFlush=true",
      result.files[0].kind === "created" &&
        result.files[0].diskMatchedPostFlush === true,
      result.files
    );
  }

  // ===================================================================
  // 3. double restore is no-op
  // ===================================================================
  {
    const repo = await freshRepo("case3");
    const fileAbs = path.join(repo, "c.txt");
    await fs.writeFile(fileAbs, "before");
    await fs.writeFile(fileAbs, "after");

    await createSnapshot({
      runId: "run3",
      repoPath: repo,
      files: [
        {
          path: "c.txt",
          preFlushContent: Buffer.from("before"),
          postFlushContent: Buffer.from("after"),
        },
      ],
    });

    const r1 = await restoreSnapshot("run3", repo);
    const after1 = await fs.readFile(fileAbs, "utf8");
    // mutate the file to detect any re-write on second restore
    await fs.writeFile(fileAbs, "user-edit");
    const r2 = await restoreSnapshot("run3", repo);
    const after2 = await fs.readFile(fileAbs, "utf8");

    check(
      "case3 first restore reverts to 'before'",
      after1 === "before" && r1.alreadyUndone === false,
      { after1, r1 }
    );
    check(
      "case3 second restore is no-op (alreadyUndone=true, reverted=0)",
      r2.alreadyUndone === true &&
        r2.reverted === 0 &&
        r2.files.length === 0,
      r2
    );
    check(
      "case3 second restore did NOT touch user-edit on disk",
      after2 === "user-edit",
      { after2 }
    );
  }

  // ===================================================================
  // 4. hash mismatch flag
  // ===================================================================
  {
    const repo = await freshRepo("case4");
    const fileAbs = path.join(repo, "d.txt");
    await fs.writeFile(fileAbs, "before");
    await fs.writeFile(fileAbs, "after");

    await createSnapshot({
      runId: "run4",
      repoPath: repo,
      files: [
        {
          path: "d.txt",
          preFlushContent: Buffer.from("before"),
          postFlushContent: Buffer.from("after"),
        },
      ],
    });

    // User edits the file post-Zone, before clicking Undo.
    await fs.writeFile(fileAbs, "user-edited-after-zone");

    const result = await restoreSnapshot("run4", repo);
    const onDisk = await fs.readFile(fileAbs, "utf8");
    check(
      "case4 restore still reverts to 'before' (best-effort)",
      onDisk === "before",
      { onDisk }
    );
    check(
      "case4 entry has diskMatchedPostFlush=false (user edited)",
      result.files[0].diskMatchedPostFlush === false,
      result.files
    );
  }

  // ===================================================================
  // 5. invalid runId rejected
  // ===================================================================
  {
    const repo = await freshRepo("case5");
    const bads: Array<{ label: string; runId: string }> = [
      { label: "dotdot path", runId: "../etc" },
      { label: "forward slash", runId: "a/b" },
      { label: "backslash", runId: "a\\b" },
      { label: "newline", runId: "a\nb" },
      { label: "null byte", runId: "a\0b" },
      { label: "empty", runId: "" },
    ];
    for (const b of bads) {
      let threw = false;
      let msg = "";
      try {
        await createSnapshot({
          runId: b.runId,
          repoPath: repo,
          files: [],
        });
      } catch (err) {
        threw = true;
        msg = (err as Error).message;
      }
      check(
        `case5 invalid runId rejected: ${b.label}`,
        threw && msg === "invalid runId",
        { threw, msg }
      );
    }
  }

  // ===================================================================
  // 6. listSnapshots ordering and corruption tolerance
  // ===================================================================
  {
    const repo = await freshRepo("case6");
    await fs.writeFile(path.join(repo, "f.txt"), "x");

    await createSnapshot({
      runId: "old",
      repoPath: repo,
      files: [
        {
          path: "f.txt",
          preFlushContent: Buffer.from("x"),
          postFlushContent: Buffer.from("x"),
        },
      ],
    });
    const baseTs = Date.now();
    await setManifestTimestamp(repo, "old", baseTs - 30_000);

    await createSnapshot({
      runId: "mid",
      repoPath: repo,
      files: [
        {
          path: "f.txt",
          preFlushContent: Buffer.from("x"),
          postFlushContent: Buffer.from("x"),
        },
      ],
    });
    await setManifestTimestamp(repo, "mid", baseTs - 20_000);

    await createSnapshot({
      runId: "new",
      repoPath: repo,
      files: [
        {
          path: "f.txt",
          preFlushContent: Buffer.from("x"),
          postFlushContent: Buffer.from("x"),
        },
      ],
    });
    await setManifestTimestamp(repo, "new", baseTs - 10_000);

    // Corrupt the "mid" manifest.
    await fs.writeFile(
      path.join(getRepoSnapshotDir(repo), "mid", "manifest.json"),
      "not-json",
      "utf8"
    );

    const list = await listSnapshots(repo);
    check(
      "case6 returns 2 valid manifests (corrupt one skipped) in DESC order",
      list.length === 2 &&
        list[0].runId === "new" &&
        list[1].runId === "old",
      list.map((m) => ({ runId: m.runId, ts: m.timestamp }))
    );
  }

  // ===================================================================
  // 7. cleanup by age
  // ===================================================================
  {
    await freshSnapshotsRoot("case7");
    const repo = await freshRepo("case7");
    await fs.writeFile(path.join(repo, "g.txt"), "x");

    for (const id of ["a7", "b7", "c7"]) {
      await createSnapshot({
        runId: id,
        repoPath: repo,
        files: [
          {
            path: "g.txt",
            preFlushContent: Buffer.from("x"),
            postFlushContent: Buffer.from("x"),
          },
        ],
      });
      // 10 days old.
      await setManifestTimestamp(
        repo,
        id,
        Date.now() - 10 * 24 * 60 * 60 * 1000
      );
    }

    const before = await listSnapshots(repo);
    const result = await cleanupOldSnapshots({ maxAgeDays: 7 });
    const after = await listSnapshots(repo);

    check(
      "case7 cleanup removed 3 snapshots older than 7 days",
      before.length === 3 && result.removed === 3 && after.length === 0,
      { before: before.length, result, after: after.length }
    );
  }

  // ===================================================================
  // 8. cleanup by count
  // ===================================================================
  {
    await freshSnapshotsRoot("case8");
    const repo = await freshRepo("case8");
    await fs.writeFile(path.join(repo, "h.txt"), "x");

    const ids = ["a8", "b8", "c8", "d8", "e8"];
    for (let i = 0; i < ids.length; i += 1) {
      await createSnapshot({
        runId: ids[i],
        repoPath: repo,
        files: [
          {
            path: "h.txt",
            preFlushContent: Buffer.from("x"),
            postFlushContent: Buffer.from("x"),
          },
        ],
      });
      // Spread timestamps so sort order is deterministic, all within maxAge.
      // d8 (idx 3) and e8 (idx 4) are newest.
      await setManifestTimestamp(repo, ids[i], Date.now() - (5 - i) * 1000);
    }

    const before = await listSnapshots(repo);
    const result = await cleanupOldSnapshots({
      maxAgeDays: 30,
      maxRunsPerRepo: 2,
    });
    const after = await listSnapshots(repo);

    check(
      "case8 cleanup kept 2 newest, removed 3",
      before.length === 5 && result.removed === 3 && after.length === 2,
      { before: before.length, result, after: after.length }
    );
    check(
      "case8 the 2 survivors are the newest (e8, d8) in DESC order",
      after.length === 2 &&
        after[0].runId === "e8" &&
        after[1].runId === "d8",
      after.map((m) => ({ runId: m.runId, ts: m.timestamp }))
    );
  }
} finally {
  if (prevEnv === undefined) delete process.env.ZONE_SNAPSHOTS_ROOT;
  else process.env.ZONE_SNAPSHOTS_ROOT = prevEnv;
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[snapshot-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) exitCode = 1;
process.exit(exitCode);
