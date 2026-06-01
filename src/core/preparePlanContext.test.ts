import { describe, it, expect, afterEach } from "vitest";
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

  afterEach(async () => {
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
});
