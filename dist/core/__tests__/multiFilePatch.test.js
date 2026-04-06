"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const scanRepoMock = vitest_1.vi.fn();
const detectProjectStructureMock = vitest_1.vi.fn();
const rankRelevantFilesMock = vitest_1.vi.fn();
const readProjectFilesMock = vitest_1.vi.fn();
const planFeatureWithLlmMock = vitest_1.vi.fn();
const planPatchPreviewWithLlmMock = vitest_1.vi.fn();
const planFullPatchWithLlmMock = vitest_1.vi.fn();
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
(0, vitest_1.describe)("multi-file patch results", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)("marks all files as applied when every patch succeeds", async () => {
        const files = [
            buildRepoFile("src/foo.ts", "frontend"),
            buildRepoFile("src/bar.ts", "frontend"),
        ];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
        rankRelevantFilesMock.mockReturnValue(files.map((file, index) => ({ ...file, score: 20 - index })));
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Update two files",
            steps: ["Edit foo", "Edit bar"],
            suggestedFiles: files.map((file) => ({
                path: file.path,
                reason: "Relevant file",
                action: "modify",
            })),
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            filePath.endsWith("foo.ts")
                ? "export const foo = 1;"
                : "export const bar = 2;",
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Update constants",
            patches: [
                {
                    path: "src/foo.ts",
                    operation: "modify",
                    summary: "Update foo",
                    targetHint: "foo constant",
                    contentPreview: "foo",
                },
                {
                    path: "src/bar.ts",
                    operation: "modify",
                    summary: "Update bar",
                    targetHint: "bar constant",
                    contentPreview: "bar",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock
            .mockResolvedValueOnce({
            mode: "full_content",
            filePath: "src/foo.ts",
            fullContent: "export const foo = 10;",
            summary: "Updated foo",
            warnings: [],
        })
            .mockResolvedValueOnce({
            mode: "full_content",
            filePath: "src/bar.ts",
            fullContent: "export const bar = 20;",
            summary: "Updated bar",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "update foo and bar",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.patchResults).toEqual([
                { filePath: "src/foo.ts", status: "applied" },
                { filePath: "src/bar.ts", status: "applied" },
            ]);
            (0, vitest_1.expect)(result.patchPreview).toContain("=== PATCH RESULTS ===");
            (0, vitest_1.expect)(result.patchPreview).toContain("✓ src/foo.ts");
            (0, vitest_1.expect)(result.patchPreview).toContain("✓ src/bar.ts");
        }
    });
    (0, vitest_1.it)("keeps successful files and reports failed ones in non-atomic mode", async () => {
        const files = [
            buildRepoFile("src/foo.ts", "frontend"),
            buildRepoFile("src/bar.ts", "frontend"),
        ];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
        rankRelevantFilesMock.mockReturnValue(files.map((file, index) => ({ ...file, score: 20 - index })));
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Update two files",
            steps: ["Edit foo", "Edit bar"],
            suggestedFiles: files.map((file) => ({
                path: file.path,
                reason: "Relevant file",
                action: "modify",
            })),
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            filePath.endsWith("foo.ts")
                ? "export const foo = 1;"
                : "export const bar = 2;",
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Update constants",
            patches: [
                {
                    path: "src/foo.ts",
                    operation: "modify",
                    summary: "Update foo",
                    targetHint: "foo constant",
                    contentPreview: "foo",
                },
                {
                    path: "src/bar.ts",
                    operation: "modify",
                    summary: "Update bar",
                    targetHint: "bar constant",
                    contentPreview: "bar",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock
            .mockResolvedValueOnce({
            mode: "full_content",
            filePath: "src/foo.ts",
            fullContent: "export const foo = 10;",
            summary: "Updated foo",
            warnings: [],
        })
            .mockResolvedValueOnce({
            mode: "patch",
            filePath: "src/bar.ts",
            patchText: [
                "--- FIND ---",
                "export const missing = 2;",
                "--- REPLACE ---",
                "export const missing = 20;",
            ].join("\n"),
            summary: "Updated bar",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "update foo and bar",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
            (0, vitest_1.expect)(result.patchResults).toEqual([
                { filePath: "src/foo.ts", status: "applied" },
                { filePath: "src/bar.ts", status: "failed", reason: "low_confidence" },
            ]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("[PATCH_CONFLICT]");
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain('"filePath":"src/bar.ts"');
            (0, vitest_1.expect)(result.patchPreview).toContain("✗ src/bar.ts");
            (0, vitest_1.expect)(result.patchPreview).toContain("failed (low_confidence");
        }
    });
    (0, vitest_1.it)("returns ok false in atomic mode when any file fails", async () => {
        const files = [
            buildRepoFile("src/foo.ts", "frontend"),
            buildRepoFile("src/bar.ts", "frontend"),
        ];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
        rankRelevantFilesMock.mockReturnValue(files.map((file, index) => ({ ...file, score: 20 - index })));
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Update two files",
            steps: ["Edit foo", "Edit bar"],
            suggestedFiles: files.map((file) => ({
                path: file.path,
                reason: "Relevant file",
                action: "modify",
            })),
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            filePath.endsWith("foo.ts")
                ? "export const foo = 1;"
                : "export const bar = 2;",
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Update constants",
            patches: [
                {
                    path: "src/foo.ts",
                    operation: "modify",
                    summary: "Update foo",
                    targetHint: "foo constant",
                    contentPreview: "foo",
                },
                {
                    path: "src/bar.ts",
                    operation: "modify",
                    summary: "Update bar",
                    targetHint: "bar constant",
                    contentPreview: "bar",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock
            .mockResolvedValueOnce({
            mode: "full_content",
            filePath: "src/foo.ts",
            fullContent: "export const foo = 10;",
            summary: "Updated foo",
            warnings: [],
        })
            .mockResolvedValueOnce({
            mode: "patch",
            filePath: "src/bar.ts",
            patchText: [
                "--- FIND ---",
                "export const missing = 2;",
                "--- REPLACE ---",
                "export const missing = 20;",
            ].join("\n"),
            summary: "Updated bar",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "update foo and bar",
            repoPath: "C:/repo",
            atomicPatch: true,
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: false,
            reason: "atomic_patch_failed",
        });
    });
    (0, vitest_1.it)("marks protected files as skipped", async () => {
        const files = [buildRepoFile("src/ui/index.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["UI app"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "UI tweak",
            steps: ["Edit index"],
            suggestedFiles: [
                { path: "src/ui/index.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockResolvedValue({});
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Protected file attempt",
            patches: [
                {
                    path: "src/ui/index.html",
                    operation: "modify",
                    summary: "Try changing UI",
                    targetHint: "root ui",
                    contentPreview: "ui tweak",
                },
            ],
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "change zone ui",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.patchResults).toEqual([
                { filePath: "src/ui/index.html", status: "skipped", reason: "protected file" },
            ]);
            (0, vitest_1.expect)(result.patchPreview).toContain("~ src/ui/index.html");
            (0, vitest_1.expect)(result.patchPreview).toContain("skipped (protected file)");
        }
        (0, vitest_1.expect)(planFullPatchWithLlmMock).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=multiFilePatch.test.js.map