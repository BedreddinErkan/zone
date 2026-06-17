import fs from "node:fs/promises";
import path from "node:path";

const _checked = new Set<string>(); // once-per-process dedup; each repoPath checked at most once

export async function ensureZoneGitignore(repoPath: string): Promise<void> {
  if (_checked.has(repoPath)) return;
  _checked.add(repoPath); // mark before I/O so concurrent calls don't double-fire
  try {
    await fs.access(path.join(repoPath, ".git")); // ENOENT → not a git repo → caught below
    const gitignorePath = path.join(repoPath, ".gitignore");
    let existing: string | null = null;
    try {
      existing = await fs.readFile(gitignorePath, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (existing === null) {
      await fs.writeFile(gitignorePath, ".zone/\n", "utf-8");
    } else if (!/^\.zone\/?$/m.test(existing)) {
      const append = existing.endsWith("\n") ? ".zone/\n" : "\n.zone/\n";
      await fs.appendFile(gitignorePath, append, "utf-8");
    }
  } catch {
    // non-fatal: never throw into a run; _checked already set so no retry storm
  }
}
