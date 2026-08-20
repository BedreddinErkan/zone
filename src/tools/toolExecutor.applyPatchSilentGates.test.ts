import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

/**
 * Four apply_patch rejection branches that produced no observable record in real sink data,
 * for two different structural reasons: the zero-blocks branch called no log/debugLog at all;
 * the three per-block branches (empty FIND, empty REPLACE, FIND-not-found) already called
 * debugLog, but that call is gated behind ZONE_VERBOSE_LOGS=1 — never set in normal operation —
 * so in real telemetry they were equally invisible. This file pins the new, unconditional,
 * dedicated marker each one now emits alongside its existing (untouched) diagnostic.
 */

let repoPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function applyPatch(
  filePath: string,
  patch: string,
  input: Record<string, unknown> = {}
) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    input
  );
}

function markerCalls(name: string): unknown[] {
  return logSpy.mock.calls.filter((c) => c[0] === name).map((c) => JSON.parse(String(c[1])));
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-apply-patch-silent-gates-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("positive control — must pass before any negative case below is trusted", () => {
  it("a well-formed patch succeeds and emits none of the four new markers", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await applyPatch(
      "src/a.ts",
      "--- FIND ---\nconst target = 1;\n--- REPLACE ---\nconst target = 2;\n"
    );
    expect(result.success).toBe(true);
    for (const name of [
      "[zone-apply-patch-no-valid-blocks]",
      "[zone-apply-patch-find-block-empty]",
      "[zone-apply-patch-replace-block-empty]",
      "[zone-apply-patch-find-not-found]",
    ]) {
      expect(markerCalls(name), `${name} must not fire on a well-formed patch`).toEqual([]);
    }
  });
});

describe("zero-blocks — previously silent, now discriminated by input shape", () => {
  beforeEach(() => writeRepoFile("src/a.ts", "const target = 1;\n"));

  it("no FIND marker at all", async () => {
    const result = await applyPatch("src/a.ts", "just some text with no markers", {
      model: "test-model-x",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_no_valid_blocks");
    expect(result.rejectionReason).toBe("no_valid_blocks");
    const calls = markerCalls("[zone-apply-patch-no-valid-blocks]");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      hasFindMarkerCaseInsensitive: false,
      hasReplaceMarkerCaseInsensitive: false,
      model: "test-model-x",
    });
  });

  it("lowercased markers — matching is exact-substring, so case is a distinct shape", async () => {
    const result = await applyPatch(
      "src/a.ts",
      "--- find ---\nconst target = 1;\n--- replace ---\nx\n"
    );
    expect(result.error).toBe("apply_patch_no_valid_blocks");
    const calls = markerCalls("[zone-apply-patch-no-valid-blocks]");
    expect(calls[0]).toMatchObject({
      hasFindMarkerCaseInsensitive: true,
      hasReplaceMarkerCaseInsensitive: true,
    });
  });

  it("empty patch — distinguishable from the other three shapes by trimmed length", async () => {
    const result = await applyPatch("src/a.ts", "");
    expect(result.error).toBe("apply_patch_no_valid_blocks");
    const calls = markerCalls("[zone-apply-patch-no-valid-blocks]");
    expect(calls[0]).toMatchObject({ patchTrimmedLength: 0 });
  });

  it("whitespace-only patch", async () => {
    const result = await applyPatch("src/a.ts", "   \n  \n");
    expect(result.error).toBe("apply_patch_no_valid_blocks");
    const calls = markerCalls("[zone-apply-patch-no-valid-blocks]");
    expect(calls[0]).toMatchObject({ patchTrimmedLength: 0 });
  });
});

describe("empty FIND — dedicated marker alongside the existing verbose-gated debugLog", () => {
  it("fires once, unconditionally, with error/rejectionReason on the return", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await applyPatch("src/a.ts", "--- FIND ---\n--- REPLACE ---\nx\n", {
      model: "test-model-x",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_find_block_empty");
    expect(result.rejectionReason).toBe("find_block_empty");
    const calls = markerCalls("[zone-apply-patch-find-block-empty]");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ block: 1, model: "test-model-x" });
  });
});

describe("empty REPLACE — dedicated marker; the accepted delete path must not fire it", () => {
  it("fires on a non-delete empty REPLACE", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await applyPatch(
      "src/a.ts",
      "--- FIND ---\nconst target = 1;\n--- REPLACE ---\n",
      { model: "test-model-x" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_replace_block_empty");
    expect(result.rejectionReason).toBe("replace_block_empty");
    const calls = markerCalls("[zone-apply-patch-replace-block-empty]");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ block: 1, model: "test-model-x" });
  });

  it("does NOT fire when intent='delete' — the accepted path stays accepted", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/a.ts",
        patch: "--- FIND ---\nconst target = 1;\n--- REPLACE ---\n",
        intent: "delete",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(markerCalls("[zone-apply-patch-replace-block-empty]")).toEqual([]);
  });
});

describe("FIND-not-found — dedicated marker; must not disturb marker-split's own two call sites", () => {
  it("fires alongside marker-split when the patch is also multi-block", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await applyPatch(
      "src/a.ts",
      "--- FIND ---\nconst target = 1;\n--- REPLACE ---\nconst target = 2;\n" +
        "--- FIND ---\nthis text does not exist in the file\n--- REPLACE ---\nx\n",
      { model: "test-model-x" }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_find_not_found");
    expect(result.rejectionReason).toBe("find_not_found");
    const findNotFoundCalls = markerCalls("[zone-apply-patch-find-not-found]");
    expect(findNotFoundCalls).toHaveLength(1);
    expect(findNotFoundCalls[0]).toMatchObject({ block: 2, model: "test-model-x" });
    // marker-split's rejected:true call site — same event, established by the prior pass as
    // this branch's own sibling telemetry. Both now carry model; unaffected in count or shape.
    const splitCalls = markerCalls("[zone-apply-patch-marker-split]");
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]).toMatchObject({ rejected: true, model: "test-model-x" });
  });

  it("single-block FIND-not-found: the new marker fires, marker-split does not", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    const result = await applyPatch(
      "src/a.ts",
      "--- FIND ---\nthis text does not exist in the file\n--- REPLACE ---\nx\n"
    );
    expect(result.error).toBe("apply_patch_find_not_found");
    expect(markerCalls("[zone-apply-patch-find-not-found]")).toHaveLength(1);
    expect(markerCalls("[zone-apply-patch-marker-split]")).toEqual([]);
  });
});

describe("model field retrofit — marker-imbalance and marker-split's success call site", () => {
  it("marker-imbalance now carries model", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\n");
    await applyPatch("src/a.ts", "--- FIND ---\nconst target = 1;\n--- REPLACE ---\nx\n--- REPLACE ---\ny\n", {
      model: "test-model-x",
    });
    const calls = markerCalls("[zone-apply-patch-marker-imbalance]");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "test-model-x", runId: null });
  });

  it("marker-split's accepted (rejected:false) call site now carries model", async () => {
    writeRepoFile("src/a.ts", "const target = 1;\nconst other = 2;\n");
    const result = await applyPatch(
      "src/a.ts",
      "--- FIND ---\nconst target = 1;\n--- REPLACE ---\nconst target = 9;\n" +
        "--- FIND ---\nconst other = 2;\n--- REPLACE ---\nconst other = 9;\n",
      { model: "test-model-x" }
    );
    expect(result.success).toBe(true);
    const calls = markerCalls("[zone-apply-patch-marker-split]");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ rejected: false, model: "test-model-x" });
  });
});
