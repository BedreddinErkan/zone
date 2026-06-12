import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  readImageFromFile,
  getMediaType,
  validateAttachments,
  type ImageAttachment,
} from "./imageUpload.js";

const tmpFiles: string[] = [];

async function writeTmp(name: string, content: string | Uint8Array): Promise<string> {
  const fp = join(tmpdir(), `zone-imgupload-test-${Date.now()}-${name}`);
  await writeFile(fp, content);
  tmpFiles.push(fp);
  return fp;
}

// 1×1 transparent PNG (smallest valid PNG bytes)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
  "hex"
);

afterEach(async () => {
  for (const fp of tmpFiles.splice(0)) {
    await rm(fp, { force: true });
  }
});

describe("getMediaType", () => {
  it("detects .png", () => expect(getMediaType("screenshot.png")).toBe("image/png"));
  it("detects .jpg", () => expect(getMediaType("photo.jpg")).toBe("image/jpeg"));
  it("detects .jpeg", () => expect(getMediaType("photo.jpeg")).toBe("image/jpeg"));
  it("detects .gif", () => expect(getMediaType("anim.gif")).toBe("image/gif"));
  it("detects .webp", () => expect(getMediaType("img.webp")).toBe("image/webp"));
  it("is case-insensitive on extension", () => expect(getMediaType("IMG.PNG")).toBe("image/png"));
  it("throws for unsupported extension", () => {
    expect(() => getMediaType("document.pdf")).toThrow("Unsupported image type");
  });
  it("throws for no extension", () => {
    expect(() => getMediaType("noextension")).toThrow("Unsupported image type");
  });
});

describe("readImageFromFile", () => {
  it("T1: reads a real PNG and returns correct ImageAttachment", async () => {
    const fp = await writeTmp("img.png", TINY_PNG);
    const result = await readImageFromFile(fp);
    expect(result.mediaType).toBe("image/png");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
    // Round-trip: decoded base64 must equal original bytes
    expect(Buffer.from(result.base64, "base64")).toEqual(TINY_PNG);
  });

  it("T2: unknown extension throws with a clear message", async () => {
    await expect(readImageFromFile("/tmp/document.pdf")).rejects.toThrow("Unsupported image type");
  });

  it("T3: missing file throws (propagated from readFile)", async () => {
    await expect(readImageFromFile("/tmp/zone-no-such-file-img-xyz.png")).rejects.toThrow();
  });
});

describe("validateAttachments — size limits", () => {
  it("accepts a valid ImageAttachment", () => {
    const img: ImageAttachment = { mediaType: "image/png", base64: "abc" };
    const result = validateAttachments([img]);
    expect(result.ok).toBe(true);
  });

  it("rejects when approx decoded bytes > 5 MB per image", () => {
    // base64 of 5 MB decoded needs ~6.67 MB of base64 chars
    // 5 * 1024 * 1024 * 4/3 ≈ 6_990_507 chars; use slightly more
    const bigBase64 = "A".repeat(7_000_000);
    const img: ImageAttachment = { mediaType: "image/png", base64: bigBase64 };
    const result = validateAttachments([img]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/5 MB/);
  });

  it("rejects unsupported media type", () => {
    const result = validateAttachments([{ mediaType: "image/bmp", base64: "abc" }]);
    expect(result.ok).toBe(false);
  });
});

describe("data-URL format (Anthropic adapter consume-regex)", () => {
  const ADAPTER_REGEX = /^data:([^;]+);base64,(.+)$/s;

  it("T-REGEX: data-URL built from ImageAttachment matches adapter regex", async () => {
    const fp = await writeTmp("img.png", TINY_PNG);
    const img = await readImageFromFile(fp);
    const dataUrl = `data:${img.mediaType};base64,${img.base64}`;
    expect(ADAPTER_REGEX.test(dataUrl)).toBe(true);
    const match = dataUrl.match(ADAPTER_REGEX)!;
    expect(match[1]).toBe("image/png");
    expect(match[2]).toBe(img.base64);
  });
});
