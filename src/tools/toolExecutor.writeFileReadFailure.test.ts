/**
 * write_file's shrink-guard pre-read failure: ENOENT keeps today's behavior
 * (new file, no guard); anything else returns a typed failure and emits
 * [zone-write-file-preread-error] instead of silently falling through to a
 * direct, unstaged disk write (toolExecutor.ts's shrink-guard catch used to
 * swallow it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-wf-read-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

/**
 * Throws EACCES for `target` on its first read only; every later call (any
 * path, including a second read of `target`) falls through to the real
 * readFileSync. First-call-only rather than indefinite so a mutation that
 * defeats the guard and lets production code re-read `target` afterward
 * doesn't get masked by the mock throwing there too.
 */
function mockEaccesOnce(target: string): { restore: () => void } {
  const realReadFileSync = fs.readFileSync;
  let attempted = false;
  const spy = vi
    .spyOn(fs, "readFileSync")
    .mockImplementation((p: fs.PathOrFileDescriptor, opts?: BufferEncoding | { encoding: BufferEncoding }) => {
      if (p === target && !attempted) {
        attempted = true;
        const e = new Error(`EACCES: permission denied, open '${target}'`) as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      return realReadFileSync(p, opts as BufferEncoding);
    });
  return { restore: () => spy.mockRestore() };
}

describe("write_file — shrink-guard pre-read failure", () => {
  it("A1 — non-ENOENT read failure returns success:false", async () => {
    const filePath = "src/existing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "export const x = 1;\n", "utf8");

    mockEaccesOnce(abs(filePath));

    const result = await executeTool(
      "write_file",
      { filePath, content: "export const x = 999;\n" },
      repoPath
    );

    expect(result.success).toBe(false);
  });

  it("A2 — non-ENOENT read failure leaves the file byte-identical", async () => {
    const filePath = "src/existing.ts";
    const original = "export const x = 1;\n";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), original, "utf8");

    const target = abs(filePath);
    const { restore } = mockEaccesOnce(target);

    await executeTool(
      "write_file",
      { filePath, content: "export const x = 999;\n" },
      repoPath
    );
    restore();

    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("B — emits [zone-write-file-preread-error] with the real fs error code", async () => {
    const filePath = "src/existing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "export const x = 1;\n", "utf8");

    mockEaccesOnce(abs(filePath));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await executeTool("write_file", { filePath, content: "export const x = 2;\n" }, repoPath);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-write-file-preread-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("EACCES");
  });

  it("C — ENOENT still creates a new file (unchanged)", async () => {
    const filePath = "src/brandnew.ts";
    const result = await executeTool(
      "write_file",
      { filePath, content: "export const x = 1;\n" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(abs(filePath), "utf8")).toBe("export const x = 1;\n");
  });

  it("D — truncates a very long non-ENOENT message with a visible trailing ellipsis", async () => {
    const segments = Array.from({ length: 20 }, (_, i) => `verylongdirectorysegmentnumber${i}`);
    const longDirPath = path.join("src", ...segments);
    fs.mkdirSync(abs(longDirPath), { recursive: true });

    const result = await executeTool(
      "write_file",
      { filePath: longDirPath, content: "export const x = 1;\n" },
      repoPath
    );
    expect(result.output.startsWith("write_file could not read the existing")).toBe(true);
    expect(result.output).toHaveLength(301);
    expect(result.output.endsWith("…")).toBe(true);
  });
});
