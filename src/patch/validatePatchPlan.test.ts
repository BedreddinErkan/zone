import { beforeEach, describe, expect, it, vi } from "vitest";
import { validatePatchPlan } from "./validatePatchPlan.js";
import * as fileUtils from "../utils/files.js";

describe("validatePatchPlan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when patch item is missing target path", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "",
            operation: "modify",
            contentPreview: "test",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_TARGET_PATH",
          level: "error",
        }),
      ])
    );
  });

  it("returns error for unsupported operation", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/test.ts",
            operation: "delete",
            contentPreview: "x",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSUPPORTED_OPERATION",
          level: "error",
        }),
      ])
    );
  });

  it("returns warning for empty content preview", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/test.ts",
            operation: "modify",
            contentPreview: "",
          },
        ],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EMPTY_CONTENT_PREVIEW",
          level: "warning",
        }),
      ])
    );
  });

  it("returns warning when multiple patches target the same file", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/test.ts",
            operation: "modify",
            contentPreview: "a",
          },
          {
            path: "src/test.ts",
            operation: "modify",
            contentPreview: "b",
          },
        ],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_TARGET_PATH",
          level: "warning",
        }),
      ])
    );
  });

  it("returns warning when create targets an existing file", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/existing.ts",
            operation: "create",
            contentPreview: "content",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CREATE_TARGET_ALREADY_EXISTS",
          level: "warning",
        }),
      ])
    );
  });

  it("returns error when modify targets missing file", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/missing.ts",
            operation: "modify",
            contentPreview: "content",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MODIFY_TARGET_MISSING",
          level: "error",
        }),
      ])
    );
  });

  it("returns error when patch path escapes repository root", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "../secret.txt",
            operation: "modify",
            contentPreview: "content",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PATH_OUTSIDE_REPO",
          level: "error",
        }),
      ])
    );
  });

  it("returns error for protected file targets", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: ".env",
            operation: "modify",
            contentPreview: "SECRET=1",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TARGETS_PROTECTED_FILE",
          level: "error",
        }),
      ])
    );
  });

  it("returns warning for node_modules target", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "node_modules/pkg/index.js",
            operation: "modify",
            contentPreview: "content",
          },
        ],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TARGETS_NODE_MODULES",
          level: "warning",
        }),
      ])
    );
  });

  it("returns warning for internal agent artifact target", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: ".agent-patches/test.txt",
            operation: "modify",
            contentPreview: "content",
          },
        ],
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TARGETS_AGENT_ARTIFACT",
          level: "warning",
        }),
      ])
    );
  });

  it("returns valid when patch plan is clean", async () => {
    vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);

    const result = await validatePatchPlan({
      targetPath: "/repo",
      patchPlan: {
        patches: [
          {
            path: "src/feature.ts",
            operation: "modify",
            contentPreview: "const x = 1;",
          },
        ],
      } as any,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});