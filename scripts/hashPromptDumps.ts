/**
 * The pooling instrument for the notice-regression captures: hashes each run's
 * `system-prompt-with-notice-*.txt` dump and groups run tags by hash, so "do these two runs share a
 * prompt" is answered by a command instead of a remembered `sha256sum` recipe.
 *
 * WHY THIS EXISTS. The probe (`scripts/notice-regression-probe.mjs`) writes the dump files but
 * computes no hash of its own — `command grep -c "sha256\|createHash\|hash"` over the script returns
 * zero. Item 157 established byte-identity across three post-fix dumps by running `sha256sum` by
 * hand; that check is real but ad hoc, and a pooling decision this load-bearing (item 251 and item
 * 157 both refuse to pool cells whose prompts differ) deserves a checkable instrument, not a typed
 * command a future pass has to remember to re-run identically.
 *
 * WHAT IT DOES NOT DO. It does not read `.zone/memory.md`, does not call any LLM, and does not know
 * which hash is "pre-fix" or "post-fix" — it reports the partition, and the caller reads the
 * per-run-tag membership against whatever they already know about when each run happened.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Tagged: `system-prompt-with-notice-<runTag>.txt`. Untagged: `system-prompt-with-notice.txt` —
 *  the single-task convenience path's own name, with no trailing hyphen before `.txt`. Both are
 *  real dumps; matching only the hyphenated shape silently dropped the untagged one (found by a
 *  fixture test, not by inspection — the untagged form has no separator to slice on). */
const DUMP_FILE_RE = /^system-prompt-with-notice(?:-(.+))?\.txt$/;

export interface DumpEntry {
  runTag: string;
  hash: string;
  fileName: string;
  bytes: number;
}

export interface HashGroup {
  hash: string;
  runTags: string[];
}

export function loadDumps(capturesDir: string): DumpEntry[] {
  const entries: DumpEntry[] = [];
  for (const fileName of fs.readdirSync(capturesDir)) {
    const m = DUMP_FILE_RE.exec(fileName);
    if (!m) continue;
    const content = fs.readFileSync(path.join(capturesDir, fileName));
    entries.push({
      runTag: m[1] ?? "(untagged)",
      hash: crypto.createHash("sha256").update(content).digest("hex"),
      fileName,
      bytes: content.length,
    });
  }
  return entries.sort((a, b) => a.runTag.localeCompare(b.runTag));
}

/** Groups run tags by hash value — the actual pooling partition, not just a per-file hash list. */
export function groupByHash(dumps: DumpEntry[]): HashGroup[] {
  const byHash = new Map<string, string[]>();
  for (const d of dumps) {
    if (!byHash.has(d.hash)) byHash.set(d.hash, []);
    byHash.get(d.hash)!.push(d.runTag);
  }
  return [...byHash.entries()]
    .map(([hash, runTags]) => ({ hash, runTags: runTags.sort() }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
}

export function report(capturesDir: string): string {
  const dumps = loadDumps(capturesDir);
  const groups = groupByHash(dumps);
  const lines: string[] = [];
  lines.push(`${dumps.length} dump(s), ${groups.length} distinct prompt(s)`);
  for (const g of groups) {
    lines.push(`  ${g.hash.slice(0, 16)}…  (${g.runTags.length} run-tag(s)): ${g.runTags.join(", ")}`);
  }
  if (groups.length > 1) {
    lines.push(
      `${groups.length} distinct prompts found — cells whose run tags fall in different groups ` +
        `may NOT be pooled; each group is its own population.`
    );
  }
  return lines.join("\n");
}

function main(): void {
  const dir = process.argv[2] ?? ".zone/audits/notice-regression-arm";
  if (!fs.existsSync(dir)) {
    console.error(`[hash-dumps] no captures directory at ${dir}`);
    process.exit(1);
  }
  console.log(report(dir));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
