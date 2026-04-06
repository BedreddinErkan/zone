"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runLlmPatchFlow_js_1 = require("../runLlmPatchFlow.js");
const { scanRepoMock, detectProjectStructureMock, rankRelevantFilesMock, readProjectFilesMock, planFeatureWithLlmMock, planPatchPreviewWithLlmMock, planFullPatchWithLlmMock, } = vitest_1.vi.hoisted(() => ({
    scanRepoMock: vitest_1.vi.fn(),
    detectProjectStructureMock: vitest_1.vi.fn(),
    rankRelevantFilesMock: vitest_1.vi.fn(),
    readProjectFilesMock: vitest_1.vi.fn(),
    planFeatureWithLlmMock: vitest_1.vi.fn(),
    planPatchPreviewWithLlmMock: vitest_1.vi.fn(),
    planFullPatchWithLlmMock: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("../../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("../../repo/detectProjectStructure.js", () => ({
    detectProjectStructure: detectProjectStructureMock,
}));
vitest_1.vi.mock("../../repo/rankRelevantFiles.js", () => ({
    rankRelevantFiles: rankRelevantFilesMock,
}));
vitest_1.vi.mock("../../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("../../llm/planFeature.js", () => ({
    planFeatureWithLlm: planFeatureWithLlmMock,
}));
vitest_1.vi.mock("../../llm/planPatchPreview.js", () => ({
    planPatchPreviewWithLlm: planPatchPreviewWithLlmMock,
}));
vitest_1.vi.mock("../../llm/planFullPatch.js", () => ({
    planFullPatchWithLlm: planFullPatchWithLlmMock,
}));
function buildRepoFile(path, category = "unknown") {
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension: path.split(".").pop() ?? "",
        category,
    };
}
(0, vitest_1.describe)("computeFileDiff", () => {
    (0, vitest_1.it)("returns correct added removed unchanged lines", () => {
        const diff = (0, runLlmPatchFlow_js_1.computeFileDiff)("a\nb\nc", "a\nx\nc");
        (0, vitest_1.expect)(diff.map((line) => line.type)).toEqual([
            "unchanged",
            "removed",
            "added",
            "unchanged",
        ]);
    });
    (0, vitest_1.it)("marks all lines added when before is empty", () => {
        const diff = (0, runLlmPatchFlow_js_1.computeFileDiff)("", "a\nb");
        (0, vitest_1.expect)(diff.every((line) => line.type === "added")).toBe(true);
    });
    (0, vitest_1.it)("marks all lines removed when after is empty", () => {
        const diff = (0, runLlmPatchFlow_js_1.computeFileDiff)("a\nb", "");
        (0, vitest_1.expect)(diff.every((line) => line.type === "removed")).toBe(true);
    });
    (0, vitest_1.it)("marks identical files as unchanged only", () => {
        const diff = (0, runLlmPatchFlow_js_1.computeFileDiff)("a\nb", "a\nb");
        (0, vitest_1.expect)(diff.every((line) => line.type === "unchanged")).toBe(true);
        (0, vitest_1.expect)(diff.filter((line) => line.type === "added")).toHaveLength(0);
        (0, vitest_1.expect)(diff.filter((line) => line.type === "removed")).toHaveLength(0);
    });
});
(0, vitest_1.describe)("dryRun flow", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)("populates fileDiffs in dryRun mode without writing files", async () => {
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
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, "export const foo = 1;"])));
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
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.fileDiffs).toHaveLength(1);
            (0, vitest_1.expect)(result.fileDiffs?.[0].filePath).toBe("src/foo.ts");
            (0, vitest_1.expect)(result.fileDiffs?.[0].addedLines).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.fileDiffs?.[0].removedLines).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
        }
    });
});
//# sourceMappingURL=dryRun.test.js.map