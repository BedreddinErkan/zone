import { vi, describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";

// This file tests real staging.ts flush behavior without mocking it.
// parity.test.ts mocks staging.js, so this invariant lives here.

vi.mock("node:fs");
vi.mock("../../utils/logger.js", () => ({
  debugLog: vi.fn(),
  errorLog: vi.fn(),
  log: vi.fn(),
}));

import { finalizeStaging } from "./staging.js";
import { debugLog } from "../../utils/logger.js";
import type { Mock } from "vitest";

const mockDebugLog = debugLog as Mock;
const mockFs = fs as unknown as {
  statSync: Mock;
  writeFileSync: Mock;
  readFileSync: Mock;
};

describe("[zone-staging-flush-write] ordering invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("per-file [zone-staging-flush-write] entries appear in stagingFiles key order before [zone-staging-flush]", async () => {
    const stagingFiles = new Map([
      ["/repo/src/alpha.ts", "const alpha = 1;"],
      ["/repo/src/beta.ts", "const beta = 2;"],
      ["/repo/src/gamma.ts", "const gamma = 3;"],
    ]);

    // fs stubs: stat returns mtime, readFile returns different content (so not no_changes_made)
    mockFs.statSync.mockImplementation((p: string) => ({ mtimeMs: 1000 }));
    mockFs.writeFileSync.mockImplementation(() => undefined);
    // readFileSync: first call per file (in no_changes_made check) returns old content;
    // after write, second call returns new content (matches staging → diskContentMatches=true)
    const readCounts = new Map<string, number>();
    mockFs.readFileSync.mockImplementation((p: string) => {
      const count = (readCounts.get(String(p)) ?? 0) + 1;
      readCounts.set(String(p), count);
      if (count === 1) return "old content"; // no_changes_made check: mismatch → proceed to flush
      return stagingFiles.get(String(p)) ?? ""; // post-write verification read
    });

    const withStagingTempFlush = async <T>(_staging: Map<string, string>, body: () => Promise<T>) => body();

    await finalizeStaging({
      stagingFiles,
      repoPath: "/repo",
      framework: undefined, // no verification command → skip to flush
      withStagingTempFlush,
      verifyMode: "warn",
    });

    const calls = mockDebugLog.mock.calls;
    const logKeys = calls.map((c) => c[0]);

    const flushWriteIndices = logKeys
      .map((k, i) => (k === "[zone-staging-flush-write]" ? i : -1))
      .filter((i) => i >= 0);
    const flushSummaryIndex = logKeys.lastIndexOf("[zone-staging-flush]");

    // All per-file entries must precede the summary entry
    expect(flushSummaryIndex).toBeGreaterThan(-1);
    expect(flushWriteIndices.length).toBe(stagingFiles.size);
    for (const idx of flushWriteIndices) {
      expect(idx).toBeLessThan(flushSummaryIndex);
    }

    // Per-file entries appear in the same order as stagingFiles iteration order
    const writtenPaths = calls
      .filter((c) => c[0] === "[zone-staging-flush-write]")
      .map((c) => {
        try { return JSON.parse(c[1] as string).filePath; } catch { return null; }
      })
      .filter(Boolean);
    expect(writtenPaths).toEqual(Array.from(stagingFiles.keys()));
  });
});
