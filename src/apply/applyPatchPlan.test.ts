import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyPatchPlan } from "./applyPatchPlan.js";

/**
 * Item 304's containment fix. Every hostile case asserts on the filesystem —
 * the outside target's content, or its existence — never only on the thrown
 * error. An exception-only assertion cannot distinguish "refused before
 * writing" from "wrote, then complained" (see FF3 in docs/deferred-work.md).
 */

let repoDir: string;
let outsideDir: string;

beforeEach(() => {
  repoDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-app-repo-"));
  outsideDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-app-outside-"));
});

afterEach(() => {
  fsSync.rmSync(repoDir, { recursive: true, force: true });
  fsSync.rmSync(outsideDir, { recursive: true, force: true });
});

describe("applyPatchPlan — containment (item 304)", () => {
  it("legitimate write at the repo root still succeeds (fail-closed regression net; FF6's repo-root target)", async () => {
    const result = await applyPatchPlan(
      { patches: [{ filePath: "top-level.ts", nextContent: "export const ok = 1;\n" }] },
      repoDir
    );

    expect(result.applied).toBe(true);
    expect(fsSync.readFileSync(path.join(repoDir, "top-level.ts"), "utf8")).toBe(
      "export const ok = 1;\n"
    );
  });

  it("HOSTILE INPUT: an absolute path outside the repo now refuses, and the outside file is unchanged (P1)", async () => {
    const secret = path.join(outsideDir, "secret-p1.txt");
    fsSync.writeFileSync(secret, "ORIGINAL-P1\n", "utf8");

    await expect(
      applyPatchPlan({ patches: [{ filePath: secret, nextContent: "ESCAPED-P1\n" }] }, repoDir)
    ).rejects.toThrow(/resolves outside the repository/);

    expect(fsSync.readFileSync(secret, "utf8")).toBe("ORIGINAL-P1\n");
  });

  it("HOSTILE INPUT: a ../ traversal now refuses, and the outside file is unchanged (P2)", async () => {
    const secret = path.join(outsideDir, "secret-p2.txt");
    fsSync.writeFileSync(secret, "ORIGINAL-P2\n", "utf8");
    const traversal = path.relative(repoDir, secret);

    await expect(
      applyPatchPlan({ patches: [{ filePath: traversal, nextContent: "ESCAPED-P2\n" }] }, repoDir)
    ).rejects.toThrow(/resolves outside the repository/);

    expect(fsSync.readFileSync(secret, "utf8")).toBe("ORIGINAL-P2\n");
  });

  it("HOSTILE INPUT: item 301's in-repo symlink construction now refuses, and the outside file is unchanged (P3, FF2's target)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const secret = path.join(outsideDir, "secret-p3.txt");
    fsSync.writeFileSync(secret, "ORIGINAL-P3\n", "utf8");
    fsSync.symlinkSync(secret, path.join(repoDir, "src", "link.txt"));

    await expect(
      applyPatchPlan(
        { patches: [{ filePath: "src/link.txt", nextContent: "ESCAPED-P3\n" }] },
        repoDir
      )
    ).rejects.toThrow(/resolves outside the repository/);

    expect(fsSync.readFileSync(secret, "utf8")).toBe("ORIGINAL-P3\n");
  });

  it("asymmetric realpath: a repo root itself reached through a symlink still allows a legitimate write", async () => {
    const symlinkedRepo = path.join(os.tmpdir(), `zone-app-repolink-${Date.now()}`);
    fsSync.symlinkSync(repoDir, symlinkedRepo);
    try {
      const result = await applyPatchPlan(
        { patches: [{ filePath: "via-symlinked-root.ts", nextContent: "export const y = 2;\n" }] },
        symlinkedRepo
      );
      expect(result.applied).toBe(true);
      expect(fsSync.readFileSync(path.join(repoDir, "via-symlinked-root.ts"), "utf8")).toBe(
        "export const y = 2;\n"
      );
    } finally {
      fsSync.unlinkSync(symlinkedRepo);
    }
  });

  it("undecidable boundary: a broken symlink target fails closed, not open (FF5's target)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const brokenTarget = path.join(outsideDir, "does-not-exist.txt");
    fsSync.symlinkSync(brokenTarget, path.join(repoDir, "src", "broken.txt"));

    await expect(
      applyPatchPlan(
        { patches: [{ filePath: "src/broken.txt", nextContent: "should not land\n" }] },
        repoDir
      )
    ).rejects.toThrow(/resolves outside the repository/);

    // The symlink itself must remain exactly what it was — not replaced by a
    // regular file containing the rejected content.
    expect(fsSync.lstatSync(path.join(repoDir, "src", "broken.txt")).isSymbolicLink()).toBe(true);
    // A write() through a symlink follows it and can create the target even
    // when the symlink itself is untouched — a check-after-write ordering
    // would still leave the link a link while having created what it points
    // at. The target must not exist either.
    expect(fsSync.existsSync(brokenTarget)).toBe(false);
  });

  it("multi-patch: a legitimate patch followed by an escaping one — patch 1 lands, patch 2's outside target is unchanged (FF4's one killing case)", async () => {
    const secret = path.join(outsideDir, "secret-case7.txt");
    fsSync.writeFileSync(secret, "UNTOUCHED-CASE7\n", "utf8");
    const traversal = path.relative(repoDir, secret);

    await expect(
      applyPatchPlan(
        {
          patches: [
            { filePath: "good.ts", nextContent: "export const a = 1;\n" },
            { filePath: traversal, nextContent: "SHOULD NOT LAND\n" }
          ]
        },
        repoDir
      )
    ).rejects.toThrow(/resolves outside the repository/);

    expect(fsSync.readFileSync(path.join(repoDir, "good.ts"), "utf8")).toBe(
      "export const a = 1;\n"
    );
    expect(fsSync.readFileSync(secret, "utf8")).toBe("UNTOUCHED-CASE7\n");
  });

  it("multi-patch: an escaping patch followed by a legitimate one — the escape throws immediately, the legitimate patch is never attempted (no per-patch catch exists here, unlike applyLlmPatches)", async () => {
    const secret = path.join(outsideDir, "secret-case8.txt");
    fsSync.writeFileSync(secret, "UNTOUCHED-CASE8\n", "utf8");
    const traversal = path.relative(repoDir, secret);

    await expect(
      applyPatchPlan(
        {
          patches: [
            { filePath: traversal, nextContent: "SHOULD NOT LAND\n" },
            { filePath: "good2.ts", nextContent: "export const b = 2;\n" }
          ]
        },
        repoDir
      )
    ).rejects.toThrow(/resolves outside the repository/);

    expect(fsSync.readFileSync(secret, "utf8")).toBe("UNTOUCHED-CASE8\n");
    expect(fsSync.existsSync(path.join(repoDir, "good2.ts"))).toBe(false);
  });
});
