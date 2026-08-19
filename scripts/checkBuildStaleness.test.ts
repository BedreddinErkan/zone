import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isBuildRelevantSource,
  describeBuildStaleness,
  computeBuildStaleness,
  assertBuildFresh,
} from "./checkBuildStaleness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── isBuildRelevantSource — mirrors tsconfig.json's exclude list for src/ ────────────────────

describe("isBuildRelevantSource", () => {
  it("accepts a .ts file", () => {
    expect(isBuildRelevantSource("llm/verification/classify.ts")).toBe(true);
  });

  it("accepts a .tsx file", () => {
    expect(isBuildRelevantSource("cli/tui/components/Composer.tsx")).toBe(true);
  });

  it("rejects a .test.ts file", () => {
    expect(isBuildRelevantSource("llm/verification/classify.test.ts")).toBe(false);
  });

  it("rejects a .test.tsx file", () => {
    expect(isBuildRelevantSource("cli/tui/components/Composer.test.tsx")).toBe(false);
  });

  it("rejects a file nested under any __tests__ directory", () => {
    expect(isBuildRelevantSource("core/__tests__/runVerifyDiagnosticManual.ts")).toBe(false);
  });

  it("rejects the top-level extension.ts exclusion by name", () => {
    expect(isBuildRelevantSource("extension.ts")).toBe(false);
  });

  it("rejects a non-.ts/.tsx extension", () => {
    expect(isBuildRelevantSource("prompts/note.md")).toBe(false);
  });

  it("accepts src/test/testHome.ts — 'test' in the path is not the same as *.test.ts or __tests__/", () => {
    expect(isBuildRelevantSource("test/testHome.ts")).toBe(true);
  });
});

// ─── describeBuildStaleness — pure, no fs ──────────────────────────────────────────────────────

describe("describeBuildStaleness", () => {
  it("returns null when sourceFiles is empty", () => {
    expect(describeBuildStaleness({ buildTimeMs: 1000, sourceFiles: [] })).toBeNull();
  });

  it("returns null when every source file is at or before the build time", () => {
    const result = describeBuildStaleness({
      buildTimeMs: 1000,
      sourceFiles: [
        { relPath: "a.ts", mtimeMs: 500 },
        { relPath: "b.ts", mtimeMs: 1000 },
      ],
    });
    expect(result).toBeNull();
  });

  it("names the single newer file when exactly one exists", () => {
    const result = describeBuildStaleness({
      buildTimeMs: 1000,
      sourceFiles: [{ relPath: "llm/verification/classify.ts", mtimeMs: 2000 }],
    });
    expect(result).toContain("1 source file ");
    expect(result).toContain("llm/verification/classify.ts");
  });

  it("counts every newer file but names only the single newest one, not the first-encountered", () => {
    const result = describeBuildStaleness({
      buildTimeMs: 1000,
      sourceFiles: [
        { relPath: "a.ts", mtimeMs: 500 },   // older — excluded from the count
        { relPath: "b.ts", mtimeMs: 2000 },  // newer, not the newest
        { relPath: "c.ts", mtimeMs: 3000 },  // newer, and the newest
      ],
    });
    expect(result).toContain("2 source files");
    expect(result).toContain("c.ts");
    expect(result).not.toContain("b.ts");
  });

  it("returns the distinct no-build message when buildTimeMs is null, regardless of sourceFiles", () => {
    const result = describeBuildStaleness({
      buildTimeMs: null,
      sourceFiles: [{ relPath: "a.ts", mtimeMs: 999999999999 }],
    });
    expect(result).toContain("no build found");
    expect(result).not.toContain("a.ts");
  });
});

// ─── main() via subprocess — real stdout, real exit code, real fixture trees, ─────────────────
// ─── never this repo's own src/ or dist/                                     ─────────────────

const SCRIPT_PATH = path.resolve(__dirname, "checkBuildStaleness.mjs");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zone-build-staleness-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCheck(env: Record<string, string>): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status };
}

describe("checkBuildStaleness.mjs — subprocess, real exit code and stdout", () => {
  it("drift present: renders and names the newest source file, exits 0", () => {
    const srcDir = makeTempDir();
    const distDir = makeTempDir();
    const proxyPath = path.join(distDir, "index.js");
    writeFileSync(proxyPath, "old build");
    utimesSync(proxyPath, new Date("2020-01-01"), new Date("2020-01-01"));

    writeFileSync(path.join(srcDir, "changed.ts"), "content");
    utimesSync(path.join(srcDir, "changed.ts"), new Date(), new Date());

    const { stdout, status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: proxyPath,
    });
    expect(stdout).toContain("1 source file ");
    expect(stdout).toContain("changed.ts");
    expect(status).toBe(0);
  });

  it("no drift: empty stdout, exits 0", () => {
    const srcDir = makeTempDir();
    const distDir = makeTempDir();
    const proxyPath = path.join(distDir, "index.js");
    writeFileSync(proxyPath, "fresh build");
    // proxy freshly written — its mtime is now, definitionally after any fixture file below

    writeFileSync(path.join(srcDir, "old.ts"), "content");
    utimesSync(path.join(srcDir, "old.ts"), new Date("2020-01-01"), new Date("2020-01-01"));

    const { stdout, status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: proxyPath,
    });
    expect(stdout).toBe("");
    expect(status).toBe(0);
  });

  it("build proxy missing entirely: the distinct absent-build message, exits 0", () => {
    const srcDir = makeTempDir();
    const { stdout, status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: path.join(srcDir, "does-not-exist.js"),
    });
    expect(stdout).toContain("no build found");
    expect(status).toBe(0);
  });

  it("only a *.test.ts file is newer than the build: no warning (E2)", () => {
    const srcDir = makeTempDir();
    const distDir = makeTempDir();
    const proxyPath = path.join(distDir, "index.js");
    writeFileSync(proxyPath, "old build");
    utimesSync(proxyPath, new Date("2020-01-01"), new Date("2020-01-01"));

    writeFileSync(path.join(srcDir, "changed.test.ts"), "content");
    utimesSync(path.join(srcDir, "changed.test.ts"), new Date(), new Date());

    const { stdout, status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: proxyPath,
    });
    expect(stdout).toBe("");
    expect(status).toBe(0);
  });

  it("an old sibling file beside a fresh proxy has no effect — only the named proxy path is read (E3)", () => {
    // Simulates the real dist/roles + dist/prompts orphans: old files sitting next to the
    // real build's own output. A naive "scan the directory for the oldest file" approach
    // would treat the old sibling as the build time and report false drift; this design
    // never scans the directory at all, so it can't regress that way.
    //
    // The source file's mtime is deliberately placed BETWEEN the orphan's timestamp and the
    // proxy's real (fresh) timestamp — newer than the orphan, older than the proxy. That is
    // the only placement that actually discriminates: a source file older than both, or newer
    // than both, gets the same answer whether the check reads the proxy alone or the
    // directory's oldest file, and would pass against either implementation.
    const srcDir = makeTempDir();
    const distDir = makeTempDir();
    const orphanPath = path.join(distDir, "orphaned-output.js");
    writeFileSync(orphanPath, "orphaned");
    utimesSync(orphanPath, new Date("2020-01-01"), new Date("2020-01-01"));

    const proxyPath = path.join(distDir, "index.js");
    writeFileSync(proxyPath, "fresh build");
    // proxy's mtime is now — freshly written, after the orphan above

    writeFileSync(path.join(srcDir, "unchanged.ts"), "content");
    utimesSync(path.join(srcDir, "unchanged.ts"), new Date("2021-01-01"), new Date("2021-01-01"));

    const { stdout, status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: proxyPath,
    });
    expect(stdout).toBe("");
    expect(status).toBe(0);
  });

  it("exits 0 even under a large drift count", () => {
    const srcDir = makeTempDir();
    const distDir = makeTempDir();
    const proxyPath = path.join(distDir, "index.js");
    writeFileSync(proxyPath, "old build");
    utimesSync(proxyPath, new Date("2020-01-01"), new Date("2020-01-01"));

    for (let i = 0; i < 5; i++) {
      const p = path.join(srcDir, `file${i}.ts`);
      writeFileSync(p, "content");
      utimesSync(p, new Date(), new Date());
    }

    const { status } = runCheck({
      ZONE_BUILD_STALENESS_SRC_DIR: srcDir,
      ZONE_BUILD_STALENESS_PROXY_PATH: proxyPath,
    });
    expect(status).toBe(0);
  });
});

// ─── computeBuildStaleness / assertBuildFresh — the shared guard ──────────────────────────────

describe("computeBuildStaleness", () => {
  const dirs: string[] = [];
  function fixture(sourceMtimeOffsetMs: number): { srcDir: string; proxyPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), "build-staleness-fixture-"));
    dirs.push(root);
    const srcDir = path.join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    const proxyPath = path.join(root, "proxy.js");
    writeFileSync(proxyPath, "// build proxy\n");
    const src = path.join(srcDir, "thing.ts");
    writeFileSync(src, "export const x = 1;\n");
    const proxySeconds = 1_700_000_000;
    utimesSync(proxyPath, proxySeconds, proxySeconds);
    const srcSeconds = proxySeconds + sourceMtimeOffsetMs / 1000;
    utimesSync(src, srcSeconds, srcSeconds);
    return { srcDir, proxyPath };
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("reports null when every source predates the build proxy — the fresh case", () => {
    const { srcDir, proxyPath } = fixture(-60_000);
    expect(computeBuildStaleness({ srcDir, proxyPath }).message).toBeNull();
  });

  it("reports a message naming the newest file when a source postdates the proxy — the stale case", () => {
    const { srcDir, proxyPath } = fixture(+60_000);
    const { message } = computeBuildStaleness({ srcDir, proxyPath });
    expect(message).toContain("1 source file changed");
    expect(message).toContain("thing.ts");
  });

  it("returns the tree it walked, so a caller that aborts can name it", () => {
    const { srcDir, proxyPath } = fixture(+60_000);
    expect(computeBuildStaleness({ srcDir, proxyPath }).srcDir).toBe(srcDir);
  });
});

describe("assertBuildFresh", () => {
  const dirs: string[] = [];
  const saved = {
    src: process.env.ZONE_BUILD_STALENESS_SRC_DIR,
    proxy: process.env.ZONE_BUILD_STALENESS_PROXY_PATH,
  };
  function point(offsetMs: number): void {
    const root = mkdtempSync(path.join(tmpdir(), "assert-build-fresh-"));
    dirs.push(root);
    const srcDir = path.join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    const proxyPath = path.join(root, "proxy.js");
    writeFileSync(proxyPath, "// proxy\n");
    const src = path.join(srcDir, "thing.ts");
    writeFileSync(src, "export const x = 1;\n");
    const p = 1_700_000_000;
    utimesSync(proxyPath, p, p);
    utimesSync(src, p + offsetMs / 1000, p + offsetMs / 1000);
    process.env.ZONE_BUILD_STALENESS_SRC_DIR = srcDir;
    process.env.ZONE_BUILD_STALENESS_PROXY_PATH = proxyPath;
  }
  afterEach(() => {
    if (saved.src === undefined) delete process.env.ZONE_BUILD_STALENESS_SRC_DIR;
    else process.env.ZONE_BUILD_STALENESS_SRC_DIR = saved.src;
    if (saved.proxy === undefined) delete process.env.ZONE_BUILD_STALENESS_PROXY_PATH;
    else process.env.ZONE_BUILD_STALENESS_PROXY_PATH = saved.proxy;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns silently on a fresh build", () => {
    point(-60_000);
    expect(() => assertBuildFresh("probe-under-test")).not.toThrow();
  });

  it("throws on a stale build, naming the caller and the staleness message", () => {
    point(+60_000);
    expect(() => assertBuildFresh("probe-under-test")).toThrow(/probe-under-test/);
    expect(() => assertBuildFresh("probe-under-test")).toThrow(/source file changed/);
  });
});

// ─── The invariant, checked against the real tree ─────────────────────────────────────────────
//
// The defect this guard closes is a SHAPE, not one script: an instrument that imports dist/ and
// spends money measures the harness rather than the system whenever dist/ is behind src/. Four
// scripts had it. Pinning the four by name would let a fifth arrive unguarded, so the set is
// DERIVED here by the same two properties that define the shape, and each derived member is then
// required to call the guard before its first billed call. A script that stops importing dist/,
// or stops spending, drops out of the set on its own.

const DIST_IMPORT = /from\s+"[^"]*\/dist\//;
/** Provider-call expressions, not client construction — building a client bills nothing. */
const BILLED_CALL = /\.messages\.create\(|\.responses\.create\(|\.createChatCompletion\(|\bclassifyTask\(|\brunAgentLoop\(/;

function scriptSources(): { file: string; text: string }[] {
  return execSync('git ls-files scripts', { encoding: "utf8", cwd: REPO_ROOT })
    .split("\n")
    .filter((f) => /\.(mjs|ts)$/.test(f) && !/\.test\.ts$/.test(f) && !/\.d\.mts$/.test(f))
    .map((file) => ({ file, text: readFileSync(path.join(REPO_ROOT, file), "utf8") }));
}

/** Anything in an entry path that either bills or resolves a credential. The guard must
 *  precede all of it: reading a key can itself write (the legacy key-file migration), and
 *  a client built before the guard is a client built for a run that must not happen. */
const SPEND_OR_CREDENTIAL =
  /\.messages\.create\(|\.responses\.create\(|\.createChatCompletion\(|\bclassifyTask\(|\brunAgentLoop\(|\bloadDiskKeys\(|\bloadApiKey\(|\breadOpenAiKey\(|new Anthropic\(|new OpenAI\(|createLLMClient\(/;

/** The block that actually runs: `main()`'s body when there is one, else the
 *  `import.meta.url === ...` block.
 *
 *  Brace-balanced, and the balancer SKIPS BACKTICK STRINGS. A first version did not, and
 *  `if (import.meta.url === \`file://${process.argv[1]}\`) {` ended the block at the `}`
 *  of its own interpolation — before the guard, before anything. It reported the one
 *  script whose entry point is that line as unguarded when the guard was its first
 *  statement. The skip is what makes the check read the block rather than a prefix. */
function entryBlock(text: string): string {
  const mainAt = text.search(/^(?:async )?function main\(/m);
  const start = mainAt !== -1 ? mainAt : text.search(/^if \(import\.meta\.url ===/m);
  if (start === -1) return text;
  let depth = 0;
  let seen = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      // consume the whole template literal, interpolations and all
      let tickDepth = 0;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "$" && text[i + 1] === "{") { tickDepth++; i++; continue; }
        if (text[i] === "}" && tickDepth > 0) { tickDepth--; continue; }
        if (text[i] === "`" && tickDepth === 0) break;
      }
      continue;
    }
    if (c === "{") { depth++; seen = true; }
    else if (c === "}") { depth--; if (seen && depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

function costBearingScripts(): string[] {
  return scriptSources()
    .filter(({ text }) => DIST_IMPORT.test(text) && BILLED_CALL.test(text))
    .map(({ file }) => file);
}

describe("build-freshness guard — every script that imports dist/ AND spends", () => {
  it("the derivation finds scripts at all, and finds the four known ones — non-vacuity before any per-script claim", () => {
    const found = costBearingScripts();
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found).toEqual(
      expect.arrayContaining([
        "scripts/dedupe-cache-probe.mjs",
        "scripts/notice-regression-probe.mjs",
        "scripts/openai-cache-probe.mjs",
        "scripts/tier-agreement-probe.mjs",
      ])
    );
  });

  it("a script that imports dist/ but never spends is NOT in the set — the predicate discriminates", () => {
    expect(costBearingScripts()).not.toContain("scripts/tool-mention-defect-sweep.mjs");
  });

  it("a script that spends but never imports dist/ is NOT in the set — it cannot be corrupted by a stale build", () => {
    expect(costBearingScripts()).not.toContain("scripts/thinking-probe.mjs");
  });

  it.each(costBearingScripts())("%s calls assertBuildFresh", (file) => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    expect(text).toMatch(/assertBuildFresh\(/);
  });

  it.each(costBearingScripts())("%s calls it before anything in its entry path that spends or reads a key", (file) => {
    // Ordering is checked inside the ENTRY BLOCK, not across the file. A first attempt
    // compared raw file offsets and failed on three of the four — every one of them
    // defines the helper holding its billed call ABOVE its entry point, so textual order
    // is not execution order. The guard sits at the top of the path that runs.
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const entry = entryBlock(text);
    const guardAt = entry.search(/assertBuildFresh\(["'`]/);
    const spendAt = entry.search(SPEND_OR_CREDENTIAL);
    expect(guardAt, `${file}: no assertBuildFresh in its entry block`).toBeGreaterThan(-1);
    expect(spendAt, `${file}: entry block reaches no spend or credential surface`).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(spendAt);
  });
});
