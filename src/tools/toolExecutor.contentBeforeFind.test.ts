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

async function applyPatch(filePath: string, patch: string, model?: string) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    { model }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-content-before-find-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch content-before-find rejection (Fix 1)", () => {
  it("rejects a patch with non-whitespace content before the first --- FIND ---", async () => {
    writeRepoFile("src/add.ts", "export function add(a: number, b: number) { return a + b; }\n");
    const patch =
      "/** Adds two numbers. */\n" +
      "--- FIND ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n" +
      "--- REPLACE ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n";

    const result = await applyPatch("src/add.ts", patch);

    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_content_before_find");
    expect((result as { rejectionReason?: string }).rejectionReason).toBe("content_before_find");
    expect(result.output).toContain("Content found before the first");
    expect(result.output).toContain("--- REPLACE ---");
  });

  it("includes model in the rejection (model field threaded)", async () => {
    writeRepoFile("f.ts", "const x = 1;\n");
    const patch =
      "// preamble\n" +
      "--- FIND ---\n" +
      "const x = 1;\n" +
      "--- REPLACE ---\n" +
      "const x = 2;\n";

    const result = await applyPatch("f.ts", patch, "gpt-5.4");
    expect(result.error).toBe("apply_patch_content_before_find");
  });

  it("allows a whitespace-only prefix (leading newline) — does NOT reject", async () => {
    writeRepoFile("src/add.ts", "export function add(a: number, b: number) { return a + b; }\n");
    const patch =
      "\n" +
      "--- FIND ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n" +
      "--- REPLACE ---\n" +
      "export function add(a: number, b: number): number { return a + b; }\n";

    const result = await applyPatch("src/add.ts", patch);

    expect(result.error).not.toBe("apply_patch_content_before_find");
  });

  it("does NOT reject a well-formed patch with no prefix — baseline regression", async () => {
    writeRepoFile("src/add.ts", "export function add(a: number, b: number) { return a + b; }\n");
    const patch =
      "--- FIND ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n" +
      "--- REPLACE ---\n" +
      "export function add(a: number, b: number): number { return a + b; }\n";

    const result = await applyPatch("src/add.ts", patch);

    expect(result.error).not.toBe("apply_patch_content_before_find");
    expect(result.success).toBe(true);
    expect(readRepoFile("src/add.ts")).toContain(": number");
  });

  it("file is untouched when content-before-find is rejected", async () => {
    const original = "export function add(a: number, b: number) { return a + b; }\n";
    writeRepoFile("src/add.ts", original);
    const patch =
      "/** JSDoc */\n" +
      "--- FIND ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n" +
      "--- REPLACE ---\n" +
      "export function add(a: number, b: number) { return a + b; }\n";

    await applyPatch("src/add.ts", patch);

    expect(readRepoFile("src/add.ts")).toBe(original);
  });
});

describe("classifyFailure — new triggers (Fix 3)", () => {
  it("classifies content-before-find error text as apply_patch_content_before_find", () => {
    expect(
      classifyFailure(
        "apply_patch",
        "Content found before the first `--- FIND ---` marker.",
        undefined
      )
    ).toBe("apply_patch_content_before_find");
  });

  it("classifies content_before_find error field as apply_patch_content_before_find", () => {
    expect(
      classifyFailure("apply_patch", "", "content_before_find")
    ).toBe("apply_patch_content_before_find");
  });

  it("classifies 'No valid --- FIND --- / --- REPLACE --- blocks found' as apply_patch_no_valid_blocks", () => {
    expect(
      classifyFailure(
        "apply_patch",
        "No valid --- FIND --- / --- REPLACE --- blocks found in patch.",
        undefined
      )
    ).toBe("apply_patch_no_valid_blocks");
  });

  it("'No valid blocks' no longer falls through to unknown", () => {
    const trigger = classifyFailure(
      "apply_patch",
      "No valid --- FIND --- / --- REPLACE --- blocks found in patch.",
      undefined
    );
    expect(trigger).not.toBe("unknown");
  });
});
