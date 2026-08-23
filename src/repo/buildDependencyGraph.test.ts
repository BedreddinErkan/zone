import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDependencyGraph } from "./buildDependencyGraph.js";

/**
 * First real vitest coverage for this module (items 288/289/290). Its absence
 * is why the resolver, the analysis cap, and the enumeration-order dependency
 * all shipped and went unnoticed — see docs/deferred-work.md items 280/288-290.
 *
 * Every fixture repo is a fresh temp directory so `stagingFiles?.size` stays
 * falsy and every call reads the real, uncached path (the module's own 60s
 * in-process cache is keyed on repoPath + file list, so distinct repos never
 * collide, but a fresh dir per test avoids relying on that for isolation).
 */

let repoPath: string;

function write(rel: string, content: string): void {
  const full = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function listFilesRelative(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  }
  walk(dir);
  return results;
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-depgraph-test-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("resolver (item 288) — .js specifier resolves to its .ts sibling", () => {
  it("the core fix: an ESM-style .js specifier resolves against the real .ts file", () => {
    write("src/logger.ts", "export const log = (...a: unknown[]) => console.log(...a);\n");
    write("src/caller.ts", 'import { log } from "./logger.js";\nlog("hi");\n');
    const files = listFilesRelative(repoPath);
    return buildDependencyGraph(repoPath, files).then((graph) => {
      const caller = graph.nodes.get("src/caller.ts");
      expect(caller).toBeDefined();
      expect(caller!.imports).toEqual(["src/logger.ts"]);
      const target = graph.nodes.get("src/logger.ts");
      expect(target!.importedBy).toEqual(["src/caller.ts"]);
    });
  });

  it("existing noExt behaviour is unchanged — regression pin", async () => {
    write("src/util.ts", "export const id = (x: unknown) => x;\n");
    write("src/user.ts", 'import { id } from "./util";\n');
    const files = listFilesRelative(repoPath);
    const graph = await buildDependencyGraph(repoPath, files);
    expect(graph.nodes.get("src/user.ts")!.imports).toEqual(["src/util.ts"]);
  });

  it("HOSTILE INPUT: a literal .js target that exists on disk wins over the .ts swap (the dist/ case)", async () => {
    // Mirrors scripts/ importing built output: a real .js file exists at the
    // exact specifier path, AND a same-stem .ts file also exists elsewhere-
    // reachable. The literal match must win — extension-swap is a fallback,
    // not a reordering of paths that already resolve.
    write("built/thing.js", "module.exports.thing = 1;\n");
    write("built/thing.ts", "export const thing = 2; // must NOT be the resolved target\n");
    write("caller.js", 'const { thing } = require("./built/thing.js");\nthing;\n');
    const files = listFilesRelative(repoPath);
    const graph = await buildDependencyGraph(repoPath, files);
    expect(graph.nodes.get("caller.js")!.imports).toEqual(["built/thing.js"]);
  });

  it("precedence when both .ts and .tsx candidates are present (defensive — no live collision exists in the real repo, see item 288's own establish)", async () => {
    write("src/widget.ts", "export const fromTs = true;\n");
    write("src/widget.tsx", "export const fromTsx = true;\n");
    write("src/user.ts", 'import { fromTs } from "./widget.js";\n');
    const files = listFilesRelative(repoPath);
    const graph = await buildDependencyGraph(repoPath, files);
    // .ts is tried before .tsx in the swap list, matching the existing noExt
    // branch's own precedence order.
    expect(graph.nodes.get("src/user.ts")!.imports).toEqual(["src/widget.ts"]);
  });
});

describe("resolver — item 294/295's known limitation, pinned rather than left implicit (per item 288's own H5/J4 establish)", () => {
  it("ACCEPTING side: a specifier inside a comment resolves if a coincidental .ts sibling exists — a known, bounded phantom, not a bug this test hides", async () => {
    write("src/real.ts", "export const real = 1;\n");
    write("src/caller.ts", [
      '// TODO: consider import("./real.js") once ready — not a real import, just prose',
      "export const noop = 1;",
      "",
    ].join("\n"));
    const files = listFilesRelative(repoPath);
    const graph = await buildDependencyGraph(repoPath, files);
    // The regex-based extractor has no comment awareness (item 294) — the
    // dynamic-import pass matches `import("...")` regardless of context, and
    // the fixed resolver then resolves it. Accepted and documented, not
    // silently hidden.
    expect(graph.nodes.get("src/caller.ts")!.imports).toContain("src/real.ts");
  });

  it("COMPANION: the same non-statement-context specifier with NO coincidental sibling produces NO edge — without this, the accepting-side test alone can't distinguish a bounded phantom from an unconditional one", async () => {
    write("src/caller.ts", [
      '// TODO: consider import("./nonexistent.js") once ready — not a real import',
      "export const noop = 1;",
      "",
    ].join("\n"));
    const files = listFilesRelative(repoPath);
    const graph = await buildDependencyGraph(repoPath, files);
    expect(graph.nodes.get("src/caller.ts")!.imports).toEqual([]);
  });
});

describe("cap (item 289) — no positional truncation", () => {
  it("a file placed past the old 300-file boundary still gets a node", async () => {
    for (let i = 0; i < 305; i++) {
      write(`src/filler${i}.ts`, `export const v${i} = ${i};\n`);
    }
    write("src/late.ts", "export const late = true;\n");
    const files = listFilesRelative(repoPath);
    expect(files.length).toBeGreaterThan(300);
    const graph = await buildDependencyGraph(repoPath, files);
    expect(graph.nodes.has("src/late.ts")).toBe(true);
    expect(graph.nodes.get("src/late.ts")!.exports).toContain("late");
  });
});

describe("ordering (item 290) — stable regardless of input order", () => {
  function setupOrderingFixture(): void {
    write("src/shared.ts", "export const shared = true;\n");
    write("src/a.ts", 'import { shared } from "./shared.js";\n');
    write("src/b.ts", 'import { shared } from "./shared.js";\n');
    write("src/c.ts", 'import { shared } from "./shared.js";\n');
  }

  it("two different shuffles of the same file list produce an identical node-key SET", async () => {
    setupOrderingFixture();
    const files = listFilesRelative(repoPath);
    const shuffleA = [...files].reverse();
    const shuffleB = [...files].sort(() => 0.5 - Math.random());
    // Bypass the 60s in-process cache (keyed on repoPath+fileList) by using a
    // non-empty stagingFiles map with distinct content each call.
    const gA = await buildDependencyGraph(repoPath, shuffleA, new Map([["/x/bustA.ts", "x"]]));
    const gB = await buildDependencyGraph(repoPath, shuffleB, new Map([["/x/bustB.ts", "x"]]));
    expect([...gB.nodes.keys()].sort()).toEqual([...gA.nodes.keys()].sort());
  });

  it("importedBy array ORDER is identical across the same two shuffles (only true once sorted)", async () => {
    setupOrderingFixture();
    const files = listFilesRelative(repoPath);
    const shuffleA = [...files].reverse();
    const shuffleB = [...files].sort(() => 0.5 - Math.random());
    const gA = await buildDependencyGraph(repoPath, shuffleA, new Map([["/x/bustC.ts", "x"]]));
    const gB = await buildDependencyGraph(repoPath, shuffleB, new Map([["/x/bustD.ts", "x"]]));
    expect(gB.nodes.get("src/shared.ts")!.importedBy).toEqual(
      gA.nodes.get("src/shared.ts")!.importedBy
    );
  });

  it("nodes.keys() ITERATION order is identical across the same two shuffles", async () => {
    setupOrderingFixture();
    const files = listFilesRelative(repoPath);
    const shuffleA = [...files].reverse();
    const shuffleB = [...files].sort(() => 0.5 - Math.random());
    const gA = await buildDependencyGraph(repoPath, shuffleA, new Map([["/x/bustE.ts", "x"]]));
    const gB = await buildDependencyGraph(repoPath, shuffleB, new Map([["/x/bustF.ts", "x"]]));
    expect([...gB.nodes.keys()]).toEqual([...gA.nodes.keys()]);
  });
});

describe("structural guard — makes a reintroduced high cap a behavioural check, not a source-text one (item H2)", () => {
  it("MAX_ANALYZE and the identifier 'analyzed' do not appear in the module source", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "buildDependencyGraph.ts"),
      "utf8"
    );
    // Plausibility floor: without this, a read that silently returned "" (wrong
    // path, ENOENT swallowed upstream) would make both not.toMatch assertions
    // below pass vacuously — the exact vacuous-guard shape this project has
    // caught before. This line is what makes N8 (empty the read) fail loudly.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toMatch(/\bMAX_ANALYZE\b/);
    expect(src).not.toMatch(/\banalyzed\b/);
  });
});
