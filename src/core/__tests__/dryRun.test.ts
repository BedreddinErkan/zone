import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../../types/project.js";
import { computeFileDiff } from "../runLlmPatchFlow.js";

const {
  scanRepoMock,
  detectProjectStructureMock,
  rankRelevantFilesMock,
  readProjectFilesMock,
  planFeatureWithLlmMock,
  planPatchPreviewWithLlmMock,
  planFullPatchWithLlmMock,
} = vi.hoisted(() => ({
  scanRepoMock: vi.fn(),
  detectProjectStructureMock: vi.fn(),
  rankRelevantFilesMock: vi.fn(),
  readProjectFilesMock: vi.fn(),
  planFeatureWithLlmMock: vi.fn(),
  planPatchPreviewWithLlmMock: vi.fn(),
  planFullPatchWithLlmMock: vi.fn(),
}));

vi.mock("../../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../../repo/detectProjectStructure.js", () => ({
  detectProjectStructure: detectProjectStructureMock,
}));

vi.mock("../../repo/rankRelevantFiles.js", () => ({
  rankRelevantFiles: rankRelevantFilesMock,
}));

vi.mock("../../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../../llm/planFeature.js", () => ({
  planFeatureWithLlm: planFeatureWithLlmMock,
}));

vi.mock("../../llm/planPatchPreview.js", () => ({
  planPatchPreviewWithLlm: planPatchPreviewWithLlmMock,
}));

vi.mock("../../llm/planFullPatch.js", () => ({
  planFullPatchWithLlm: planFullPatchWithLlmMock,
}));

function buildRepoFile(
  path: string,
  category: RepoFile["category"] = "unknown"
): RepoFile {
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension: path.split(".").pop() ?? "",
    category,
  };
}

describe("computeFileDiff", () => {
  it("returns correct added removed unchanged lines", () => {
    const diff = computeFileDiff("a\nb\nc", "a\nx\nc");
    expect(diff.map((line) => line.type)).toEqual([
      "unchanged",
      "removed",
      "added",
      "unchanged",
    ]);
  });

  it("marks all lines added when before is empty", () => {
    const diff = computeFileDiff("", "a\nb");
    expect(diff.every((line) => line.type === "added")).toBe(true);
  });

  it("marks all lines removed when after is empty", () => {
    const diff = computeFileDiff("a\nb", "");
    expect(diff.every((line) => line.type === "removed")).toBe(true);
  });

  it("marks identical files as unchanged only", () => {
    const diff = computeFileDiff("a\nb", "a\nb");
    expect(diff.every((line) => line.type === "unchanged")).toBe(true);
    expect(diff.filter((line) => line.type === "added")).toHaveLength(0);
    expect(diff.filter((line) => line.type === "removed")).toHaveLength(0);
  });
});

describe("dryRun flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates fileDiffs in dryRun mode without writing files", async () => {
    const files = [buildRepoFile("src/foo.ts", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 10 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Update foo",
      steps: ["Modify foo"],
      suggestedFiles: [
        { path: "src/foo.ts", reason: "Relevant file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, "export const foo = 1;"]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Update foo",
      patches: [
        {
          path: "src/foo.ts",
          operation: "modify",
          summary: "Update foo",
          targetHint: "foo constant",
          contentPreview: "foo",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/foo.ts",
      fullContent: "export const foo = 2;",
      summary: "Updated foo",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "update foo",
      repoPath: "C:/repo",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileDiffs).toHaveLength(1);
      expect(result.fileDiffs?.[0].filePath).toBe("src/foo.ts");
      expect(result.fileDiffs?.[0].addedLines).toBeGreaterThan(0);
      expect(result.fileDiffs?.[0].removedLines).toBeGreaterThan(0);
      expect(result.applyPatches).toHaveLength(1);
    }
  });
});
