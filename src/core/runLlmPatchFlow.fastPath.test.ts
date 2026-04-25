import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planFeatureWithLlmMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const planFullPatchWithLlmMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/planFeature.js", () => ({ planFeatureWithLlm: planFeatureWithLlmMock }));
vi.mock("../llm/planPatchPreview.js", () => ({ planPatchPreviewWithLlm: planPatchPreviewWithLlmMock }));
vi.mock("../llm/planFullPatch.js", () => ({ planFullPatchWithLlm: planFullPatchWithLlmMock }));

// Ensure runtime verification doesn't interfere.
vi.mock("./runRuntimeVerification.js", () => ({
  runRuntimeVerificationPlan: vi.fn().mockResolvedValue({
    attempted: false,
    status: "skipped_no_command",
    steps: [],
    summary: "No safe verification command detected.",
  }),
}));

// Force correctness validator to be ok=true but still set forcePreviewOnly (warning-only),
// which previously could keep decisionMode preview_only via fallbackForcePreviewOnly.
vi.mock("../engine/patchCorrectnessValidator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/patchCorrectnessValidator.js")>();
  return {
    ...actual,
    validatePatchCorrectness: vi.fn().mockReturnValue({
      ok: true,
      blocking: [],
      warnings: [
        {
          layer: 1,
          code: "unbalanced_delimiters",
          severity: "warn",
          message: "warning only",
        },
      ],
      forceBlocked: false,
      forcePreviewOnly: true,
      layersRun: 5,
      shortCircuitedAt: null,
    }),
  };
});

function buildRepoFile(
  path: string,
  category: RepoFile["category"] = "frontend"
): RepoFile {
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension: path.split(".").pop() ?? "",
    category,
  };
}

describe("runLlmPatchFlow minimal-safe last-mile override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces safe_to_apply for 1-line validated minimal patch even if earlier gates produced preview_only", async () => {
    const files = [buildRepoFile("client/src/pages/app/PatientScanViewerPage.jsx")];
    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0]!, score: 50 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Remove stray character",
      steps: ["Edit file"],
      suggestedFiles: [
        { path: files[0]!.path, reason: "Target", action: "modify" },
      ],
      risks: [],
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Remove stray",
      patches: [
        {
          path: files[0]!.path,
          operation: "modify",
          summary: "Remove stray char",
          targetHint: "stray",
          contentPreview: "d;",
        },
      ],
      warnings: [],
    });
    readProjectFilesMock.mockResolvedValue({
      [files[0]!.absolutePath]: "export default function X(){\n  d;\n  return null;\n}\n",
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: files[0]!.path,
      fullContent: "export default function X(){\n  return null;\n}\n",
      summary: "Remove stray identifier",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Fix accidental stray character.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches.length).toBeGreaterThan(0);
      expect(result.decisionMode).toBe("safe_to_apply");
      expect(result.finalState).toBe("safe_to_apply");
    }
  });
});

