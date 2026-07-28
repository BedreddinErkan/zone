import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The home guard (src/test/setup/homeGuard.ts) intercepts writes by assigning
 * over the fs module's properties. That is seen by `import fs from "node:fs"`
 * and by `import { promises as fsp }` — but NOT by
 * `import { writeFileSync } from "node:fs"`, because a named function import
 * snapshots the binding at evaluation and never sees the later assignment.
 * Probed, not assumed: the named-import case reaches the real fs.
 *
 * So a new ~/.zone writer that imports fs write functions by name would be
 * invisible to the guard — installed and inert, the same failure vi.spyOn would
 * have caused, arriving by a different route. This test is what makes the
 * guard's reach a property of the codebase rather than of the four modules
 * someone happened to convert.
 *
 * The rule: if you resolve a path under homedir(), import the fs namespace.
 */

const SRC = path.resolve(import.meta.dirname, "..");

const WRITE_FNS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "copyFileSync",
  "createWriteStream",
  "writeFile",
  "appendFile",
];

const NAMED_FS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g;

// src/test is the harness, not a ~/.zone writer — and homeGuard.ts quotes the
// anti-pattern in its own documentation, which the text scan below would
// otherwise flag.
const SKIP_DIRS = new Set(["node_modules", "__tests__", "test"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && path.dirname(full) === SRC) continue;
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("modules that resolve under homedir() import fs as a namespace", () => {
  it("has no writer the home guard cannot intercept", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("homedir()")) continue;

      for (const match of source.matchAll(NAMED_FS_IMPORT)) {
        const bound = match[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
        const writes = bound.filter((name) => WRITE_FNS.includes(name));
        if (writes.length > 0) {
          offenders.push(`${path.relative(SRC, file)} imports { ${writes.join(", ")} } by name`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("would catch a named write import — the detector is not vacuous", () => {
    // Guards the guard: if WRITE_FNS or the regex drifted, the check above would
    // pass by never matching anything.
    const sample = 'import { writeFileSync, readFileSync } from "node:fs";\nhomedir()';
    const found = [...sample.matchAll(NAMED_FS_IMPORT)].flatMap((m) =>
      m[1]!.split(",").map((s) => s.trim()).filter((n) => WRITE_FNS.includes(n))
    );
    expect(found).toEqual(["writeFileSync"]);
  });
});
