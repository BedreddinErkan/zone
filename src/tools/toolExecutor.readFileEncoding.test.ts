import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoBytes(filePath: string, bytes: Buffer): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

async function readFile(filePath: string) {
  return executeTool(
    "read_file",
    { filePath },
    repoPath,
    undefined,
    {}
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-readfile-encoding-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("read_file encoding handling", () => {
  describe("Turkish characters (UTF-8, no BOM, LF)", () => {
    const content =
      "// Türkçe yorum: ç, ğ, ı, ö, ş, ü\n" +
      'export const greeting = "Merhaba dünya";\n' +
      'export const numbers = "Beş, altı, yedi";\n';

    beforeEach(() => {
      writeRepoBytes("turkish.ts", Buffer.from(content, "utf8"));
    });

    it("preserves Turkish characters round-trip", async () => {
      const result = await readFile("turkish.ts");
      expect(result.success).toBe(true);
      expect(result.output).toContain("Türkçe yorum");
      expect(result.output).toContain("ç, ğ, ı, ö, ş, ü");
      expect(result.output).toContain("Merhaba dünya");
      expect(result.output).toContain("Beş, altı, yedi");
    });

    it("does not include a leading BOM character", async () => {
      const result = await readFile("turkish.ts");
      expect(result.success).toBe(true);
      expect(result.output.charCodeAt(0)).not.toBe(0xfeff);
      expect(result.output.startsWith("//")).toBe(true);
    });
  });

  describe("CJK + Latin mixed (UTF-8, no BOM, LF)", () => {
    const content =
      "// 日本語のコメント・中文注释·한국어 주석\n" +
      "export const labels = {\n" +
      '  ja: "こんにちは",\n' +
      '  zh: "你好",\n' +
      '  ko: "안녕하세요",\n' +
      "};\n";

    beforeEach(() => {
      writeRepoBytes("cjk.ts", Buffer.from(content, "utf8"));
    });

    it("preserves Japanese, Chinese, Korean characters", async () => {
      const result = await readFile("cjk.ts");
      expect(result.success).toBe(true);
      expect(result.output).toContain("こんにちは");
      expect(result.output).toContain("你好");
      expect(result.output).toContain("안녕하세요");
      expect(result.output).toContain("日本語のコメント");
    });
  });

  describe("Emoji including astral plane (UTF-8, no BOM, LF)", () => {
    const content =
      'export const reactions = ["👍", "🎉", "🚀", "💯"];\n' +
      'export const flag = "🇹🇷";\n';

    beforeEach(() => {
      writeRepoBytes("emoji.ts", Buffer.from(content, "utf8"));
    });

    it("preserves BMP and astral-plane emoji", async () => {
      const result = await readFile("emoji.ts");
      expect(result.success).toBe(true);
      expect(result.output).toContain("👍");
      expect(result.output).toContain("🎉");
      expect(result.output).toContain("🚀");
      expect(result.output).toContain("💯");
    });

    it("preserves multi-codepoint flag emoji (regional indicator pair)", async () => {
      const result = await readFile("emoji.ts");
      expect(result.success).toBe(true);
      // 🇹🇷 = U+1F1F9 + U+1F1F7, two regional indicator code points.
      expect(result.output).toContain("🇹🇷");
    });
  });

  describe("UTF-8 BOM file", () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from(
      'export const note = "This file starts with a UTF-8 BOM";\n',
      "utf8"
    );

    beforeEach(() => {
      writeRepoBytes("bom.ts", Buffer.concat([BOM, body]));
    });

    it("returns content from a BOM-prefixed file", async () => {
      const result = await readFile("bom.ts");
      expect(result.success).toBe(true);
      // Code body still readable after the BOM.
      expect(result.output).toContain(
        'export const note = "This file starts with a UTF-8 BOM";'
      );
    });

    it("documents current BOM handling (Node default: BOM leaks through as U+FEFF)", async () => {
      // fs.readFileSync(p, "utf8") in Node does NOT strip BOM; the returned
      // string starts with U+FEFF (0xFEFF). This test pins that observed
      // behavior so any future BOM-strip change becomes visible - at which
      // point this assertion should be updated to expect the stripped form.
      const result = await readFile("bom.ts");
      expect(result.success).toBe(true);
      expect(result.output.charCodeAt(0)).toBe(0xfeff);
    });
  });

  describe("Line endings", () => {
    it("preserves CRLF line endings as-is", async () => {
      const content =
        'export const platform = "Windows-origin file";\r\n' +
        'export const second = "Two lines, both CRLF";\r\n';
      writeRepoBytes("crlf.ts", Buffer.from(content, "utf8"));

      const result = await readFile("crlf.ts");
      expect(result.success).toBe(true);
      expect(result.output).toContain("\r\n");
      expect(result.output).toContain(
        'export const platform = "Windows-origin file";'
      );
      expect(result.output).toContain(
        'export const second = "Two lines, both CRLF";'
      );
    });

    it("preserves mixed LF + CRLF without normalization", async () => {
      const content =
        "export const a = 1;\n" +
        "export const b = 2;\r\n" +
        "export const c = 3;\n";
      writeRepoBytes("mixed.ts", Buffer.from(content, "utf8"));

      const result = await readFile("mixed.ts");
      expect(result.success).toBe(true);
      // line 2 has CRLF
      expect(result.output).toMatch(/export const b = 2;\r\n/);
      // line 1 has LF only (no preceding CR)
      expect(result.output).toMatch(/export const a = 1;\n/);
      expect(result.output).not.toMatch(/export const a = 1;\r\n/);
      // line 3 has LF only
      expect(result.output).toMatch(/export const c = 3;\n/);
      expect(result.output).not.toMatch(/export const c = 3;\r\n/);
    });
  });
});
