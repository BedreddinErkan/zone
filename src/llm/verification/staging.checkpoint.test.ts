import { vi, describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("../../utils/logger.js", () => ({
  debugLog: vi.fn(),
  errorLog: vi.fn(),
  log: vi.fn(),
}));

import { finalizeStaging } from "./staging.js";

const mockFs = fs as unknown as {
  statSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
};

function makeBase(stagingFiles = new Map([["/repo/f.ts", "new content"]])) {
  const withStagingTempFlush = async <T>(_s: Map<string, string>, body: () => Promise<T>) => body();
  return {
    stagingFiles,
    repoPath: "/repo",
    framework: undefined as { language?: string; testCommand?: string } | undefined,
    withStagingTempFlush,
    verifyMode: "warn" as const,
  };
}

describe("finalizeStaging — beforeFlush checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: stat returns mtime, first readFileSync returns different content (forces flush path)
    mockFs.statSync.mockReturnValue({ mtimeMs: 1 });
    const readCounts = new Map<string, number>();
    mockFs.readFileSync.mockImplementation((p: string) => {
      const n = (readCounts.get(p) ?? 0) + 1;
      readCounts.set(p, n);
      if (n === 1) return "old content"; // no_changes_made check → mismatch → proceed
      return new Map([["/repo/f.ts", "new content"]]).get(p) ?? "";
    });
    mockFs.writeFileSync.mockReturnValue(undefined);
  });

  it("beforeFlush not passed → existing flush behavior unchanged (regression guard)", async () => {
    const input = makeBase();
    const result = await finalizeStaging(input);
    expect(result.flushed).toBe(true);
    expect(result.checkpoint).toBeUndefined();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it("beforeFlush returning 'flush' → writes to disk (falls through normally, no checkpoint field)", async () => {
    const input = {
      ...makeBase(),
      beforeFlush: vi.fn().mockResolvedValue({ action: "flush" }),
    };
    const result = await finalizeStaging(input);
    expect(input.beforeFlush).toHaveBeenCalledOnce();
    expect(result.flushed).toBe(true);
    // Falls through to normal flush loop — no checkpoint returned for this path.
    expect(result.checkpoint).toBeUndefined();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it("beforeFlush returning 'discard' → Map cleared, no fs.writeFileSync, flushed:false", async () => {
    const stagingFiles = new Map([["/repo/f.ts", "new content"]]);
    const input = {
      ...makeBase(stagingFiles),
      beforeFlush: vi.fn().mockResolvedValue({ action: "discard" }),
    };
    const result = await finalizeStaging(input);
    expect(result.flushed).toBe(false);
    expect(result.checkpoint?.decision).toBe("discard");
    expect(result.discardedStaging?.get("/repo/f.ts")).toBe("new content");
    expect(stagingFiles.size).toBe(0); // Map cleared
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("beforeFlush returning 'refine' → discardedStaging populated, feedback forwarded", async () => {
    const stagingFiles = new Map([["/repo/f.ts", "new content"]]);
    const input = {
      ...makeBase(stagingFiles),
      beforeFlush: vi.fn().mockResolvedValue({ action: "refine", feedback: "use async/await" }),
    };
    const result = await finalizeStaging(input);
    expect(result.flushed).toBe(false);
    expect(result.checkpoint?.decision).toBe("refine");
    expect(result.checkpoint?.feedback).toBe("use async/await");
    expect(result.discardedStaging?.has("/repo/f.ts")).toBe(true);
    expect(stagingFiles.size).toBe(0);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("beforeFlush returning 'flush' after manual prune (empty map) → no writes", async () => {
    const stagingFiles = new Map([["/repo/f.ts", "new content"]]);
    const input = {
      ...makeBase(stagingFiles),
      beforeFlush: vi.fn().mockImplementation(async ({ stagingFiles: sf }: { stagingFiles: Map<string, string> }) => {
        sf.clear(); // user manually pruned all files
        return { action: "flush" };
      }),
    };
    const result = await finalizeStaging(input);
    expect(result.flushed).toBe(false);
    expect(result.checkpoint?.decision).toBe("flush");
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("empty staging (no_staged_files) → beforeFlush NOT called (nothing to review)", async () => {
    const stagingFiles = new Map<string, string>();  // empty
    const beforeFlush = vi.fn().mockResolvedValue({ action: "flush" });
    const input = {
      stagingFiles,
      repoPath: "/repo",
      framework: undefined as { language?: string; testCommand?: string } | undefined,
      withStagingTempFlush: async <T>(_s: Map<string, string>, body: () => Promise<T>) => body(),
      verifyMode: "warn" as const,
      beforeFlush,
    };
    const result = await finalizeStaging(input);
    // no staged files → beforeFlush never reached
    expect(beforeFlush).not.toHaveBeenCalled();
    expect(result.verification).toMatchObject({ status: "skipped" });
  });
});
