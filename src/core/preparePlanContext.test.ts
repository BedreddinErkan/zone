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

  // The merge order (ranked results before grep extras) has no other test anywhere --
  // found while designing a mutation for it. alphaTargetFile.ts wins on an
  // explicit-filename path bonus; quietModuleGamma.ts's content contains the task's
  // entity term (that's what makes it a grep match at all) but its path shares no
  // term with the task, so it scores 0 on path alone.
  //
  // Three earlier fixture attempts failed before this one, each caught only by
  // running the mutation and finding it killed nothing rather than by inspection:
  // (1) "grepOnlyMatch.ts" and (2) a "zzz"-prefixed name each accidentally shared a
  // path term with the task, landing quietModuleGamma in the ranked half by path
  // score alone. (3) A 4-filler version fixed that, but preparePlanContext always
  // calls the ranker WITH readContent (unlike an isolated probe called without it),
  // so applyLexicalBoost's own top-30 content window re-read quietModuleGamma's
  // body, found the same entity term grep matches on, and boosted it back into the
  // ranked top-5 anyway -- the two mechanisms search for identical terms by
  // construction. Thirty filler files (all zero path score, sorted before the decoy)
  // push it past that content-boost window entirely, verified directly both ways
  // (fixed code: index 0 vs 5; the reverted-order mutation: index 1 vs 0) before
  // relying on it here.
  it("places the ranked result before a grep-only match in relevantFilePaths", async () => {
    const fillers = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `aaaFiller${String(i).padStart(2, "0")}.ts`,
        `export const noise${i} = ${i};\n`,
      ])
    );
    const repoPath = await makeTmpRepo({
      "alphaTargetFile.ts": "export const noise = 1;\n",
      "quietModuleGamma.ts": "export const betaUniqueSymbolMarker = 0;\n",
      ...fillers,
    });
    const ctx = await preparePlanContext({
      task: "In alphaTargetFile.ts, rename betaUniqueSymbolMarker everywhere",
      repoPath,
      repoSummaryOverride: "test repo",
    });
    expect(ctx.relevantFilePaths.indexOf("alphaTargetFile.ts")).toBeLessThan(
      ctx.relevantFilePaths.indexOf("quietModuleGamma.ts")
    );
  });
});

describe("preparePlanContext — grep matches are ordered by match count, not walk order", () => {
  const tmpDirs: string[] = [];

  async function makeTmpRepo(files: Record<string, string>): Promise<string> {
    const dir = join(tmpdir(), `prep-ctx-order-test-${randomBytes(6).toString("hex")}`);
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

  const TASK = "rename distinctiveSymbolName everywhere";

  // Each line is its own standalone word-boundary match -- verified directly with
  // `rg --count-matches` before relying on it (the single-line numbered-suffix form
  // used by the sibling cap test above, "distinctiveSymbolName1", does NOT count:
  // the trailing digit blocks the word boundary, confirmed the same way).
  function occurrences(n: number): string {
    return Array.from({ length: n }, (_, i) => `const v${i} = distinctiveSymbolName;\n`).join("");
  }

  it("returns grep matches ordered by match count, descending, as a sequence", async () => {
    const repoPath = await makeTmpRepo({
      "fileA.ts": occurrences(1),
      "fileB.ts": occurrences(2),
      "fileC.ts": occurrences(3),
      "fileD.ts": occurrences(4),
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths).toEqual(["fileD.ts", "fileC.ts", "fileB.ts", "fileA.ts"]);
  });

  // 40 same-count files, not a handful -- raw rg walk order is only reliably unstable
  // at this scale (verified separately: 3 tied files gave a stable order across a
  // probe, 40 gave 10 distinct orderings across 10 repeats). A smaller fixture would
  // risk this test passing under the walk-order fallback (mutation 3) by accident on a
  // machine where raw order happens to be stable at that size. Compares repeats to
  // each other, not to a fixed expected array, so this stays orthogonal to the
  // ordering test above (a reversed-but-still-deterministic sort must not fail this).
  it("returns an identical sequence across repeated calls on the same input", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 40; i++) {
      files[`detFile${String(i).padStart(2, "0")}.ts`] = occurrences(1);
    }
    const repoPath = await makeTmpRepo(files);
    const first = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    const second = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    const third = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(second.grepMatchedPaths).toEqual(first.grepMatchedPaths);
    expect(third.grepMatchedPaths).toEqual(first.grepMatchedPaths);
  });

  // The 6-way tie (rather than 2) is deliberate: verified directly that the
  // alphabetically-first file among a 2-way tie can land first in rg's raw output by
  // coincidence, which would let a broken tie-break pass unnoticed. Across 6 repeats
  // of this exact 6-way shape, the alphabetically-first file (fileTieA, created last,
  // after F..B) was never raw-order-first -- it sat 4th-6th of 6 every time. That
  // margin, not the count itself, is why 6.
  it("resolves a tied match count by ascending path order", async () => {
    const repoPath = await makeTmpRepo({
      "fileHigh.ts": occurrences(5),
      "fileMid.ts": occurrences(4),
      "fileLow.ts": occurrences(3),
      "fileTieF.ts": occurrences(2),
      "fileTieE.ts": occurrences(2),
      "fileTieD.ts": occurrences(2),
      "fileTieC.ts": occurrences(2),
      "fileTieB.ts": occurrences(2),
      "fileTieA.ts": occurrences(2),
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths).toEqual(["fileHigh.ts", "fileMid.ts", "fileLow.ts", "fileTieA.ts"]);
  });

  // Distinct from the existing "a task built entirely of common words" test above:
  // that one never reaches rg at all (zero tokens extracted, early return). This task
  // extracts a real token, so rg is invoked and exits with a real "no match" status --
  // verified directly that this rejects execFileAsync the same way for both the old
  // and new rg flags, landing in the same catch block either way.
  it("returns no matches when the pattern has zero real hits (fail-safe path unchanged)", async () => {
    const repoPath = await makeTmpRepo({
      "other.ts": "export const somethingElse = 1;\n",
    });
    const ctx = await preparePlanContext({ task: TASK, repoPath, repoSummaryOverride: "test repo" });
    expect(ctx.grepMatchedPaths).toEqual([]);
  });
});
