import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Shim so vi.spyOn can override non-configurable ESM native properties.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

import * as fs from "node:fs";
import { atomicWriteFileSync } from "./atomicWrite.js";

describe("atomicWriteFileSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-atomic-write-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes content to the target file", () => {
    const target = path.join(tmpDir, "output.json");
    atomicWriteFileSync(target, '{"ok":true}');
    expect(fs.readFileSync(target, "utf-8")).toBe('{"ok":true}');
  });

  it("leaves no .tmp file after successful write", () => {
    const target = path.join(tmpDir, "output.json");
    atomicWriteFileSync(target, "content");
    const files = fs.readdirSync(tmpDir);
    expect(files.every((f) => !f.includes(".tmp."))).toBe(true);
  });

  it("cleans up .tmp file and propagates error when rename fails", () => {
    let tmpPathSeen = "";
    vi.spyOn(fs, "renameSync").mockImplementationOnce((src) => {
      tmpPathSeen = src as string;
      throw new Error("rename failed");
    });

    const target = path.join(tmpDir, "output.json");
    expect(() => atomicWriteFileSync(target, "data")).toThrow("rename failed");
    expect(fs.existsSync(tmpPathSeen)).toBe(false);

    vi.restoreAllMocks();
  });
});
