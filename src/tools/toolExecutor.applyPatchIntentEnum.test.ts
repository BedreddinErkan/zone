import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";
import { ZONE_TOOLS } from "./toolDefinitions.js";

let repoPath: string;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function applyPatch(filePath: string, patch: string, intent: string) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent, scope: null },
    repoPath,
    undefined,
    { filesReadThisRun: new Set([filePath]) }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-intent-enum-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch intent — schema enum", () => {
  it("intent's enum is exactly add/modify/delete/null, matching the two in-repo precedents' shape", () => {
    const fn = ZONE_TOOLS.find((t) => t.function.name === "apply_patch")!.function;
    const params = fn.parameters as {
      properties: Record<string, { type: unknown; enum?: unknown[] }>;
    };
    const intentSchema = params.properties.intent;
    expect(intentSchema.enum).toEqual(["add", "modify", "delete", null]);
    // The precedent shape (kill_background.signal, apply_patch.scope.symbolKind): the enum
    // joins the nullable type union, it doesn't replace it.
    expect(intentSchema.type).toEqual(["string", "null"]);
  });
});

describe("apply_patch intent — handler fallback", () => {
  it("an unrecognized intent value still gets the strictest treatment (same as 'add') — the fallback the enum's added safety depends on", async () => {
    writeRepoFile("src/target.ts", "const a = 1;\nconst b = 2;\n");
    const patch = "--- FIND ---\nconst a = 1;\nconst b = 2;\n--- REPLACE ---\nconst a = 1;";

    const result = await applyPatch("src/target.ts", patch, "bogus");

    expect(result.success).toBe(false);
    expect(result.output).toContain("REPLACE has 1 lines but FIND has 2 lines");
  });
});
