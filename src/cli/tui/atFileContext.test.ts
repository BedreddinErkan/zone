import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { readAtFileContext, looksLikeBinary, AT_FILE_CONTENT_CAP } from "./atFileContext.js";

const tmpFiles: string[] = [];

async function writeTmp(name: string, content: string | Uint8Array): Promise<string> {
  const fp = join(tmpdir(), `zone-at-file-test-${Date.now()}-${name}`);
  await writeFile(fp, content);
  tmpFiles.push(fp);
  return fp;
}

afterEach(async () => {
  for (const fp of tmpFiles.splice(0)) {
    await rm(fp, { force: true });
  }
});

describe("looksLikeBinary", () => {
  it("returns false for normal text", () => {
    expect(looksLikeBinary("const x = 1;\n")).toBe(false);
  });

  it("returns true when null byte is in first 512 chars", () => {
    expect(looksLikeBinary("abc\x00def")).toBe(true);
  });

  it("returns false when null byte is beyond first 512 chars", () => {
    const safe = "a".repeat(512) + "\x00";
    expect(looksLikeBinary(safe)).toBe(false);
  });
});

describe("readAtFileContext", () => {
  it("T1: normal file — returns labeled block with full content", async () => {
    const fp = await writeTmp("normal.ts", "const x = 1;\nexport default x;\n");
    const result = await readAtFileContext(fp);
    expect(result).not.toBeNull();
    expect(result).toContain(`=== ${fp} ===`);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("[... file truncated");
  });

  it("T2: oversized file — truncated with cap marker", async () => {
    const big = "x".repeat(AT_FILE_CONTENT_CAP + 500);
    const fp = await writeTmp("big.ts", big);
    const result = await readAtFileContext(fp);
    expect(result).not.toBeNull();
    expect(result).toContain(`[... file truncated at ${AT_FILE_CONTENT_CAP} chars]`);
    // content portion should not exceed cap
    const header = `=== ${fp} ===\n`;
    const marker = `\n[... file truncated at ${AT_FILE_CONTENT_CAP} chars]`;
    expect(result!.length).toBe(header.length + AT_FILE_CONTENT_CAP + marker.length);
  });

  it("T3: missing file — returns null without throwing", async () => {
    const result = await readAtFileContext("/tmp/zone-no-such-file-xyz-99999.ts");
    expect(result).toBeNull();
  });

  it("T4: binary file (null byte in first 512 chars) — returns null", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x00, 0x01, 0x41, 0x42]);
    const fp = await writeTmp("binary.zip", bytes);
    const result = await readAtFileContext(fp);
    expect(result).toBeNull();
  });
});
