import fs from "node:fs";
import path from "node:path";
import { zoneTestHome, realZoneDir, REPO_GUARD_ALLOWED_DIRS } from "../testHome.js";

/**
 * Global setup: create the stand-in home before any worker starts, and prove at
 * teardown that the real ~/.zone was not touched.
 *
 * `test.env.HOME` in vitest.config.ts is what actually redirects the workers.
 * Assigning `process.env.HOME` here as well means forked workers inherit the
 * redirect from the parent environment even if `test.env` were ever dropped —
 * two independent routes to the same directory, each verified sufficient alone,
 * because a silent revert to the real home is the failure this exists to
 * prevent.
 *
 * The inventory below is the backstop to homeGuard.ts. That guard wraps named
 * fs APIs in modules it can reach; this catches everything else — a child
 * process, a native addon, an API nobody thought to wrap.
 */

type Inventory = Map<string, string>;

const EMPTY_SKIP: ReadonlySet<string> = new Set<string>();

let baseline: Inventory | null = null;

/**
 * The second guarded root: the repository tree (ledger item 236).
 *
 * This is the import-style-immune half of the repository guard. `homeGuard.ts`
 * refuses a repo-tree write at the call, but it can only see modules that
 * import the fs namespace — 13 test files import write functions by name and
 * are invisible to it, as are child processes and native addons. This half sees
 * all of them, because it compares the tree against itself. What it cannot see
 * is a file created and deleted inside one run; that is exactly what the other
 * half covers, which is why both exist.
 *
 * Cost measured with this implementation rather than a proxy: 36–52 ms per walk
 * over ~5,847 files, two walks per run, against a suite that takes ~50 s. An
 * earlier estimate of 28 ms came from timing `find` with the same prune list,
 * which understates a JS readdir/stat walk — the proxy was replaced by the real
 * thing rather than carried forward.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let repoBaseline: Inventory | null = null;

function repoSkipSet(): ReadonlySet<string> {
  return new Set(REPO_GUARD_ALLOWED_DIRS.map((d) => path.join(REPO_ROOT, d)));
}

function inventory(dir: string, into: Inventory = new Map(), skip: ReadonlySet<string> = EMPTY_SKIP): Inventory {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into; // absent or unreadable — nothing to protect
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(full)) continue;
      inventory(full, into, skip);
    } else {
      try {
        const st = fs.statSync(full);
        into.set(full, `${st.size}:${st.mtimeMs}`);
      } catch {
        // raced away between readdir and stat; the diff below reports it
      }
    }
  }
  return into;
}

function diff(before: Inventory, after: Inventory): string[] {
  const changes: string[] = [];
  for (const [file, sig] of after) {
    const prior = before.get(file);
    if (prior === undefined) changes.push(`created  ${file}`);
    else if (prior !== sig) changes.push(`modified ${file}`);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push(`deleted  ${file}`);
  }
  return changes;
}

/** Test-only: the two helpers above, so the detection logic has a victim a
 *  mutation can kill. Without this, the only thing that proves the inventory
 *  discriminates is a full suite run with a deliberate write in it. */
export const _inventoryForTest = inventory;
export const _diffForTest = diff;
export const _repoSkipSetForTest = repoSkipSet;
export const _repoRootForTest = REPO_ROOT;

export function setup(): void {
  const home = zoneTestHome();
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  baseline = inventory(realZoneDir());
  repoBaseline = inventory(REPO_ROOT, new Map(), repoSkipSet());
}

export function teardown(): void {
  fs.rmSync(zoneTestHome(), { recursive: true, force: true });

  // Checked before the home diff purely so a repository write, the newer and
  // less familiar failure, is not masked by an unrelated home failure.
  if (repoBaseline) {
    const repoChanges = diff(repoBaseline, inventory(REPO_ROOT, new Map(), repoSkipSet()));
    if (repoChanges.length > 0) {
      throw new Error(
        `[zone-repo-guard] the test run changed ${repoChanges.length} file(s) inside ` +
          `${REPO_ROOT}:\n  ${repoChanges.slice(0, 20).join("\n  ")}\n` +
          (repoChanges.length > 20 ? `  … and ${repoChanges.length - 20} more\n` : "") +
          `Tests must not write into the repository tree — two incidents did ` +
          `(ledger items 233 and 235). Write to a temp directory and remove it ` +
          `in an afterAll/finally instead. (If you edited a file while the suite ` +
          `was running, this is a false positive — re-run on a quiet tree.)`
      );
    }
  }

  if (!baseline) return;
  const changes = diff(baseline, inventory(realZoneDir()));
  if (changes.length === 0) return;

  throw new Error(
    `[zone-home-guard] the test run changed ${changes.length} file(s) inside ` +
      `${realZoneDir()}:\n  ${changes.slice(0, 20).join("\n  ")}\n` +
      (changes.length > 20 ? `  … and ${changes.length - 20} more\n` : "") +
      `Tests must write only to the redirected home. ` +
      `(If you used the Zone CLI while the suite was running, this is a false ` +
      `positive — re-run without touching ~/.zone.)`
  );
}
