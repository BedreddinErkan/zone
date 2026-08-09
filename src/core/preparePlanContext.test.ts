import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { preparePlanContext } from "./preparePlanContext.js";

describe("preparePlanContext — grep-grounded file injection (Fix C)", () => {
  const tmpDirs: string[] = [];

  async function makeTmpRepo(files: Record<string, string>): Promise<string> {
    const dir = join(tmpdir(), `prep-ctx-test-${randomBytes(6).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf-8");
    }
    tmpDirs.push(dir);
    return dir;
  }

  // Pins both env reads reachable from this call graph (scanRepo.ts's
  // ZONE_MAX_SCANNED_FILES, rankRelevantFiles.ts's MAX_CONTEXT_FILES) to their own
  // coded defaults, so every test here runs against a known environment rather than
  // whatever the developer's shell happens to hold — same failure shape a4824f39 fixed
  // for a leaked stub in a sibling file, mirrored here for an absent one.
  beforeEach(() => {
    vi.stubEnv("ZONE_MAX_SCANNED_FILES", "2000");
    vi.stubEnv("MAX_CONTEXT_FILES", "5");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("includes a file matched by rg even if it wouldn't rank lexically", async () => {
    // symbolFile has the symbol cumulativeTokens but a completely unrelated name
    // lexicalFile has a name matching the task keyword "store"
    const repoPath = await makeTmpRepo({
      "xyzSymbolFile.ts": "export const cumulativeTokens = 0;\n",
      "store.ts": "export const storeValue = 1;\n",
    });

    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });

    // The file containing the symbol must appear in relevantFilePaths
    expect(ctx.relevantFilePaths).toContain("xyzSymbolFile.ts");
  });

  it("does not duplicate a file already ranked by lexical scorer", async () => {
    const repoPath = await makeTmpRepo({
      "cumulativeTokens.ts": "export const cumulativeTokens = 0;\n",
    });

    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });

    const count = ctx.relevantFilePaths.filter(p => p === "cumulativeTokens.ts").length;
    expect(count).toBe(1);
  });

  it("returns an empty relevantFilePaths when the repo is empty", async () => {
    const repoPath = await makeTmpRepo({});
    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });
    expect(ctx.relevantFilePaths).toEqual([]);
  });

  it("totalFileCount reports scanRepo's own total, independent of ranking/grep", async () => {
    const repoPath = await makeTmpRepo({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
      "c.ts": "export const c = 1;\n",
    });

    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });

    expect(ctx.totalFileCount).toBe(3);
  });

  it("rankedFileScores carries a positive score for the lexically-relevant file, keyed by path", async () => {
    const repoPath = await makeTmpRepo({
      "target.ts": "export const cumulativeTokens = 0;\nexport const cumulativeTokens2 = cumulativeTokens;\n",
      "other.ts": "export const unrelatedValue = 1;\n",
    });

    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });

    const targetEntry = ctx.rankedFileScores.find((f) => f.path === "target.ts");
    expect(targetEntry?.score).toBeGreaterThan(0);
    const otherEntry = ctx.rankedFileScores.find((f) => f.path === "other.ts");
    expect(otherEntry?.score ?? 0).toBeLessThan(targetEntry!.score);
  });

  it("grepMatchedPaths carries the raw rg hit, independent of the ranked/deduped merge", async () => {
    const repoPath = await makeTmpRepo({
      "xyzSymbolFile.ts": "export const cumulativeTokens = 0;\n",
      "store.ts": "export const storeValue = 1;\n",
    });

    const ctx = await preparePlanContext({
      task: "rename cumulativeTokens everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });

    expect(ctx.grepMatchedPaths).toContain("xyzSymbolFile.ts");
  });
});

describe("preparePlanContext — grep pattern is entity-shaped, not every 5+ char task word", () => {
  const tmpDirs: string[] = [];

  async function makeTmpRepo(files: Record<string, string>): Promise<string> {
    const dir = join(tmpdir(), `prep-ctx-entity-test-${randomBytes(6).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf-8");
    }
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.stubEnv("ZONE_MAX_SCANNED_FILES", "2000");
    vi.stubEnv("MAX_CONTEXT_FILES", "5");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  // Shared fixture/task for the three tests below: a rare camelCase symbol, two files
  // that only contain common English words the old tokeniser would have grepped, and
  // a file that only contains a stopword the task happens to quote. One task, three
  // single-assertion tests — a shared setup with stacked expects would let an earlier
  // failure hide a later one (this arc's own tenth-pattern rule).
  const TASK = 'rename distinctiveSymbolName in the "test" module everywhere';

  it("includes the file containing the task's real identifier", async () => {
    const repoPath = await makeTmpRepo({
      "target.ts": "export const distinctiveSymbolName = 0;\n",
      "decoy1.ts": "// rename everything here\n",
      "decoy2.ts": "// this file mentions everywhere and rename too\n",
      "decoy4.ts": "// this is a test file for verification\n",
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths).toContain("target.ts");
  });

  it("excludes files matching only common words the old tokeniser would have grepped", async () => {
    const repoPath = await makeTmpRepo({
      "target.ts": "export const distinctiveSymbolName = 0;\n",
      "decoy1.ts": "// rename everything here\n",
      "decoy2.ts": "// this file mentions everywhere and rename too\n",
      "decoy4.ts": "// this is a test file for verification\n",
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths.filter((p) => p === "decoy1.ts" || p === "decoy2.ts")).toEqual([]);
  });

  it("excludes a file matching only a stopword the task quotes", async () => {
    const repoPath = await makeTmpRepo({
      "target.ts": "export const distinctiveSymbolName = 0;\n",
      "decoy1.ts": "// rename everything here\n",
      "decoy2.ts": "// this file mentions everywhere and rename too\n",
      "decoy4.ts": "// this is a test file for verification\n",
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths).not.toContain("decoy4.ts");
  });

  it("a task built entirely of common words returns no grep matches", async () => {
    const repoPath = await makeTmpRepo({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
    });
    const ctx = await preparePlanContext({
      task: "fix the bug in the app",
      repoPath,
      repoSummaryOverride: "test repo",
    });
    expect(ctx.grepMatchedPaths).toEqual([]);
  });

  it("the four-file cap still applies when more than four files match", async () => {
    const repoPath = await makeTmpRepo({
      "file1.ts": "export const distinctiveSymbolName1 = distinctiveSymbolName;\n",
      "file2.ts": "export const distinctiveSymbolName2 = distinctiveSymbolName;\n",
      "file3.ts": "export const distinctiveSymbolName3 = distinctiveSymbolName;\n",
      "file4.ts": "export const distinctiveSymbolName4 = distinctiveSymbolName;\n",
      "file5.ts": "export const distinctiveSymbolName5 = distinctiveSymbolName;\n",
    });
    const ctx = await preparePlanContext({
      task: "rename distinctiveSymbolName everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });
    expect(ctx.grepMatchedPaths.length).toBe(4);
  });
});
