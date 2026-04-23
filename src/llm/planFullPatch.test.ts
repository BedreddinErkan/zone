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
    responsesCreateMock.mockResolvedValue({
      output_text:
        "--- FIND ---\nconst value = 1;\n--- REPLACE ---\nconst value = 2;",
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
    expect(responsesCreateMock).toHaveBeenCalledWith({
      model: "test-model",
      input: "prompt",
    });
    expect(withSelfHealingRetryMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "patch",
      filePath: "src/example.ts",
      patchText:
        "--- FIND ---\nconst value = 1;\n--- REPLACE ---\nconst value = 2;",
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });
  });
});
