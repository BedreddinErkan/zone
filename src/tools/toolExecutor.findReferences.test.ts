/**
 * Phase D tests: find_references tool — import-graph based symbol search,
 * result capping at 50, and error handling.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeTs(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-d-find-refs-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("find_references", () => {
  it("returns 'no files import' for a symbol with no importers", async () => {
    writeTs("src/util.ts", "export function orphan() { return 1; }");
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/util.ts", symbolName: "orphan" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/No files import/);
  });

  it("finds a file that imports the symbol", async () => {
    writeTs("src/cost.ts", "export function getRunCost() { return 0; }");
    writeTs(
      "src/server.ts",
      `import { getRunCost } from "./cost";\nexport const x = getRunCost();`
    );
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/cost.ts", symbolName: "getRunCost" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("src/server.ts");
    expect(result.output).toMatch(/Found \d+ file/);
  });

  it("does not include files that import a different symbol from the same source", async () => {
    writeTs("src/cost.ts", "export function getRunCost() { return 0; }\nexport function getReset() { return 1; }");
    writeTs(
      "src/consumer.ts",
      `import { getReset } from "./cost";\nexport const x = getReset();`
    );
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/cost.ts", symbolName: "getRunCost" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/No files import/);
  });

  it("returns an informative error when sourceFile is not in the dependency graph", async () => {
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/nonexistent.ts", symbolName: "foo" },
      repoPath
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not found in dependency graph/i);
  });

  it("caps results at 50 when many files import the same symbol", async () => {
    writeTs("src/util.ts", "export function sharedFn() { return 1; }");
    for (let i = 0; i < 55; i++) {
      writeTs(
        `src/consumer${i}.ts`,
        `import { sharedFn } from "./util";\nexport const v${i} = sharedFn();`
      );
    }
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/util.ts", symbolName: "sharedFn" },
      repoPath
    );
    expect(result.success).toBe(true);
    const lines = result.output.split("\n").filter((l) => l.trim().startsWith("src/consumer"));
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(result.output).toContain("showing first 50");
  });

  it("returns error when symbolName is empty", async () => {
    writeTs("src/util.ts", "export function foo() {}");
    const result = await executeTool(
      "find_references",
      { sourceFile: "src/util.ts", symbolName: "" },
      repoPath
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/symbolName is required/);
  });
});

describe("find_references — staging awareness (Fix 3)", () => {
  it("finds importer that only exists in staged content", async () => {
    writeTs("src/service.ts", "export function targetFn() { return 0; }");
    writeTs("src/consumer.ts", "export const x = 1;"); // no import on disk

    const stagingFiles = new Map<string, string>();
    stagingFiles.set(
      path.resolve(repoPath, "src/consumer.ts"),
      `import { targetFn } from "./service";\nexport const x = targetFn();`
    );

    const result = await executeTool(
      "find_references",
      { sourceFile: "src/service.ts", symbolName: "targetFn" },
      repoPath,
      undefined,
      { stagingFiles }
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("src/consumer.ts");
  });

  it("uses disk content when no staging (regression: baseline unchanged)", async () => {
    writeTs("src/service.ts", "export function targetFn() { return 0; }");
    writeTs("src/consumer.ts", "export const x = 1;"); // no import on disk, no staging

    const result = await executeTool(
      "find_references",
      { sourceFile: "src/service.ts", symbolName: "targetFn" },
      repoPath,
      undefined,
      undefined
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/No files import/);
  });
});
