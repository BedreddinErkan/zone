import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBuildRelevantSource, describeBuildStaleness } from "./checkBuildStaleness.mjs";

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
