import os from "node:os";
import path from "node:path";

/**
 * Directory that stands in for the user's home for the whole test run.
 *
 * `vitest.config.ts` imports this and puts it in `test.env.HOME`, so every
 * `os.homedir()` call inside a worker resolves here instead of the real home.
 * Node re-reads `$HOME` on every `os.homedir()` call, so this covers writers
 * that resolve their path lazily without any per-module cooperation.
 *
 * Pid-suffixed: a single-file run started alongside a full run must not delete
 * the other's home in `globalSetup`. Kept dependency-free (node builtins only)
 * because `vitest.config.ts` loads it before the test environment exists.
 */
export function zoneTestHome(): string {
  return path.join(os.tmpdir(), `zone-vitest-home-${process.pid}`);
}

/**
 * The real home, read from the passwd database rather than `$HOME`, so it stays
 * correct after the redirect above is applied. This is what the guard compares
 * against — using `os.homedir()` here would return the temp home and the guard
 * would silently permit everything.
 */
export function realUserHome(): string {
  return os.userInfo().homedir;
}

/** The directory no test may ever write to. */
export function realZoneDir(): string {
  return path.join(realUserHome(), ".zone");
}

/**
 * Directory names inside the repository that a test run may legitimately write
 * to (ledger item 236). Held here, as bare names rather than resolved paths, so
 * the two halves of the repository guard cannot drift apart: `homeGuard.ts`
 * refuses writes at the call, `globalHome.ts` diffs an inventory at teardown,
 * and an allowlist that differed between them would make one half's silence
 * meaningless.
 *
 * One measured reason each — no unexplained entries:
 *  - `node_modules`: vitest writes `.vite/vitest/results.json` on every run.
 *  - `.git`: version-control plumbing, not test output.
 *
 * `dist` and `.zone` are deliberately absent. A full clean run was inventoried
 * at 5,840 files before and after and wrote to neither, so listing them would
 * exempt exactly the directories an accidental write should be caught in — and
 * both are named in item 236's own text as assumed-necessary exemptions, which
 * the measurement contradicts.
 */
export const REPO_GUARD_ALLOWED_DIRS: readonly string[] = ["node_modules", ".git"];
