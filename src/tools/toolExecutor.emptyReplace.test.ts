import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";
import { classifyFailure } from "../llm/agentLoop.js";

let repoPath: string;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoPath, filePath), "utf8");
}

async function applyPatch(
  filePath: string,
  patch: string,
  intent: string = "add"
) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent, scope: null },
    repoPath,
    undefined,
    { filesReadThisRun: new Set([filePath]) }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-empty-replace-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch empty-REPLACE deletion (Fix 1)", () => {
  it("(a) intent='delete' + empty REPLACE removes the matched substring", async () => {
    // Substring deletion: remove " + extra" from a single-line expression.
    // The parser strips one leading/trailing newline from FIND, so the match
    // is exact-substring; content around it is preserved unchanged.
    writeRepoFile("src/target.ts", "const x = foo + extra + bar;\n");
    const patch =
      "--- FIND ---\n" +
      " + extra" +
      "\n--- REPLACE ---\n";

    const result = await applyPatch("src/target.ts", patch, "delete");

    expect(result.success).toBe(true);
    expect(readRepoFile("src/target.ts")).toBe("const x = foo + bar;\n");
  });

  it("(b) empty REPLACE without intent='delete' rejects with targeted trigger", async () => {
    writeRepoFile("src/target.ts", "const x = 1;\nconst y = 2;\n");
    const patch =
      "--- FIND ---\n" +
      "const y = 2;\n" +
      "--- REPLACE ---\n";

    const result = await applyPatch("src/target.ts", patch, "add");

    expect(result.success).toBe(false);
    expect(result.output).toContain("REPLACE block is empty");
    expect(classifyFailure("apply_patch", result.output, undefined)).toBe(
      "apply_patch_empty_replace_no_intent"
    );
  });

  it("(c) intent='modify' + empty REPLACE also rejects with targeted trigger", async () => {
    writeRepoFile("src/target.ts", "const x = 1;\nconst y = 2;\n");
    const patch =
      "--- FIND ---\n" +
      "const y = 2;\n" +
      "--- REPLACE ---\n";

    const result = await applyPatch("src/target.ts", patch, "modify");

    expect(result.success).toBe(false);
    expect(result.output).toContain("REPLACE block is empty");
    expect(classifyFailure("apply_patch", result.output, undefined)).toBe(
      "apply_patch_empty_replace_no_intent"
    );
  });

  it("(d) multi-block patch: one modify block + one empty-REPLACE delete block, both applied atomically", async () => {
    writeRepoFile(
      "src/target.ts",
      "const a = prefix_one + suffix;\nconst b = 2;\n"
    );
    // Block 1: modify (non-empty REPLACE). Block 2: empty REPLACE delete.
    // intent='delete' covers both blocks (allowShrink=true for both).
    const patch =
      "--- FIND ---\n" +
      "prefix_one" +
      "\n--- REPLACE ---\n" +
      "prefix_two\n" +
      "--- FIND ---\n" +
      " + suffix" +
      "\n--- REPLACE ---\n";

    const result = await applyPatch("src/target.ts", patch, "delete");

    expect(result.success).toBe(true);
    expect(readRepoFile("src/target.ts")).toBe(
      "const a = prefix_two;\nconst b = 2;\n"
    );
  });
});
