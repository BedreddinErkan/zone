/**
 * Path-boundary check (checkPathBoundary/nearestExistingAncestor, toolExecutor.ts). The task
 * brief that triggered this named two bugs — a bare-prefix startsWith and a write_file
 * "overwrite: true" bypass — that turned out not to exist as described; the real bugs were
 * write_file's new-file branch never calling stagedWrite at all, and stagedWrite's own check
 * running after (not before) its staging-map-presence check, so any no-staging-map write bypassed
 * it entirely. read_file/list_files had no check whatsoever. This file covers the fix: one
 * shared, symlink-aware, separator-safe check, called as the first thing every handler does with
 * a resolved path, plus the two failure-mode gaps C1 flagged in review — an exhausted ancestor
 * walk and an undecidable (non-ENOENT) realpath failure must both fail closed, not open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, _stagedWriteForTest } from "./toolExecutor.js";

let repoPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function abs(rel: string): string {
  return path.join(repoPath, rel);
}
function writeRepoFile(filePath: string, content: string): void {
  const target = abs(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
function boundaryRejections() {
  return logSpy.mock.calls.filter((c) => c[0] === "[zone-path-boundary-rejected]");
}
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("write_file — property matrix, target does not exist yet", () => {
  it("../ traversal is rejected and nothing is created", async () => {
    const escapeTarget = path.join(os.tmpdir(), "zone-pathboundary-new-pwned.txt");
    fs.rmSync(escapeTarget, { force: true });
    const rel = path.relative(repoPath, escapeTarget);
    const result = await executeTool("write_file", { filePath: rel, content: "pwned" }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("write_file_blocked_path_escape");
    expect(fs.existsSync(escapeTarget)).toBe(false);
  });

  it("sibling-directory case is rejected (separator-safe comparison)", async () => {
    const siblingDir = `${repoPath}-dogfood`;
    fs.mkdirSync(siblingDir, { recursive: true });
    try {
      const rel = path.join("..", path.basename(siblingDir), "new.txt");
      const result = await executeTool("write_file", { filePath: rel, content: "pwned" }, repoPath);
      expect(result.success).toBe(false);
      expect(fs.existsSync(path.join(siblingDir, "new.txt"))).toBe(false);
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it("legitimate relative path is accepted", async () => {
    const result = await executeTool("write_file", { filePath: "src/ok.ts", content: "export const x = 1;\n" }, repoPath);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(abs("src/ok.ts"), "utf8")).toContain("x = 1");
  });

  it("legitimate path in a new, not-yet-existing subdirectory is accepted", async () => {
    const result = await executeTool(
      "write_file",
      { filePath: "newdir1/newdir2/file.ts", content: "export const y = 2;\n" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(abs("newdir1/newdir2/file.ts"), "utf8")).toContain("y = 2");
  });
});

describe("write_file — property matrix, target already exists outside the repo", () => {
  // Both tests below write replacement content at least as long as the original: write_file's
  // shrink guard independently blocks a write whose new content is under 70% of the original's
  // size, and a short "pwned"-style literal against a short original can dip under that
  // threshold — which would make the test pass for the wrong reason (shrink guard, not the
  // boundary check) if the boundary check were ever broken. Keeping content length >= original
  // means a passing assertion here can only be this check's doing.
  it("../ traversal onto an existing outside file is rejected and its content is untouched", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-outside-"));
    try {
      const outsideTarget = path.join(outsideDir, "existing.txt");
      fs.writeFileSync(outsideTarget, "original content here", "utf8");
      const rel = path.relative(repoPath, outsideTarget);
      const result = await executeTool("write_file", { filePath: rel, content: "totally pwned by attacker now" }, repoPath);
      expect(result.success).toBe(false);
      expect(fs.readFileSync(outsideTarget, "utf8")).toBe("original content here");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("sibling-directory case onto an existing file is rejected and its content is untouched", async () => {
    const siblingDir = `${repoPath}-dogfood`;
    fs.mkdirSync(siblingDir, { recursive: true });
    try {
      const target = path.join(siblingDir, "existing.txt");
      fs.writeFileSync(target, "original content here", "utf8");
      const rel = path.join("..", path.basename(siblingDir), "existing.txt");
      const result = await executeTool("write_file", { filePath: rel, content: "totally pwned by attacker now" }, repoPath);
      expect(result.success).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("original content here");
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it("a symlink inside the repo pointing outside it is rejected, target untouched", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-symlink-"));
    try {
      const outsideTarget = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideTarget, "secret", "utf8");
      fs.symlinkSync(outsideTarget, abs("evil-link.txt"));
      const result = await executeTool("write_file", { filePath: "evil-link.txt", content: "pwned" }, repoPath);
      expect(result.success).toBe(false);
      expect(fs.readFileSync(outsideTarget, "utf8")).toBe("secret");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("legitimate overwrite of an existing in-repo file is accepted", async () => {
    writeRepoFile("src/existing.ts", "export const x = 1;\n");
    const result = await executeTool("write_file", { filePath: "src/existing.ts", content: "export const x = 2;\n" }, repoPath);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(abs("src/existing.ts"), "utf8")).toContain("x = 2");
  });
});

describe("wiring proof — read_file / list_files", () => {
  it("read_file rejects ../ traversal and never returns outside content", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-read-"));
    try {
      const outsideTarget = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideTarget, "top secret contents", "utf8");
      const rel = path.relative(repoPath, outsideTarget);
      const result = await executeTool("read_file", { filePath: rel }, repoPath);
      expect(result.success).toBe(false);
      expect(result.output).toContain("read_file_blocked_path_escape");
      expect(result.output).not.toContain("top secret");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("read_file accepts a legitimate path", async () => {
    writeRepoFile("src/readable.ts", "export const z = 3;\n");
    const result = await executeTool("read_file", { filePath: "src/readable.ts" }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toContain("z = 3");
  });

  it("list_files rejects ../ traversal", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-list-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "leaked.txt"), "x", "utf8");
      const rel = path.relative(repoPath, outsideDir);
      const result = await executeTool("list_files", { dirPath: rel }, repoPath);
      expect(result.success).toBe(false);
      expect(result.output).toContain("list_files_blocked_path_escape");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("list_files accepts a legitimate subdirectory", async () => {
    writeRepoFile("src/sub/a.ts", "export const a = 1;\n");
    const result = await executeTool("list_files", { dirPath: "src/sub" }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts");
  });
});

describe("wiring proof — apply_patch (pre-patch read must not fire on an escaping path)", () => {
  it("rejects ../ traversal before reading the target's content", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-patch-"));
    try {
      const outsideTarget = path.join(outsideDir, "existing.ts");
      fs.writeFileSync(outsideTarget, "export const secret = 1;\n", "utf8");
      const readSpy = vi.spyOn(fs, "readFileSync");
      const rel = path.relative(repoPath, outsideTarget);
      const patch = "--- FIND ---\nexport const secret = 1;\n--- REPLACE ---\nexport const secret = 2;";
      const result = await executeTool("apply_patch", { filePath: rel, patch, intent: "modify" }, repoPath);
      expect(result.success).toBe(false);
      expect(result.output).toContain("apply_patch_blocked_path_escape");
      expect(readSpy.mock.calls.some((c) => c[0] === outsideTarget)).toBe(false);
      expect(fs.readFileSync(outsideTarget, "utf8")).toBe("export const secret = 1;\n");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("wiring proof — multi_edit (item 47: pre-flight makes the batch atomic)", () => {
  it("rejects a batch with an escaping file before touching anything — nothing staged, not even the files before it", async () => {
    // multi_edit has no direct-disk-write fallback the way write_file/apply_patch do — with no
    // staging map, edits are silently dropped rather than written (a pre-existing, separate
    // multi_edit gap, not this pass's concern). A real staging map lets this test prove the
    // pre-flight negative directly: a.ts genuinely never gets staged, not just that the call
    // fails.
    writeRepoFile("a.ts", "const target = 1;\n");
    writeRepoFile("c.ts", "const target = 1;\n");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-multiedit-"));
    try {
      const outsideTarget = path.join(outsideDir, "b.ts");
      fs.writeFileSync(outsideTarget, "const target = 1;\n", "utf8");
      const escapingRel = path.relative(repoPath, outsideTarget);
      const stagingFiles = new Map<string, string>();
      const result = await executeTool(
        "multi_edit",
        { files: ["a.ts", escapingRel, "c.ts"], find: "target", replace: "renamed" },
        repoPath,
        undefined,
        { stagingFiles }
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("multi_edit_blocked_path_escape");
      expect(result.output).toContain(escapingRel);
      expect((result as { filesStaged?: string[] }).filesStaged).toEqual([]);
      expect(stagingFiles.size).toBe(0);
      expect(fs.readFileSync(abs("a.ts"), "utf8")).toBe("const target = 1;\n");
      expect(fs.readFileSync(abs("c.ts"), "utf8")).toBe("const target = 1;\n");
      expect(fs.readFileSync(outsideTarget, "utf8")).toBe("const target = 1;\n");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("all-valid batch proceeds normally — pre-flight doesn't false-positive", async () => {
    writeRepoFile("a.ts", "const target = 1;\n");
    writeRepoFile("b.ts", "const target = 1;\n");
    const stagingFiles = new Map<string, string>();
    const result = await executeTool(
      "multi_edit",
      { files: ["a.ts", "b.ts"], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles }
    );
    expect(result.success).toBe(true);
    expect((result as { filesStaged?: string[] }).filesStaged).toEqual(["a.ts", "b.ts"]);
    expect(stagingFiles.get(path.resolve(abs("a.ts")))).toContain("renamed");
    expect(stagingFiles.get(path.resolve(abs("b.ts")))).toContain("renamed");
  });

  it("single-file case is unaffected by the pre-flight loop", async () => {
    writeRepoFile("solo.ts", "const target = 1;\n");
    const stagingFiles = new Map<string, string>();
    const result = await executeTool(
      "multi_edit",
      { files: ["solo.ts"], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles }
    );
    expect(result.success).toBe(true);
    expect((result as { filesStaged?: string[] }).filesStaged).toEqual(["solo.ts"]);
    expect(stagingFiles.get(path.resolve(abs("solo.ts")))).toContain("renamed");
  });

  it("a read failure and a zero-match don't trip the pre-flight — only path escapes do", async () => {
    writeRepoFile("present.ts", "const other = 1;\n"); // no match for "target"
    const stagingFiles = new Map<string, string>();
    const result = await executeTool(
      "multi_edit",
      { files: ["missing.ts", "present.ts"], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles }
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("could not read");
    expect(result.output).toContain("was not found in");
    expect((result as { filesStaged?: string[] }).filesStaged).toEqual([]);
    expect(stagingFiles.size).toBe(0);
  });
});

describe("stagedWrite's own check, isolated from every handler's early check", () => {
  it("a clean absolute path outside the repo is rejected", () => {
    // Not reachable through write_file's real call path: resolveAgentPath's existing,
    // out-of-scope-for-this-pass leading-slash-strip fallback neutralizes a clean absolute
    // input like "/tmp/x.txt" into "tmp/x.txt" before it ever reaches path.join(repoPath, ...),
    // landing back inside the repo (proven by runToolPathResolutionManual.ts case 4). This
    // property belongs to checkPathBoundary's own comparison, exercised directly here.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-cleanabs-"));
    try {
      const escapingAbs = path.join(outsideDir, "x.txt");
      const result = _stagedWriteForTest(new Map(), escapingAbs, "pwned", repoPath, "test");
      expect(result).toBe("escape");
      expect(fs.existsSync(escapingAbs)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("no staging map + escaping path → escape (bug 2's direct regression)", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-staged-"));
    try {
      const escapingAbs = path.join(outsideDir, "x.txt");
      const result = _stagedWriteForTest(undefined, escapingAbs, "pwned", repoPath, "test");
      expect(result).toBe("escape");
      expect(fs.existsSync(escapingAbs)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("no staging map + legitimate path → false (caller does the direct write itself)", () => {
    const result = _stagedWriteForTest(undefined, abs("src/legit.ts"), "content", repoPath, "test");
    expect(result).toBe(false);
  });

  it("staging map present + escaping path → escape, map untouched", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-staged2-"));
    try {
      const staging = new Map<string, string>();
      const escapingAbs = path.join(outsideDir, "x.txt");
      const result = _stagedWriteForTest(staging, escapingAbs, "pwned", repoPath, "test");
      expect(result).toBe("escape");
      expect(staging.size).toBe(0);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("staging map present + legitimate path → true, map holds the entry", () => {
    const staging = new Map<string, string>();
    const target = abs("src/legit2.ts");
    const result = _stagedWriteForTest(staging, target, "content", repoPath, "test");
    expect(result).toBe(true);
    expect(staging.get(path.resolve(target))).toBe("content");
  });
});

describe("marker — [zone-path-boundary-rejected]", () => {
  it("logs tool, requestedPath, resolvedPath, and reason on a normal containment rejection", async () => {
    const escapeTarget = path.join(os.tmpdir(), "zone-pathboundary-marker-pwned.txt");
    fs.rmSync(escapeTarget, { force: true });
    const rel = path.relative(repoPath, escapeTarget);
    await executeTool("write_file", { filePath: rel, content: "pwned" }, repoPath);

    const rejections = boundaryRejections();
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(rejections[0][1] as string) as Record<string, unknown>;
    expect(payload.tool).toBe("write_file");
    expect(typeof payload.requestedPath).toBe("string");
    expect(typeof payload.resolvedPath).toBe("string");
    expect(payload.reason).toBe("outside_repo");
  });
});

describe("C1 — ancestor walk exhaustion (no existing ancestor found)", () => {
  // _stagedWriteForTest, not executeTool, for the same reason as the EACCES test below: asserts
  // checkPathBoundary's own return value directly rather than write_file's overall success,
  // which happened to still discriminate this specific mutation but isn't what the test claims
  // to prove.
  it("fails closed and logs reason: no_existing_ancestor when lstatSync never succeeds", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      const e = new Error("ENOENT: simulated") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    });
    const result = _stagedWriteForTest(new Map(), abs("src/whatever.ts"), "x", repoPath, "write_file");
    expect(result).toBe("escape");

    const rejections = boundaryRejections();
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(rejections[0][1] as string) as Record<string, unknown>;
    expect(payload.reason).toBe("no_existing_ancestor");
    expect(payload.resolvedPath).toBeNull();
  });
});

describe("C1 — undecidable realpath (EACCES mid-chain, not ENOENT)", () => {
  // Uses _stagedWriteForTest, not executeTool("write_file", ...): the same chmod'd-000
  // directory that makes checkPathBoundary's own realpath throw EACCES also makes write_file's
  // unrelated shrink-guard pre-read (which follows the identical symlink) independently throw
  // EACCES, so result.success would land on false either way — that assertion can't tell "the
  // boundary check correctly rejected this" apart from "something else in write_file also
  // happened to fail for the same underlying reason." Going through stagedWrite directly makes
  // checkPathBoundary's own true | "escape" return value the only thing under test.
  it.skipIf(isRoot())(
    "fails closed and logs reason: unresolvable when a symlink resolves through a search-denied directory",
    () => {
      const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-path-boundary-blocked-"));
      const innerDir = path.join(blockedDir, "inner");
      fs.mkdirSync(innerDir, { recursive: true });
      fs.writeFileSync(path.join(innerDir, "target.txt"), "secret", "utf8");
      fs.symlinkSync(path.join(innerDir, "target.txt"), abs("evil-link2.txt"));
      fs.chmodSync(blockedDir, 0o000);
      try {
        const result = _stagedWriteForTest(new Map(), abs("evil-link2.txt"), "pwned", repoPath, "write_file");
        expect(result).toBe("escape");

        const rejections = boundaryRejections();
        expect(rejections.length).toBeGreaterThanOrEqual(1);
        const payload = JSON.parse(rejections[0][1] as string) as Record<string, unknown>;
        expect(payload.reason).toBe("unresolvable");
      } finally {
        fs.chmodSync(blockedDir, 0o755);
        fs.rmSync(blockedDir, { recursive: true, force: true });
      }
    }
  );
});
