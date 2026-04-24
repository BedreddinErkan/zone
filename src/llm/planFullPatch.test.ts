import { beforeEach, describe, expect, it, vi } from "vitest";

const responsesCreateMock = vi.fn();
const withSelfHealingRetryMock = vi.fn();
const buildFullPatchPromptMock = vi.fn(() => "prompt");
const formatExecutionPlanForPromptMock = vi.fn(() => "");

vi.mock("./openaiClient.js", () => ({
  createOpenAIClient: () => ({
    responses: {
      create: responsesCreateMock,
    },
  }),
  getModelName: () => "test-model",
}));

vi.mock("../core/withSelfHealingRetry.js", () => ({
  withSelfHealingRetry: withSelfHealingRetryMock,
  buildDefaultFeedbackPrompt: vi.fn(),
}));

vi.mock("../prompts/fullPatchPrompt.js", () => ({
  buildFullPatchPrompt: buildFullPatchPromptMock,
}));

vi.mock("./executionPlan.js", () => ({
  formatExecutionPlanForPrompt: formatExecutionPlanForPromptMock,
}));

describe("planFullPatchWithLlm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses full_content mode for small files", async () => {
    withSelfHealingRetryMock.mockResolvedValue({
      ok: true,
      value: {
        filePath: "src/example.ts",
        fullContent: "export const value = 2;",
        summary: "Updated file",
        warnings: [],
      },
    });

    const { planFullPatchWithLlm } = await import("./planFullPatch.js");
    const result = await planFullPatchWithLlm({
      task: "update the constant",
      filePath: "src/example.ts",
      fileContent: "export const value = 1;",
      repoSummary: "repo",
      relatedContext: "context",
    });

    expect(buildFullPatchPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: "full_content",
      })
    );
    expect(withSelfHealingRetryMock).toHaveBeenCalled();
    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "full_content",
      filePath: "src/example.ts",
      fullContent: "export const value = 2;",
      summary: "Updated file",
      warnings: [],
    });
  });

  it("uses find_replace_patch mode for large files", async () => {
    const validPatch =
      "--- FILE: src/example.ts ---\n--- FIND ---\nconst value = 1;\n--- REPLACE ---\nconst value = 2;";
    withSelfHealingRetryMock.mockResolvedValue({
      ok: true,
      value: validPatch,
      attempts: 1,
    });

    const { planFullPatchWithLlm } = await import("./planFullPatch.js");
    const result = await planFullPatchWithLlm({
      task: "update the constant",
      filePath: "src/example.ts",
      fileContent: "a".repeat(8000),
      repoSummary: "repo",
      relatedContext: "context",
    });

    expect(buildFullPatchPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: "find_replace_patch",
      })
    );
    expect(withSelfHealingRetryMock).toHaveBeenCalled();
    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "patch",
      filePath: "src/example.ts",
      patchText: validPatch,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });
  });

  it("returns invalid_patch_format when find_replace retries exhaust without a parseable patch", async () => {
    withSelfHealingRetryMock.mockResolvedValue({
      ok: false,
      reason: "Validation failed after 3 attempts.",
      attempts: 3,
      lastIssues: [],
    });

    const { planFullPatchWithLlm } = await import("./planFullPatch.js");
    const result = await planFullPatchWithLlm({
      task: "update the constant",
      filePath: "src/huge.ts",
      fileContent: "b".repeat(8000),
      repoSummary: "repo",
      relatedContext: "context",
    });

    expect(result.mode).toBe("invalid_patch_format");
    if (result.mode === "invalid_patch_format") {
      expect(result.warnings.some((w) => w.includes("[invalid_patch_format]"))).toBe(
        true
      );
    }
  });

  it("uses full_content mode for constrained localized tasks when the content is already narrowed", async () => {
    withSelfHealingRetryMock.mockResolvedValue({
      ok: true,
      value: {
        filePath: "src/example.tsx",
        fullContent: "export function Example() { return null; }",
        summary: "Updated file",
        warnings: [],
      },
    });

    const { planFullPatchWithLlm } = await import("./planFullPatch.js");
    await planFullPatchWithLlm({
      task: "Add validation to the existing form only. Reuse the existing state and existing submit flow. Do not create a new form.",
      filePath: "src/example.tsx",
      fileContent: "x".repeat(5000),
      repoSummary: "repo",
      relatedContext:
        "// CONTEXT WINDOW: lines 120-180 of 900 total\n\nFocus on the existing create form only.",
    });

    expect(buildFullPatchPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: "full_content",
      })
    );
    expect(withSelfHealingRetryMock).toHaveBeenCalled();
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });
});
