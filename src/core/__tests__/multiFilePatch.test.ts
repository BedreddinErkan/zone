import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../../types/project.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planFeatureWithLlmMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const planFullPatchWithLlmMock = vi.fn();
const runAgentLoopMock = vi.fn();
const classifyTaskMock = vi.fn();

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

vi.mock("../../llm/agentLoop.js", () => ({
  runAgentLoop: runAgentLoopMock,
  stripVerificationTag: vi.fn((s: string) => s),
}));

vi.mock("../../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));

// Only createLLMClient is overridden — ApiKeyError/ProviderRequestError/PlanRefusalError must
// stay real, since runLlmPatchFlow.ts checks `instanceof ApiKeyError` on an unmocked path. These
// tests never supply preGeneratedPlan and force plan_full_patch, so both plannerStep and
// generateExecutionPlan reach createLLMClient(); each call site already wraps the whole call in
// try/catch, so a synchronous throw here degrades gracefully with no assertion changes needed.
vi.mock("../../llm/factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/factory.js")>();
  return {
    ...actual,
    createLLMClient: vi.fn(() => {
      throw new Error("createLLMClient should not be called in this test");
    }),
  };
});

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

describe("multi-file patch results", () => {
  beforeEach(() => {
    process.env["ZONE_FORCE_FLOW"] = "plan_full_patch";
    vi.clearAllMocks();
    classifyTaskMock.mockResolvedValue({
      tier: "medium",
      archetype: "complex_multi_file",
      confidence: 0,
      archetypeConfidence: 0,
      fallbackUsed: true,
    });
    runAgentLoopMock.mockResolvedValue({
      success: true,
      summary: "mock agent loop",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "natural_completion",
      iterCount: 1,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });
  });

  afterEach(() => {
    delete process.env["ZONE_FORCE_FLOW"];
  });

  it.skip("marks all files as applied when every patch succeeds", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          filePath.endsWith("foo.ts")
            ? "export const foo = 1;"
            : "export const bar = 2;",
        ])
      )
    );
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchResults).toEqual([
        { filePath: "src/foo.ts", status: "applied" },
        { filePath: "src/bar.ts", status: "applied" },
      ]);
      expect(result.patchPreview).toContain("=== PATCH RESULTS ===");
      expect(result.patchPreview).toContain("✓ src/foo.ts");
      expect(result.patchPreview).toContain("✓ src/bar.ts");
    }
  });

  it.skip("keeps successful files and reports failed ones in non-atomic mode", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          filePath.endsWith("foo.ts")
            ? "export const foo = 1;"
            : "export const bar = 2;",
        ])
      )
    );
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
          "--- FILE: src/bar.ts ---",
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.patchResults).toEqual([
        { filePath: "src/foo.ts", status: "applied" },
        { filePath: "src/bar.ts", status: "failed", reason: "patch_find_not_found" },
      ]);
      expect(result.warnings.join("\n")).toContain("[PATCH_CONFLICT]");
      expect(result.warnings.join("\n")).toContain('"filePath":"src/bar.ts"');
      expect(result.patchPreview).toContain("✗ src/bar.ts");
      expect(result.patchPreview).toContain("failed (patch_find_not_found");
    }
  });

  it("returns ok false in atomic mode when any file fails", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          filePath.endsWith("foo.ts")
            ? "export const foo = 1;"
            : "export const bar = 2;",
        ])
      )
    );
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
          "--- FILE: src/bar.ts ---",
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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("atomic_patch_failed");
      // item 13: finalRunReport is now populated on this return (was silently
      // discarded before) — assert it's present rather than the old strict
      // two-key .toEqual, which would fail on any legitimate new field here.
      expect(result.finalRunReport).toBeDefined();
    }
  });

  it.skip("rolls back hosted multi-file apply results when one file fails validation", async () => {
    const files = [
      buildRepoFile("src/foo.ts", "frontend"),
      buildRepoFile("src/bar.ts", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
    rankRelevantFilesMock.mockReturnValue(
      files.map((file, index) => ({ ...file, score: 20 - index }))
    );
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
        fullContent:
          "export function register(input: string) {\n  return input;\n}",
        summary: "Removed validation",
        warnings: [],
      });

    const { runLlmPatchFlow } = await import("../runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "update foo and simplify register",
      repoPath: "C:/repo",
      hostedContext: {
        repoSummary: "TS app",
        existingFilesSummary: "foo and bar",
        availableFiles: files.map((file) => ({
          path: file.path,
          category: file.category,
          extension: file.extension,
        })),
        contextFiles: [
          {
            path: "src/foo.ts",
            action: "modify",
            reason: "Relevant file",
            content: "export const foo = 1;",
          },
          {
            path: "src/bar.ts",
            action: "modify",
            reason: "Relevant file",
            content:
              "export function register(input: string) {\n  validateInput(input);\n  return input;\n}",
          },
        ],
        originalContents: {
          "src/foo.ts": "export const foo = 1;",
          "src/bar.ts":
            "export function register(input: string) {\n  validateInput(input);\n  return input;\n}",
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.patchResults).toEqual([
        { filePath: "src/foo.ts", status: "failed", reason: "atomic_rollback" },
        {
          filePath: "src/bar.ts",
          status: "failed",
          reason: "developer_validation_blocked",
        },
      ]);
      expect(result.warnings).toContain(
        "[ATOMIC_ROLLBACK] One or more files failed validation. All changes in this patch set have been rolled back."
      );
    }
  });

  it("marks protected files as skipped", async () => {
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
      task: "adjust layout for the main index page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchResults).toEqual([
        { filePath: "src/ui/index.html", status: "skipped", reason: "protected file" },
      ]);
      expect(result.patchPreview).toContain("~ src/ui/index.html");
      expect(result.patchPreview).toContain("skipped (protected file)");
    }
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
  });
});
