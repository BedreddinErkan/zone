import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realUserHome, realZoneDir, REPO_GUARD_ALLOWED_DIRS } from "../testHome.js";

/**
 * Fails the test that writes to the real ~/.zone, at the moment it writes.
 *
 * Without this, a writer that escapes the HOME redirect leaves disk artefacts
 * that get discovered months later — which is exactly how the usage log ended
 * up 79% vitest output.
 *
 * Two things to know about the mechanism:
 *
 *  1. The anchor is os.userInfo().homedir, which reads the passwd database and
 *     so still reports the real home after $HOME is redirected. os.homedir()
 *     would return the temp home and the guard would permit everything.
 *
 *  2. The wrappers are assigned, never installed with vi.spyOn. The suite runs
 *     with restoreMocks: true, which would un-patch a spy after the first test
 *     and leave the guard looking installed while doing nothing.
 *
 * Reach is limited by import style: assigning over fs.writeFileSync is seen by
 * `import fs from "node:fs"` and by `import { promises as fsp }`, but NOT by
 * `import { writeFileSync } from "node:fs"` — a named function import snapshots
 * the binding at evaluation and never sees the assignment. That is why every
 * ~/.zone writer imports the namespace, and why homeWriterImportStyle.test.ts
 * fails the suite when a new one does not.
 */

const REAL_ZONE = realZoneDir();

/**
 * Second guarded root: the repository tree itself (ledger item 236).
 *
 * The home guard above and the inventory in globalHome.ts are two halves of one
 * template, and only the inventory half is import-style-immune. This half sees
 * what the inventory structurally cannot — a file created and deleted inside a
 * single run — and is blind to what the inventory catches, namely the 13 test
 * files that import fs write functions by name and so never see these
 * assignments. Neither half is sufficient; the pairing is the design.
 *
 * The allowlist and its per-entry reasons live in testHome.ts, shared with the
 * inventory half so the two cannot drift apart.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPO_ALLOWED = REPO_GUARD_ALLOWED_DIRS.map((d) => path.join(REPO_ROOT, d));

/** Observe mode records instead of throwing, so the transient write set can be
 *  measured before the allowlist is fixed. No tool available here can measure
 *  create-then-delete otherwise: inotifywait, strace and python inotify are all
 *  absent, checked. */
const REPO_OBSERVE = process.env["ZONE_REPO_GUARD_OBSERVE"] === "1";

// Captured BEFORE the wrapping loop below, so the observer's own bookkeeping
// does not re-enter the guard it is reporting for.
const rawAppendFileSync = fs.appendFileSync.bind(fs);
const rawMkdirSync = fs.mkdirSync.bind(fs);
const rawExistsSync = fs.existsSync.bind(fs);

const OBSERVE_DIR = path.join(os.tmpdir(), "zone-repo-guard-observe");
const OBSERVE_FILE = path.join(OBSERVE_DIR, `${process.pid}.jsonl`);
let guardedCallCount = 0;
let repoWriteCount = 0;

/** Records incrementally, one line per event, rather than accumulating in memory
 *  and reporting at teardown: a run that aborts mid-suite would otherwise lose
 *  the set and answer the transient question from a partial measurement without
 *  saying so. The sink is under os.tmpdir(), never inside the repository — an
 *  observer that wrote its own log into the tree would be its own first finding. */
function observeRepoWrite(fnName: string, target: unknown): void {
  try {
    if (!rawExistsSync(OBSERVE_DIR)) rawMkdirSync(OBSERVE_DIR, { recursive: true });
    let testName: string | null = null;
    try {
      testName = (globalThis as { __vitest_worker__?: { current?: { name?: string } } })
        .__vitest_worker__?.current?.name ?? null;
    } catch {
      testName = null;
    }
    rawAppendFileSync(
      OBSERVE_FILE,
      JSON.stringify({
        path: path.resolve(String(target)),
        fn: fnName,
        test: testName,
        testPath: process.env["VITEST_WORKER_ID"] ?? null,
        at: Date.now(),
      }) + "\n",
      "utf8"
    );
  } catch {
    // Never let bookkeeping fail a test run.
  }
}

function isInRepoTree(target: unknown): boolean {
  if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) {
    return false;
  }
  let resolved: string;
  try {
    resolved = target instanceof URL
      ? path.resolve(target.pathname)
      : path.resolve(target.toString());
  } catch {
    return false;
  }
  if (!resolved.startsWith(REPO_ROOT + path.sep)) return false;
  for (const allowed of REPO_ALLOWED) {
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return false;
  }
  return true;
}

function refuseRepo(fnName: string, target: unknown): never {
  throw new Error(
    `[zone-repo-guard] ${fnName} tried to write inside the repository tree: ` +
      `${String(target)}\n` +
      `Tests must not write into ${REPO_ROOT}. Two incidents did (ledger items ` +
      `233 and 235): one left a source file at the repository root that a ` +
      `concurrent compile picked up, one left a fixture in a tracked directory. ` +
      `Write to a temp directory (fs.mkdtempSync(path.join(os.tmpdir(), …))) and ` +
      `remove it in an afterAll/finally instead.`
  );
}

/** Observe or enforce. Split out so the two modes cannot drift apart. */
function handleRepoWrite(fnName: string, target: unknown): void {
  repoWriteCount += 1;
  if (REPO_OBSERVE) {
    observeRepoWrite(fnName, target);
    return;
  }
  refuseRepo(fnName, target);
}

/** Test-only: the guarded-call and repo-write counters, for the overhead figure. */
export function _repoGuardCountersForTest(): { guarded: number; repoWrites: number } {
  return { guarded: guardedCallCount, repoWrites: repoWriteCount };
}

/** Test-only: expose the predicate so its reach can be asserted directly. */
export function _isInRepoTreeForTest(target: unknown): boolean {
  return isInRepoTree(target);
}

/** Test-only: whether observe mode is active, so a self-test can assert the
 *  mode-appropriate outcome instead of hardcoding "always throws" — which is
 *  only true under enforce mode. `REPO_OBSERVE` is read once at module load
 *  (see its own comment), so this reflects the value for this whole process,
 *  not a live re-read. */
export function _repoGuardObserveModeForTest(): boolean {
  return REPO_OBSERVE;
}

function isInRealZone(target: unknown): boolean {
  if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) {
    return false;
  }
  let resolved: string;
  try {
    resolved = target instanceof URL
      ? path.resolve(target.pathname)
      : path.resolve(target.toString());
  } catch {
    return false;
  }
  return resolved === REAL_ZONE || resolved.startsWith(REAL_ZONE + path.sep);
}

function refuse(fnName: string, target: unknown): never {
  throw new Error(
    `[zone-home-guard] ${fnName} tried to write inside the real home: ` +
      `${String(target)}\n` +
      `Tests must never touch ${REAL_ZONE}. HOME is redirected suite-wide ` +
      `(vitest.config.ts test.env.HOME) — a write that reaches here means the ` +
      `module resolved its path at load time, or bypassed os.homedir().`
  );
}

type AnyFn = (...args: never[]) => unknown;

function wrap<T extends AnyFn>(original: T, fnName: string): T {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    guardedCallCount += 1;
    if (isInRealZone(args[0])) refuse(fnName, args[0]);
    if (isInRepoTree(args[0])) handleRepoWrite(fnName, args[0]);
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

// The promises API must reject rather than throw synchronously: a caller that
// holds the promise before awaiting it would otherwise see the error at a
// different point than the real fs would produce it.
function wrapAsync<T extends AnyFn>(original: T, fnName: string): T {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    guardedCallCount += 1;
    if (isInRealZone(args[0])) {
      try {
        refuse(fnName, args[0]);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (isInRepoTree(args[0])) {
      try {
        handleRepoWrite(fnName, args[0]);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

// Sync surface. Every ~/.zone writer's first argument is the path it targets.
const SYNC_WRITES = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "copyFileSync",
  "createWriteStream",
] as const;

for (const name of SYNC_WRITES) {
  const original = (fs as unknown as Record<string, AnyFn>)[name];
  if (typeof original === "function") {
    (fs as unknown as Record<string, AnyFn>)[name] = wrap(original, name);
  }
}

// Promises surface. snapshotStore imports this object by name, so mutating its
// properties is seen at its call sites.
const PROMISE_WRITES = [
  "writeFile",
  "appendFile",
  "mkdir",
  "rename",
  "unlink",
  "rm",
  "rmdir",
  "copyFile",
] as const;

for (const name of PROMISE_WRITES) {
  const original = (fs.promises as unknown as Record<string, AnyFn>)[name];
  if (typeof original === "function") {
    (fs.promises as unknown as Record<string, AnyFn>)[name] = wrapAsync(original, `promises.${name}`);
  }
}

// The redirect itself. If this ever stops being applied, every worker says so
// on the first test rather than the suite passing while writing to the real
// home — the failure mode this whole file exists to make impossible.
if (path.resolve(process.env["HOME"] ?? "") === path.resolve(realUserHome())) {
  throw new Error(
    "[zone-home-guard] HOME is not redirected — tests would write to the real " +
      `${REAL_ZONE}. Check test.env.HOME in vitest.config.ts.`
  );
}
