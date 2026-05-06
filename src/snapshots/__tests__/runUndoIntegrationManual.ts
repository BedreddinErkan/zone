/**
 * Integration test for Zone Undo Tur 2a: drives createSnapshot +
 * restoreSnapshot in the exact shape the orchestrator uses.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/snapshots/__tests__/runUndoIntegrationManual.ts
 *
 * Uses ZONE_SNAPSHOTS_ROOT override + tmpdir so it never touches ~/.zone/.
 * Does NOT spin up Express — endpoint logic is verified by hand-curl after build.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zone-undo-int-"));
const snapshotsRoot = path.join(tmpRoot, "snapshots");
const repoRoot = path.join(tmpRoot, "repo");
await fs.mkdir(snapshotsRoot, { recursive: true });
await fs.mkdir(repoRoot, { recursive: true });

const prevEnv = process.env.ZONE_SNAPSHOTS_ROOT;
process.env.ZONE_SNAPSHOTS_ROOT = snapshotsRoot;

const { createSnapshot, restoreSnapshot } = await import(
  "../../../dist/snapshots/snapshotStore.js"
);

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

// Mirror the exact shape runLlmPatchFlow uses: derive snapshot input
// from filesTouched + beforeByFile + on-disk post-flush content.
async function captureLikeOrchestrator(
  runId: string,
  repo: string,
  filesTouched: string[],
  beforeByFile: Map<string, string>
) {
  const snapshotFiles = await Promise.all(
    filesTouched.map(async (relPath) => {
      const abs = path.resolve(repo, relPath);
      const preFlushText = beforeByFile.get(relPath);
      const preFlushContent =
        preFlushText !== undefined
          ? Buffer.from(preFlushText, "utf8")
          : null;
      const postFlushContent = await fs.readFile(abs);
      return { path: relPath, preFlushContent, postFlushContent };
    })
  );
  return createSnapshot({ runId, repoPath: repo, files: snapshotFiles });
}

let exitCode = 0;
try {
  // ===================================================================
  // 1. modified-file round trip
  // ===================================================================
  {
    const repo = await freshRepo("case1");
    const fileAbs = path.join(repo, "foo.txt");
    await fs.writeFile(fileAbs, "A");
    const beforeByFile = new Map<string, string>([["foo.txt", "A"]]);
    await fs.writeFile(fileAbs, "B");
    const filesTouched = ["foo.txt"];

    await captureLikeOrchestrator("run1", repo, filesTouched, beforeByFile);
    const result = await restoreSnapshot("run1", repo);
    const onDisk = await fs.readFile(fileAbs, "utf8");
    check(
      "case1 modified-file round trip: disk reverts to 'A'",
      onDisk === "A" && result.reverted === 1,
      { onDisk, result }
    );
    check(
      "case1 entry kind=modified, diskMatchedPostFlush=true",
      result.files[0].kind === "modified" &&
        result.files[0].diskMatchedPostFlush === true,
      result.files
    );
  }

  // ===================================================================
  // 2. created-file round trip (deletion marker)
  // ===================================================================
  {
    const repo = await freshRepo("case2");
    const fileAbs = path.join(repo, "bar.txt");
    // bar.txt did not exist beforehand → not in beforeByFile
    const beforeByFile = new Map<string, string>();
    await fs.writeFile(fileAbs, "X");
    const filesTouched = ["bar.txt"];

    await captureLikeOrchestrator("run2", repo, filesTouched, beforeByFile);
    const result = await restoreSnapshot("run2", repo);
    check(
      "case2 created-file round trip: bar.txt removed",
      !(await exists(fileAbs)) && result.reverted === 1,
      { exists: await exists(fileAbs), result }
    );
    check(
      "case2 entry kind=created, diskMatchedPostFlush=true",
      result.files[0].kind === "created" &&
        result.files[0].diskMatchedPostFlush === true,
      result.files
    );
  }

  // ===================================================================
  // 3. mixed batch — modified + created + modified
  // ===================================================================
  {
    const repo = await freshRepo("case3");
    const f1 = path.join(repo, "a.txt");
    const f2 = path.join(repo, "b.txt");
    const f3 = path.join(repo, "c.txt");
    await fs.writeFile(f1, "A0");
    await fs.writeFile(f3, "C0");
    const beforeByFile = new Map<string, string>([
      ["a.txt", "A0"],
      ["c.txt", "C0"],
    ]);
    await fs.writeFile(f1, "A1");
    await fs.writeFile(f2, "B1");
    await fs.writeFile(f3, "C1");
    const filesTouched = ["a.txt", "b.txt", "c.txt"];

    await captureLikeOrchestrator("run3", repo, filesTouched, beforeByFile);
    const result = await restoreSnapshot("run3", repo);

    const a = await fs.readFile(f1, "utf8");
    const b2Exists = await exists(f2);
    const c = await fs.readFile(f3, "utf8");

    check(
      "case3 a.txt reverted to 'A0'",
      a === "A0",
      { a }
    );
    check(
      "case3 b.txt deleted (created kind)",
      !b2Exists,
      { b2Exists }
    );
    check(
      "case3 c.txt reverted to 'C0'",
      c === "C0",
      { c }
    );
    check(
      "case3 reverted=3, all entries diskMatchedPostFlush=true",
      result.reverted === 3 &&
        result.files.length === 3 &&
        result.files.every((f) => f.diskMatchedPostFlush === true),
      result
    );
  }

  // ===================================================================
  // 4. runId sanitization respected — orchestrator-style call rejected
  // ===================================================================
  {
    const repo = await freshRepo("case4");
    const fileAbs = path.join(repo, "d.txt");
    await fs.writeFile(fileAbs, "Y");

    let threw = false;
    let msg = "";
    try {
      await captureLikeOrchestrator(
        "../escape",
        repo,
        ["d.txt"],
        new Map([["d.txt", "Y"]])
      );
    } catch (err) {
      threw = true;
      msg = (err as Error).message;
    }
    check(
      "case4 invalid runId '../escape' rejected with 'invalid runId'",
      threw && msg === "invalid runId",
      { threw, msg }
    );

    // Confirm no snapshot dir was written outside the snapshots root.
    const stray = await exists(path.join(snapshotsRoot, "..", "escape"));
    check(
      "case4 no escaped snapshot dir created",
      !stray,
      { stray }
    );
  }

  // ===================================================================
  // 5. double restore is no-op
  // ===================================================================
  {
    const repo = await freshRepo("case5");
    const fileAbs = path.join(repo, "e.txt");
    await fs.writeFile(fileAbs, "PRE");
    await fs.writeFile(fileAbs, "POST");
    await captureLikeOrchestrator(
      "run5",
      repo,
      ["e.txt"],
      new Map([["e.txt", "PRE"]])
    );

    const r1 = await restoreSnapshot("run5", repo);
    const after1 = await fs.readFile(fileAbs, "utf8");
    // Mutate disk to detect any second-restore re-write.
    await fs.writeFile(fileAbs, "USER-EDIT-AFTER-UNDO");
    const r2 = await restoreSnapshot("run5", repo);
    const after2 = await fs.readFile(fileAbs, "utf8");

    check(
      "case5 first restore reverts to PRE",
      after1 === "PRE" && r1.alreadyUndone === false,
      { after1, r1 }
    );
    check(
      "case5 second restore returns alreadyUndone=true, reverted=0",
      r2.alreadyUndone === true && r2.reverted === 0 && r2.files.length === 0,
      r2
    );
    check(
      "case5 second restore did NOT touch disk (USER-EDIT preserved)",
      after2 === "USER-EDIT-AFTER-UNDO",
      { after2 }
    );
  }
} finally {
  if (prevEnv === undefined) delete process.env.ZONE_SNAPSHOTS_ROOT;
  else process.env.ZONE_SNAPSHOTS_ROOT = prevEnv;
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[undo-integration-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) exitCode = 1;
process.exit(exitCode);
