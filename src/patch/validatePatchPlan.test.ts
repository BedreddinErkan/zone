import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { validatePatchPlan } from "./validatePatchPlan.js";

/**
 * Real mkdtemp fixture, no mocks — checkPathBoundary calls fs.realpathSync directly, which
 * bypasses a mocked fileExists entirely (a fictitious "/repo" target cannot be realpathed and
 * every case would report PATH_OUTSIDE_REPO regardless of what fileExists says). See
 * docs/deferred-work.md item 309.
 */

let repoDir: string;
let outsideDir: string;

beforeEach(() => {
  repoDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-vpp-repo-"));
  outsideDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-vpp-outside-"));
});

afterEach(() => {
  fsSync.rmSync(repoDir, { recursive: true, force: true });
  fsSync.rmSync(outsideDir, { recursive: true, force: true });
});

function writeRepoFile(rel: string, content = "x"): void {
  const abs = path.join(repoDir, rel);
  fsSync.mkdirSync(path.dirname(abs), { recursive: true });
  fsSync.writeFileSync(abs, content, "utf8");
}

describe("validatePatchPlan", () => {
  it("returns error when patch item is missing target path", async () => {
    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "", operation: "modify", contentPreview: "test" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_TARGET_PATH", level: "error" }),
      ])
    );
  });

  it("returns error for unsupported operation", async () => {
    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/test.ts", operation: "delete", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_OPERATION", level: "error" }),
      ])
    );
  });

  it("returns warning for empty content preview", async () => {
    writeRepoFile("src/test.ts");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/test.ts", operation: "modify", contentPreview: "" }],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EMPTY_CONTENT_PREVIEW", level: "warning" }),
      ])
    );
  });

  it("returns warning when multiple patches target the same file", async () => {
    writeRepoFile("src/test.ts");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [
          { path: "src/test.ts", operation: "modify", contentPreview: "a" },
          { path: "src/test.ts", operation: "modify", contentPreview: "b" },
        ],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_TARGET_PATH", level: "warning" }),
      ])
    );
  });

  it("returns warning when create targets an existing file (mechanism-sensitive: PP1's case 5 — needs a REAL file, not just a mock)", async () => {
    writeRepoFile("src/existing.ts");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/existing.ts", operation: "create", contentPreview: "content" }],
      } as any,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CREATE_TARGET_ALREADY_EXISTS", level: "warning" }),
      ])
    );
  });

  it("returns error when modify targets missing file (mechanism-sensitive: PP1's case 6 — the file must genuinely be ABSENT)", async () => {
    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/missing.ts", operation: "modify", contentPreview: "content" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MODIFY_TARGET_MISSING", level: "error" }),
      ])
    );
  });

  it("returns error when patch path escapes repository root (regression net — MM1 must not kill this)", async () => {
    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "../secret.txt", operation: "modify", contentPreview: "content" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PATH_OUTSIDE_REPO", level: "error" }),
      ])
    );
  });

  it("returns error for protected file targets (control — NN2's regression net)", async () => {
    writeRepoFile(".env");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: ".env", operation: "modify", contentPreview: "SECRET=1" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_PROTECTED_FILE", level: "error" }),
      ])
    );
  });

  it("returns warning for node_modules target", async () => {
    writeRepoFile("node_modules/pkg/index.js");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "node_modules/pkg/index.js", operation: "modify", contentPreview: "content" }],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_NODE_MODULES", level: "warning" }),
      ])
    );
  });

  it("returns warning for internal agent artifact target", async () => {
    writeRepoFile(".agent-patches/test.txt");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: ".agent-patches/test.txt", operation: "modify", contentPreview: "content" }],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_AGENT_ARTIFACT", level: "warning" }),
      ])
    );
  });

  it("returns valid when patch plan is clean (mechanism-sensitive: PP1's case 11 — toHaveLength(0) is exact, the file must exist)", async () => {
    writeRepoFile("src/feature.ts");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/feature.ts", operation: "modify", contentPreview: "const x = 1;" }],
      } as any,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("HOSTILE INPUT: an in-repo symlink to an EXISTING outside file now refuses (item 309's R construction, MM1's target)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const secret = path.join(outsideDir, "secret-existing.txt");
    fsSync.writeFileSync(secret, "ORIGINAL\n", "utf8");
    fsSync.symlinkSync(secret, path.join(repoDir, "src", "link-existing.txt"));

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/link-existing.txt", operation: "modify", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PATH_OUTSIDE_REPO", level: "error" }),
      ])
    );
  });

  it("HOSTILE INPUT: an in-repo symlink to a NON-EXISTENT outside path now refuses (item 309's W construction, MM1 and MM3's target)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fsSync.symlinkSync(
      path.join(outsideDir, "does-not-exist.txt"),
      path.join(repoDir, "src", "link-broken.txt")
    );

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/link-broken.txt", operation: "create", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PATH_OUTSIDE_REPO", level: "error" }),
      ])
    );
  });

  it("asymmetric realpath: a repo root itself reached through a symlink still allows a legitimate write (MM2's target)", async () => {
    const symlinkedRepo = path.join(os.tmpdir(), `zone-vpp-repolink-${process.pid}`);
    fsSync.symlinkSync(repoDir, symlinkedRepo);
    try {
      const result = await validatePatchPlan({
        targetPath: symlinkedRepo,
        patchPlan: {
          patches: [{ path: "via-symlinked-root.ts", operation: "create", contentPreview: "x" }],
        } as any,
      });

      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
    } finally {
      fsSync.unlinkSync(symlinkedRepo);
    }
  });

  it("HOSTILE INPUT: the protected list is bypassed by re-spelling './.env' (item 310, NN1's target)", async () => {
    writeRepoFile(".env");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "./.env", operation: "modify", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_PROTECTED_FILE", level: "error" }),
      ])
    );
  });

  it("HOSTILE INPUT: the protected list is bypassed by re-spelling 'src/../.env' (item 310, NN1's target)", async () => {
    writeRepoFile(".env");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: "src/../.env", operation: "modify", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_PROTECTED_FILE", level: "error" }),
      ])
    );
  });

  it("HOSTILE INPUT: the protected list is bypassed by re-spelling './/.env' (item 310, NN1's target)", async () => {
    writeRepoFile(".env");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: ".//.env", operation: "modify", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_PROTECTED_FILE", level: "error" }),
      ])
    );
  });

  it("HOSTILE INPUT: the protected list is bypassed by naming the repo's own .env with an ABSOLUTE path (item 310's fourth spelling — the one that needs real anchoring, not just lexical dot-collapse; NN1 and NN3's target)", async () => {
    writeRepoFile(".env");
    const absoluteEnvPath = path.join(repoDir, ".env");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [{ path: absoluteEnvPath, operation: "modify", contentPreview: "x" }],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGETS_PROTECTED_FILE", level: "error" }),
      ])
    );
  });

  it("multi-patch: a legitimate patch followed by a traversal-hostile one — asserts the SPECIFIC patch's own issue, not just overall isValid (MM4's target)", async () => {
    writeRepoFile("src/good.ts");

    const result = await validatePatchPlan({
      targetPath: repoDir,
      patchPlan: {
        patches: [
          { path: "src/good.ts", operation: "modify", contentPreview: "x" },
          { path: "../secret2.txt", operation: "modify", contentPreview: "x" },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PATH_OUTSIDE_REPO", filePath: "../secret2.txt" }),
      ])
    );
  });
});
