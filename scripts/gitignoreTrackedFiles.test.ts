import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ledger item 130 — a path that is BOTH tracked and matched by an ignore pattern falls in a gap
 * between two correct behaviours: git declines to ignore it (patterns do not apply to files
 * already tracked), while every ignore-honouring search tool drops it. The file is then invisible
 * to search while remaining fully present in the repository, and nothing announces the skip.
 *
 * This repository had exactly one such path — `CLAUDE.md`, listed in `.gitignore` a day before the
 * decision to track it and never cleaned up afterwards. Three consumers were measured dropping it:
 * ripgrep (which `search_in_files` wraps and which honours `.gitignore` natively), fast-glob via
 * `gitignoreGlobs()` in `src/tools/searchIgnore.ts` (which `list_files` and `find_references` use),
 * and the interactive shell's own `grep`. Deleting the pattern closed all three at once.
 *
 * This test keeps it closed. Both of its inputs are committed text — the index and `.gitignore` —
 * which is what makes the invariant checkable at all rather than merely a discipline to remember.
 *
 * Scoped to files PRESENT ON DISK deliberately: a tracked path that has been deleted in the working
 * tree is invisible to every tool regardless of ignore rules, so it is not the gap this guards
 * against. `.claude/scheduled_tasks.lock` is exactly that case and is correctly not a failure here.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/** Paths in the index, filtered to those that actually exist in the working tree. */
function trackedFilesOnDisk(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
}

/**
 * Which of `paths` match an ignore pattern, asking git with `--no-index` so the answer is about the
 * PATTERNS rather than about tracked status — plain `check-ignore` reports nothing for a tracked
 * file, which is the very asymmetry this entry is about.
 *
 * `git check-ignore` exits 1 when nothing matches. That is this test's PASS state, not an error, and
 * it shares an exit code with "no paths given" — so exit 1 is translated to an empty result and only
 * other non-zero statuses are allowed to propagate.
 */
function ignoreMatched(paths: string[]): string[] {
  if (paths.length === 0) return [];
  try {
    const out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: REPO_ROOT,
      input: paths.join("\n"),
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

describe("no tracked file is hidden from search by an ignore pattern (ledger item 130)", () => {
  it("every tracked, on-disk path is visible to ignore-honouring tools", () => {
    const tracked = trackedFilesOnDisk();
    // Floor: the instrument must be able to see the repository at all. Without this a broken
    // git invocation returning nothing would read as a clean pass.
    expect(tracked.length).toBeGreaterThan(100);

    const hidden = ignoreMatched(tracked);
    expect(
      hidden,
      hidden.length === 0
        ? ""
        : `Tracked file(s) matched by an ignore pattern, and therefore invisible to ripgrep, ` +
          `fast-glob via gitignoreGlobs(), and any other ignore-honouring tool — while git itself ` +
          `still tracks them:\n  ${hidden.join("\n  ")}\n\n` +
          `Reproduce the diagnosis with the pair that disagrees (see ledger item 130):\n` +
          `  git check-ignore -v <path>             # no output, exit 1 — git does NOT ignore it\n` +
          `  git check-ignore --no-index -v <path>  # names the pattern, exit 0 — but tools do\n\n` +
          `Fix by removing the pattern, not by untracking the file.`
    ).toEqual([]);
  });
});
