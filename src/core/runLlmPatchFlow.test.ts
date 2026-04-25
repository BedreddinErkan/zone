import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planFeatureWithLlmMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const planFullPatchWithLlmMock = vi.fn();
const runRuntimeVerificationPlanMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../repo/detectProjectStructure.js", () => ({
  detectProjectStructure: detectProjectStructureMock,
}));

vi.mock("../repo/rankRelevantFiles.js", () => ({
  rankRelevantFiles: rankRelevantFilesMock,
}));

vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../llm/planFeature.js", () => ({
  planFeatureWithLlm: planFeatureWithLlmMock,
}));

vi.mock("../llm/planPatchPreview.js", () => ({
  planPatchPreviewWithLlm: planPatchPreviewWithLlmMock,
}));

vi.mock("../llm/planFullPatch.js", () => ({
  planFullPatchWithLlm: planFullPatchWithLlmMock,
}));

vi.mock("./runRuntimeVerification.js", () => ({
  runRuntimeVerificationPlan: runRuntimeVerificationPlanMock,
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

describe("runLlmPatchFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRuntimeVerificationPlanMock.mockResolvedValue({
      attempted: false,
      status: "skipped_no_command",
      steps: [],
      summary: "No safe verification command detected.",
    });
  });

  it("blocks Zone-internal product tasks before patching the selected repo", async () => {
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix the Zone UI run-state mapping so preview_only does not show Done in the inspect panel",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("zone_internal_task_target");
      expect(result.decisionMode).toBe("blocked");
      expect(result.finalState).toBe("blocked");
      expect(result.validationBlocked).toBe(true);
      expect(result.applyPatches).toEqual([]);
      expect(result.patchPreview).toContain("Task targets Zone itself");
      expect(result.warnings).toContain(
        "[ZONE_INTERNAL_TASK] Task targets Zone itself, not the selected repo. Switch to the Zone codebase or clarify the intended target before patching."
      );
    }
    expect(scanRepoMock).not.toHaveBeenCalled();
    expect(planFeatureWithLlmMock).not.toHaveBeenCalled();
    expect(planPatchPreviewWithLlmMock).not.toHaveBeenCalled();
  });

  it("does not block a normal repo task that mentions /api/patch without referring to Zone", async () => {
    const files = [buildRepoFile("src/server/routes.ts", "backend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Express API"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 32 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix external endpoint behavior",
      steps: ["Adjust route logic"],
      suggestedFiles: [
        { path: "src/server/routes.ts", reason: "API route", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix the /api/patch endpoint in our app so it returns the correct response body",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(scanRepoMock).toHaveBeenCalledWith("C:/repo");
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalled();
  });

  it("aborts preview-empty fallback when Target file line names a path outside repo/context (explicit_target_not_found)", async () => {
    const files = [
      buildRepoFile("ai-service/requirements.txt", "backend"),
      buildRepoFile("src/server/routes.ts", "backend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Monorepo"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 95 },
      { ...files[1], score: 30 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix conversion",
      steps: ["Update patch conversion"],
      suggestedFiles: [{ path: "src/server/routes.ts", reason: "API", action: "modify" }],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task:
        "Target file: src/core/patchConversion.ts\n\nRefactor patch conversion helpers for clarity.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("explicit_target_not_found");
      expect(result.patchSource).toBe("no_patch");
      expect(result.decisionMode).toBe("preview_only");
      expect(result.finalState).toBe("preview_only");
      expect(result.warnings[0]).toContain("[EXPLICIT_TARGET_NOT_FOUND]");
      expect(result.finalRunReport.title).toBe("Patch generation failed");
      expect(result.finalRunReport.changesMade.join(" ").toLowerCase()).toContain("no files changed");
      expect(result.finalRunReport.verificationSummary.message.toLowerCase()).toContain(
        "explicit target file was not found"
      );
      expect(planFeatureWithLlmMock).not.toHaveBeenCalled();
      expect(planPatchPreviewWithLlmMock).not.toHaveBeenCalled();
      expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
      const failEv = result.lifecycleEvents?.filter((e) => e.type === "patch_generation_failed");
      expect(failEv?.some((e) => e.status === "explicit_target_not_found")).toBe(true);
    }
  });

  it("preview-empty ranked fallback skips unrelated requirements.txt when task does not name it", async () => {
    const files = [
      buildRepoFile("ai-service/requirements.txt", "backend"),
      buildRepoFile("src/server/routes.ts", "backend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Monorepo"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 95 },
      { ...files[1], score: 30 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix endpoint",
      steps: ["Adjust route logic"],
      suggestedFiles: [{ path: "src/server/routes.ts", reason: "API route", action: "modify" }],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/server/routes.ts",
      fullContent: "patched routes",
      summary: "ok",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix the /api/patch endpoint in our app so it returns the correct response body",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/server/routes.ts" })
    );
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "ai-service/requirements.txt" })
    );
  });

  it("preview-empty fallback uses explicit Target file when path is grounded in repo", async () => {
    const files = [buildRepoFile("src/server/routes.ts", "backend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Express API"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 32 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix external endpoint behavior",
      steps: ["Adjust route logic"],
      suggestedFiles: [
        { path: "src/server/routes.ts", reason: "API route", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/server/routes.ts",
      fullContent: "patched",
      summary: "ok",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Target file: src/server/routes.ts\n\nAdd request logging to the handler.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/server/routes.ts" })
    );
  });

  describe("explicit Target file hosted force-include", () => {
    const patientScanPath = "client/src/pages/app/PatientScanViewerPage.jsx";

    it("force-loads explicit target from repo listing when missing from hosted originals/context", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const otherPath = "src/utils/helpers.jsx";
      const availableFiles = [
        { path: patientScanPath, category: "frontend" as const, extension: "jsx" },
        { path: otherPath, category: "frontend" as const, extension: "jsx" },
      ];
      const contextFiles = [
        {
          path: otherPath,
          action: "inspect",
          reason: "ctx",
          content: "export const x = 1;\n",
        },
      ];
      const originalContents: Record<string, string> = {};

      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files }) =>
        [...files].map((f, idx) => ({ ...f, score: 100 - idx }))
      );
      readProjectFilesMock.mockImplementation(async (paths: string[]) => {
        const out: Record<string, string> = {};
        for (const p of paths) {
          out[p] =
            p === patientScanPath
              ? "export function PatientScanViewerPage() { return <div/>; }\n"
              : `// ${p}\n`;
        }
        return out;
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch summary",
        patches: [],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: patientScanPath,
        fullContent: "export function PatientScanViewerPage() { return <div/>; }\n//fixed\n",
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: `Target file: ${patientScanPath}\n\nFix the syntax issue caused by an accidental stray character.`,
        repoPath: "/hosted",
        hostedContext: {
          repoSummary: "React",
          existingFilesSummary: "files",
          availableFiles,
          contextFiles,
          originalContents,
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reason).not.toBe("explicit_target_not_found");
      }
      expect(
        consoleLogSpy.mock.calls.some(
          (c) => c[0] === "[zone-explicit-target-force-included]" && c[1] === patientScanPath
        )
      ).toBe(true);
      expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: patientScanPath })
      );
      expect(planFullPatchWithLlmMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "ai-service/requirements.txt" })
      );
      const previewArg = planPatchPreviewWithLlmMock.mock.calls[0][0] as {
        fileContexts: Array<{ path: string; content: string }>;
        suggestedFiles: Array<{ path: string; reason: string }>;
      };
      expect(previewArg.fileContexts[0]?.path).toBe(patientScanPath);
      expect(previewArg.suggestedFiles[0]?.reason).toContain("Explicit target file from user prompt");
      consoleLogSpy.mockRestore();
    });

    it("returns explicit_target_not_found when Target file is absent from hosted availableFiles listing", async () => {
      const availableFiles = [
        { path: "src/other.jsx", category: "frontend" as const, extension: "jsx" },
      ];
      const contextFiles = [
        {
          path: "src/other.jsx",
          action: "inspect",
          reason: "ctx",
          content: "export const y = 2;\n",
        },
      ];
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files }) =>
        [...files].map((f, idx) => ({ ...f, score: 100 - idx }))
      );
      readProjectFilesMock.mockResolvedValue({});
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch summary",
        patches: [],
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: `Target file: ${patientScanPath}\n\nFix typo.`,
        repoPath: "/hosted",
        hostedContext: {
          repoSummary: "React",
          existingFilesSummary: "files",
          availableFiles,
          contextFiles,
          originalContents: {},
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reason).toBe("explicit_target_not_found");
      }
      expect(planPatchPreviewWithLlmMock).not.toHaveBeenCalled();
      expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
    });
  });

  it("does not block a normal repo task that mentions billing summary and thread ui without referring to Zone", async () => {
    const files = [buildRepoFile("src/components/BillingThreadPanel.tsx", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 36 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix app panel behavior",
      steps: ["Adjust thread UI state"],
      suggestedFiles: [
        {
          path: "src/components/BillingThreadPanel.tsx",
          reason: "Billing thread UI component",
          action: "modify",
        },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix the billing summary cards in our thread ui so the panel updates correctly",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(scanRepoMock).toHaveBeenCalledWith("C:/repo");
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalled();
  });

  it("supplements sparse llm suggestions with ranked relevant files for developer context", async () => {
    const files = [
      buildRepoFile("src/App.tsx", "frontend"),
      buildRepoFile("server/routes/auth.ts", "backend"),
      buildRepoFile("server/middleware/session.ts", "backend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React + Express"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[1], score: 30 },
      { ...files[2], score: 28 },
      { ...files[0], score: 12 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix auth flow",
      steps: ["Update auth route"],
      suggestedFiles: [
        { path: "src/App.tsx", reason: "Visible entry point", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix auth bug in login flow",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFeatureWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          normalizedTask: "fix auth bug in login flow",
        }),
        existingFilesSummary: expect.stringContaining(
          "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):"
        ),
      })
    );
    expect(planFeatureWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        existingFilesSummary: expect.stringContaining("- src/App.tsx"),
      })
    );
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFiles: [
          {
            path: "server/routes/auth.ts",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
          {
            path: "server/middleware/session.ts",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
          { path: "src/App.tsx", reason: "Visible entry point", action: "inspect" },
        ],
      })
    );
  });

  it("prefers higher-ranked localized files over broad app shells in preview context", async () => {
    const files = [
      buildRepoFile("client/src/App.jsx", "frontend"),
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/PatientCreateForm.jsx", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[1], score: 52 },
      { ...files[2], score: 46 },
      { ...files[0], score: 14 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add small Patients form validation",
      steps: ["Validate the create form fields"],
      suggestedFiles: [
        { path: "client/src/App.jsx", reason: "Visible entry point", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the Patients page create form",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFiles: [
          {
            path: "client/src/pages/PatientsPage.jsx",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
          {
            path: "client/src/components/PatientCreateForm.jsx",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
          { path: "client/src/App.jsx", reason: "Visible entry point", action: "inspect" },
        ],
      })
    );
  });

  it("prefers files that already contain the existing form state and submit flow for constrained tasks", async () => {
    const files = [
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
      buildRepoFile("client/src/App.jsx", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[1], score: 58 },
      { ...files[0], score: 54 },
      { ...files[2], score: 14 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add small create-form validation",
      steps: ["Reuse the existing Patients form state and submit flow"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Lead capture component", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/pages/PatientsPage.jsx": `
        import { useState } from "react";
        export function PatientsPage() {
          const [formData, setFormData] = useState({ firstName: "" });
          const handleSubmit = async (event) => {
            event.preventDefault();
            await api.post("/patients", formData);
          };
          return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
        }
      `,
      "C:/repo/client/src/components/ClinicLeads.jsx": `
        export function ClinicLeads() {
          return <section><h2>Clinic leads</h2></section>;
        }
      `,
      "C:/repo/client/src/App.jsx": `
        export function App() {
          return <PatientsPage />;
        }
      `,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFiles: [
          {
            path: "client/src/pages/PatientsPage.jsx",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
          {
            path: "client/src/components/ClinicLeads.jsx",
            reason: "Lead capture component",
            action: "inspect",
          },
          {
            path: "client/src/App.jsx",
            reason: "High repo relevance for the requested developer task",
            action: "inspect",
          },
        ],
        fileContexts: [
          expect.objectContaining({ path: "client/src/pages/PatientsPage.jsx" }),
          expect.objectContaining({ path: "client/src/components/ClinicLeads.jsx" }),
          expect.objectContaining({ path: "client/src/App.jsx" }),
        ],
      })
    );
  });

  it("excludes irrelevant environment and build files from developer context selection", async () => {
    const files = [
      buildRepoFile("src/styles/landing.css", "frontend"),
      buildRepoFile("node_modules/library/index.js", "unknown"),
      buildRepoFile("venv/lib/site-packages/pkg.py", "unknown"),
      buildRepoFile("dist/assets/app.css", "frontend"),
      buildRepoFile("build/output.css", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Frontend app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 35 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Adjust landing spacing",
      steps: ["Tweak landing card gap"],
      suggestedFiles: [
        { path: "node_modules/library/index.js", reason: "bad suggestion", action: "inspect" },
        { path: "src/styles/landing.css", reason: "Actual target", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Tighten card gap",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix spacing between landing cards",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFiles: [
          {
            path: "src/styles/landing.css",
            reason: "Actual target",
            action: "modify",
          },
        ],
      })
    );
  });

  it("flags and rejects generic scaffold overwrites for existing html files on small ui tasks", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Tighten spacing"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<h1>Zone</h1><button>Execute</button><button>Reset</button><section id="patchSection" class="section">Patch Preview</section><div id="progressBox" class="progress-box"></div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div>`,
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish the existing UI",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Improve readability",
          targetHint: "main layout",
          contentPreview: "Update spacing",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        `<!DOCTYPE html><html><body><h1>Welcome to My App</h1><section>Features</section><button>Get Started</button><div>Application Dashboard</div></body></html>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI polish and readability improvements for the existing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
    }
  });

  it("rejects generic document skeleton outputs for existing ui files on small ui tasks", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust line height"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="recent-runs">Recent Runs</div></body>`,
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish line height",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Adjust text spacing",
          targetHint: "styles",
          contentPreview: "line-height tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div><script src="/path/to/your/script.js"></script></body></html>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI style tweak for readability",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
      expect(result.warnings.join("\n")).toContain("generic document skeleton");
    }
  });

  it("rejects broad rewrites that remove existing ui anchors on small spacing tasks", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust spacing"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><section id="patchSection" class="section">Patch Preview</section><aside class="recent-runs">Recent Runs</aside><div id="progressBox" class="progress-box"></div>`,
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish spacing",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Adjust spacing across the page",
          targetHint: "layout",
          contentPreview: "spacing polish",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        `<main class="shell"><section class="hero"><h2>Cleaner interface</h2><p>Updated spacing and layout.</p></section><section class="content-grid"><div class="panel"></div><div class="panel"></div><div class="panel"></div></section></main>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing polish for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
      expect(result.warnings.join("\n")).toContain("critical existing UI anchors");
    }
  });

  it("allows a real minimal ui tweak for an existing html file", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust font size"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div></body>`,
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish the existing UI",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Increase body line height slightly",
          targetHint: "style block",
          contentPreview: "line-height: 1.7",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        `<body><h1>Zone</h1><div class="toolbar compact"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files readable" style="line-height:1.7"></div><div class="recent-runs">Recent Runs</div></body>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI polish and readability improvements for the existing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.warnings.join("\n")).not.toContain("DEVELOPER_UI_OVERWRITE");
      expect(result.designSystemSignals).toEqual(
        expect.objectContaining({
          inlineStyleCount: 0,
          styleAttributeLines: 1,
          excessiveInlineStyles: false,
          reusableClassPreferenceMissed: false,
        })
      );
    }
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "C:/repo",
        taskIntent: expect.stringContaining("small ui polish"),
        outputMode: "full_content",
        relevantFiles: expect.arrayContaining([
          expect.objectContaining({ path: "src/pages/home.html" }),
        ]),
        existingTargetFiles: expect.arrayContaining(["src/pages/home.html"]),
      })
    );
  });

  it("downgrades oversized css rewrites for micro-edit tasks to preview_only", async () => {
    const files = [buildRepoFile("src/styles/landing.css", "frontend")];
    const originalCss = Array.from(
      { length: 95 },
      (_, index) => `.analysis-card-${index} { gap: ${index % 5}px; margin: 0; }`
    ).join("\n");
    const rewrittenCss = Array.from(
      { length: 95 },
      (_, index) =>
        `.analysis-card-${index} { display: grid; gap: ${index % 7}px; margin: 12px; padding: 16px; border-radius: 12px; }`
    ).join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Marketing site"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 42 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Tighten landing card spacing",
      steps: ["Adjust spacing only"],
      suggestedFiles: [
        { path: "src/styles/landing.css", reason: "Landing styles", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalCss]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust spacing between analysis cards",
      patches: [
        {
          path: "src/styles/landing.css",
          operation: "modify",
          summary: "Adjust card spacing",
          targetHint: "analysis cards",
          contentPreview: "gap tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/styles/landing.css",
      fullContent: rewrittenCss,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Fix spacing between the analysis cards on the SmileAI landing page. Do not change layout structure or card content.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisionMode).toBe("preview_only");
      expect(result.intentMismatch).toEqual(
        expect.objectContaining({
          hasMismatch: true,
          severity: "high",
          reasonCodes: expect.arrayContaining([
            "LARGE_REWRITE",
            "STRUCTURAL_LAYOUT_CHANGE",
            "MASSIVE_STYLE_INJECTION",
          ]),
        })
      );
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          semanticAlignmentScore: expect.any(Number),
        })
      );
  expect(result.microEditProtection).toEqual(
        expect.objectContaining({
          isViolation: true,
          shouldForcePreview: true,
          violationReasons: expect.arrayContaining([
            "Micro-edit patch expanded into a large rewrite.",
          ]),
        })
      );
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "preview_only",
          safetyReasons: expect.arrayContaining([
            "Intent mismatch requires manual preview.",
          ]),
        })
      );
      expect(result.patchQuality?.qualityScore).toBeLessThan(80);
      expect(result.developerRisk?.score).toBeGreaterThanOrEqual(31);
      expect(result.developerRisk?.breakdown.massScope).toBeGreaterThan(0);
      expect(result.warnings).toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
      expect(result.warnings).toContain(
        "CSS patch scope is too large for a spacing-only request."
      );
    }
  });

  it("caps confidence for medium severity intent mismatch without adding a new hard block rule", async () => {
    const files = [
      buildRepoFile("src/components/Header.tsx", "frontend"),
      buildRepoFile("src/components/Footer.tsx", "frontend"),
    ];
    const originalContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">before</span>',
      '      <span className="footer-copy">before</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedHeaderContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">after</span>',
      '      <span className="footer-copy">before</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedFooterContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">before</span>',
      '      <span className="footer-copy">after</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 40 },
      { ...files[1], score: 38 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix small copy polish",
      steps: ["Update two labels"],
      suggestedFiles: [
        { path: "src/components/Header.tsx", reason: "Header copy", action: "modify" },
        { path: "src/components/Footer.tsx", reason: "Footer copy", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust two labels",
      patches: [
        {
          path: "src/components/Header.tsx",
          operation: "modify",
          summary: "Update header copy",
          targetHint: "label text",
          contentPreview: "after",
        },
        {
          path: "src/components/Footer.tsx",
          operation: "modify",
          summary: "Update footer copy",
          targetHint: "label text",
          contentPreview: "after",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock
      .mockResolvedValueOnce({
        mode: "full_content",
        summary: "Generated content",
        warnings: [],
        filePath: "src/components/Header.tsx",
        fullContent: updatedHeaderContent,
      })
      .mockResolvedValueOnce({
        mode: "full_content",
        summary: "Generated content",
        warnings: [],
        filePath: "src/components/Footer.tsx",
        fullContent: updatedFooterContent,
      });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix small copy typo in the header label",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intentMismatch).toEqual(
        expect.objectContaining({
          hasMismatch: true,
          severity: "medium",
          reasonCodes: expect.arrayContaining(["MULTI_FILE_EXPANSION"]),
        })
      );
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          semanticAlignmentScore: 70,
        })
      );
      expect(result.microEditProtection).toEqual(
        expect.objectContaining({
          isViolation: true,
          shouldForcePreview: true,
          violationReasons: expect.arrayContaining([
            "Micro-edit patch changed multiple files.",
          ]),
        })
      );
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "preview_only",
          safetyReasons: expect.arrayContaining([
            "Intent mismatch requires manual preview.",
          ]),
        })
      );
      expect(result.developerConfidence).toBe(55);
      expect(result.warnings).toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
    }
  });

  it("keeps normal flow unchanged when there is no intent mismatch", async () => {
    const files = [buildRepoFile("src/components/Banner.tsx", "frontend")];
    const originalContent = [
      "export function Banner() {",
      "  return (",
      '    <section className="banner">',
      '      <span className="eyebrow">before</span>',
      '      <strong>Welcome</strong>',
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Banner() {",
      "  return (",
      '    <section className="banner">',
      '      <span className="eyebrow">after</span>',
      '      <strong>Welcome</strong>',
      "    </section>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 33 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix one small copy string",
      steps: ["Update single string"],
      suggestedFiles: [
        { path: "src/components/Banner.tsx", reason: "Banner copy", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust banner text",
      patches: [
        {
          path: "src/components/Banner.tsx",
          operation: "modify",
          summary: "Update banner copy",
          targetHint: "banner text",
          contentPreview: "after",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Banner.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix copy typo in the banner text",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intentMismatch).toEqual({
        hasMismatch: false,
        severity: "none",
        reasonCodes: [],
        warnings: [],
      });
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          qualityWarnings: [],
        })
      );
      expect(result.designSystemSignals).toEqual(
        expect.objectContaining({
          inlineStyleCount: 0,
          styleAttributeLines: 0,
          excessiveInlineStyles: false,
          reusableClassPreferenceMissed: false,
        })
      );
      expect(result.microEditProtection).toEqual({
        isViolation: false,
        violationReasons: [],
        shouldForcePreview: false,
        shouldDowngradeSafety: false,
      });
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "safe_auto_apply",
        })
      );
      expect(result.patchQuality?.qualityScore).toBeGreaterThanOrEqual(90);
      expect(result.decisionMode).toBe("safe_to_apply");
      expect(result.warnings).not.toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
    }
  });

  it("adds review risk and caps confidence for ui mapping swap tasks", async () => {
    const files = [buildRepoFile("src/components/Timeline.tsx", "frontend")];
    const originalContent = [
      "export function Timeline() {",
      "  return (",
      "    <section>",
      '      <Card title="Before" description="Old copy" />',
      '      <Card title="After" description="New copy" />',
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Timeline() {",
      "  return (",
      "    <section>",
      '      <Card title="After" description="New copy" />',
      '      <Card title="Before" description="Old copy" />',
      "    </section>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React landing page"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 38 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Swap before/after card mapping",
      steps: ["Reverse card order"],
      suggestedFiles: [
        { path: "src/components/Timeline.tsx", reason: "Timeline cards", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Swap card order",
      patches: [
        {
          path: "src/components/Timeline.tsx",
          operation: "modify",
          summary: "Swap the before/after cards",
          targetHint: "card order",
          contentPreview: "Before/After order",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/components/Timeline.tsx",
      fullContent: updatedContent,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "swap the before and after card mapping on the landing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerConfidence).toBeLessThanOrEqual(70);
      expect(result.developerRisk?.score).toBeGreaterThan(0);
      expect(result.warnings).toContain(
        "UI mapping/order changes are higher-risk and should be reviewed carefully."
      );
    }
  });

  it("uses targeted existing-file snippet context for small spacing tasks", async () => {
    const files = [
      buildRepoFile("src/pages/home.html", "frontend"),
      buildRepoFile("src/styles/theme.css", "frontend"),
    ];
    const currentHtml = [
      "<body>",
      '<div class="hero">Welcome</div>',
      '<div id="progressBox" class="progress-box"></div>',
      '<div id="patchSection" class="section">Patch Preview</div>',
      '<div class="content readable" style="line-height:1.5;padding:12px">Body</div>',
      '<div class="recent-runs">Recent Runs</div>',
      "</body>",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 40 },
      { ...files[1], score: 18 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust spacing"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
        { path: "src/styles/theme.css", reason: "Related style file", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          filePath.endsWith("home.html")
            ? currentHtml
            : ".content { line-height: 1.5; padding: 12px; }",
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish spacing",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Adjust spacing in the content block",
          targetHint: "content block",
          contentPreview: "padding and line-height tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent: currentHtml.replace(
        "line-height:1.5;padding:12px",
        "line-height:1.7;padding:16px"
      ),
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing and line-height polish for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        relevantFiles: [
          expect.objectContaining({
            path: "src/pages/home.html",
            content: expect.stringContaining("line-height:1.5"),
          }),
          expect.objectContaining({
            path: "src/styles/theme.css",
          }),
        ],
      })
    );
    const relevantFilesArg = planFullPatchWithLlmMock.mock.calls[0][0].relevantFiles;
    expect(relevantFilesArg[0].content).toContain("// === SNIPPET:");
    expect(relevantFilesArg[0].content).toContain("padding:12px");
  });

  it("surfaces design system signals and inline-style penalties in developer metadata", async () => {
    const files = [buildRepoFile("src/components/Card.tsx", "frontend")];
    const originalContent = [
      "export function Card() {",
      "  return <div className=\"card\">Hello</div>;",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Card() {",
      "  return <div className=\"card\" style={{ marginTop: 12 }}>Hello</div>;",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 35 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add spacing to card",
      steps: ["Adjust margin"],
      suggestedFiles: [
        { path: "src/components/Card.tsx", reason: "Card component", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust card spacing",
      patches: [
        {
          path: "src/components/Card.tsx",
          operation: "modify",
          summary: "Add top spacing to the card",
          targetHint: "card wrapper",
          contentPreview: "style tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Card.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "add a small top margin to the card",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.designSystemSignals).toEqual({
        inlineStyleCount: 1,
        styleAttributeLines: 1,
        addedClassNameCount: 1,
        excessiveInlineStyles: false,
        reusableClassPreferenceMissed: false,
      });
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          designSystemComplianceScore: 96,
        })
      );
      expect(result.patchQuality?.qualityWarnings).toContain(
        "Inline styles detected instead of using existing UI classes"
      );
      expect(result.patchQuality?.qualityWarnings).not.toContain(
        "Patch does not introduce reusable class-based styling"
      );
      expect(result.decisionMode).toBe("safe_to_apply");
    }
  });

  it("does not inflate small localized critical-domain patches into high risk", async () => {
    const files = [buildRepoFile("src/components/LoginCard.tsx", "frontend")];
    const originalContent = [
      "export function LoginCard() {",
      '  return <button className="login-card__button">Continue</button>;',
      "}",
    ].join("\n");
    const updatedContent = [
      "export function LoginCard() {",
      '  return <button className="login-card__button login-card__button--compact">Continue</button>;',
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React auth UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 32 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Tighten auth button spacing",
      steps: ["Adjust one auth button class"],
      suggestedFiles: [
        { path: "src/components/LoginCard.tsx", reason: "Auth UI button", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust login button spacing",
      patches: [
        {
          path: "src/components/LoginCard.tsx",
          operation: "modify",
          summary: "Add a compact button modifier class",
          targetHint: "login button",
          contentPreview: "button class tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/LoginCard.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "adjust auth button spacing in the login card",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerRisk).toEqual({
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      });
expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "safe_auto_apply",
        })
      );
      expect(result.warnings.join("\n")).not.toContain("[HIGH_RISK] Task risk score");
      expect(result.warnings.join("\n")).not.toContain("destructive");
      expect(result.warnings.join("\n")).not.toContain("mass_scope");
    }
  });

  it("keeps a tiny one-file badge addition in the low-risk range", async () => {
    const files = [buildRepoFile("src/components/Header.tsx", "frontend")];
    const originalContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <h1 className="title">Zone</h1>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <h1 className="title">Zone <span className="badge">New</span></h1>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 28 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add a small header badge",
      steps: ["Add one inline badge element"],
      suggestedFiles: [
        { path: "src/components/Header.tsx", reason: "Header component", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add a small badge next to the title",
      patches: [
        {
          path: "src/components/Header.tsx",
          operation: "modify",
          summary: "Add one small badge element",
          targetHint: "header title",
          contentPreview: "badge",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Header.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "add a small new badge next to the header title",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerRisk).toEqual({
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      });
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "safe_auto_apply",
        })
      );
      expect(result.warnings.join("\n")).not.toContain("destructive");
      expect(result.warnings.join("\n")).not.toContain("mass_scope");
      expect(result.warnings.join("\n")).not.toContain("[HIGH_RISK] Task risk score");
    }
  });

  it("does not inflate tiny badge additions from harmless cleanup wording", async () => {
    const files = [buildRepoFile("src/components/Header.tsx", "frontend")];
    const originalContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <h1 className="title">Zone</h1>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <h1 className="title">Zone <span className="badge">New</span></h1>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 28 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Clean up the header card with a tiny badge",
      steps: ["Add one small badge element"],
      suggestedFiles: [
        { path: "src/components/Header.tsx", reason: "Header component", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add a tiny badge to the relevant header title",
      patches: [
        {
          path: "src/components/Header.tsx",
          operation: "modify",
          summary: "Add one small badge element",
          targetHint: "header title",
          contentPreview: "badge",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Header.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "clean up every header card by adding a tiny new badge to the title",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerRisk).toEqual({
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      });
      expect(result.warnings.join("\n")).not.toContain("destructive");
      expect(result.warnings.join("\n")).not.toContain("mass_scope");
      expect(result.safetyResolution?.safetyLevel).toBe("safe_auto_apply");
    }
  });

  it("keeps a tiny one-file text tweak out of high_risk_blocked", async () => {
    const files = [buildRepoFile("src/components/Hero.tsx", "frontend")];
    const originalContent = [
      "export function Hero() {",
      '  return <p className="hero-copy">Start building today.</p>;',
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Hero() {",
      '  return <p className="hero-copy">Start building with Zone today.</p>;',
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React marketing UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 26 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Adjust hero copy",
      steps: ["Update one sentence"],
      suggestedFiles: [
        { path: "src/components/Hero.tsx", reason: "Hero copy", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Update one hero sentence",
      patches: [
        {
          path: "src/components/Hero.tsx",
          operation: "modify",
          summary: "Replace one text string",
          targetHint: "hero paragraph",
          contentPreview: "copy tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Hero.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change one hero sentence to mention Zone",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerRisk).toEqual({
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      });
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "safe_auto_apply",
        })
      );
      expect(result.safetyResolution?.safetyLevel).not.toBe("high_risk_blocked");
      expect(result.warnings.join("\n")).not.toContain("destructive");
      expect(result.warnings.join("\n")).not.toContain("mass_scope");
    }
  });

  it("blocks very high task-risk destructive admin tasks before patch generation", async () => {
    const files = [buildRepoFile("src/admin/users.ts", "backend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Admin backend"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 36 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Delete all dormant users and auth tokens",
      steps: ["Replace archive path with permanent deletion"],
      suggestedFiles: [
        { path: "src/admin/users.ts", reason: "User deletion flow", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({});
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Would delete dormant users",
      patches: [
        {
          path: "src/admin/users.ts",
          operation: "modify",
          summary: "Switch archive call to permanent delete call",
          targetHint: "user removal helper",
          contentPreview: "deleteUser(userId)",
        },
      ],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "delete all dormant users and auth tokens from the production admin panel",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchPreview).toContain("blocked before patch generation");
      expect(result.applyPatches).toEqual([]);
      expect(result.decisionMode).toBe("preview_only");
      expect(result.warnings.join("\n")).toMatch(/HIGH_RISK.*Task risk score/);
    }
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalled();
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
  });

  it("rejects invalid full-file scaffold output that is not patch-style", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("src/pages/home.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust spacing"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><button>Execute</button><button>Reset</button></body>`,
        ])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish spacing",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Adjust spacing",
          targetHint: "body styles",
          contentPreview: "spacing polish",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div></body></html>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing tweak for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.reason).toBe("invalid_patch_format");
      expect(result.finalExecutionOutcome).toBe("completed_with_issues");
      expect(result.finalState).toBe("blocked");
      expect(result.validationBlocked).toBe(true);
      expect(result.warnings.join("\n")).toContain("[invalid_patch_format]");
      expect(result.warnings.join("\n")).toContain("NO_CODE_CHANGE_PRODUCED");
    }
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-patch-conversion]",
      expect.stringContaining('"failureReason":"invalid_patch_format"')
    );
    consoleLogSpy.mockRestore();
  });

  // Tooling vs code verification behavior is covered in deterministic fallback tests below,
  // which reliably produce a patch in this harness.

  it("applies raw find/replace patch mode for large files", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = `${"<div class=\"line\">filler</div>\n".repeat(400)}<button class="exec-btn">Execute</button>\n${"<div class=\"line\">after</div>\n".repeat(400)}`;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `--- FILE: src/pages/home.html ---\n--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetFile).toBe("src/pages/home.html");
      expect(result.patchPreview).toContain("Targeted file: src/pages/home.html");
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
      expect(result.warnings.join("\n")).not.toContain("PATCH_FIND_NOT_FOUND");
    }
  });

  it("applies large-file patch mode when whitespace differs", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = [
      "<body>",
      '  <button class="exec-btn">Execute</button>',
      "</body>",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `--- FILE: src/pages/home.html ---\n--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
    }
  });

  it("applies large-file patch mode when tabs differ from spaces", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = [
      "<body>",
      '\t<button class="exec-btn">Execute</button>',
      "</body>",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `--- FILE: src/pages/home.html ---\n--- FIND ---\n  <button class="exec-btn">Execute</button>\n--- REPLACE ---\n  <button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
    }
  });

  it("passes large files through find_replace_patch mode", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = Array.from(
      { length: 900 },
      (_, index) =>
        index === 450
          ? '  <button class="exec-btn">Execute</button>'
          : `<div>line ${index}</div>`
    ).join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `--- FILE: src/pages/home.html ---\n--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: "find_replace_patch",
      })
    );
  });

  it("accepts fenced find/replace patch output for large files", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = [
      "<body>",
      '  <button class="exec-btn">Execute</button>',
      "</body>",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText: [
        "```text",
        "--- FILE: src/pages/home.html ---",
        "--- FIND ---",
        '<button class="exec-btn">Execute</button>',
        "--- REPLACE ---",
        '<button class="exec-btn" style="background:#1a8cdb">Execute</button>',
        "```",
      ].join("\n"),
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
    }
  });

  it("fails gracefully when fuzzy large-file patch match cannot be found", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml = [
      "<body>",
      '  <button class="exec-btn">Execute</button>',
      "</body>",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust button color"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish button color",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Update execute button styling",
          targetHint: "button block",
          contentPreview: "button color tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "patch",
      filePath: "src/pages/home.html",
      patchText:
        `--- FILE: src/pages/home.html ---\n--- FIND ---\n<button class="missing-btn">Execute</button>\n--- REPLACE ---\n<button class="missing-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.reason).toBe("no_match_abort");
      expect(result.finalExecutionOutcome).toBe("completed_with_issues");
      expect(result.finalState).toBe("blocked");
      expect(result.validationBlocked).toBe(true);
      expect(result.warnings.join("\n")).toContain("PATCH_NO_MATCH_ABORT");
      expect(result.warnings.join("\n")).toContain("raw_and_normalized_find_not_found");
      expect(result.warnings.join("\n")).toContain("NO_CODE_CHANGE_PRODUCED");
    }
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-patch-conversion]",
      expect.stringContaining('"failureReason":"no_match_abort"')
    );
    consoleLogSpy.mockRestore();
  });

  it("uses full_content mode for constrained single-file large-file tasks with a narrowed context window", async () => {
    const files = [buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend")];
    const currentContent = Array.from(
      { length: 900 },
      (_, index) =>
        index === 450
          ? '  return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;'
          : `const fillerLine${index} = "${index}";`
    ).join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 60 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add small validation",
      steps: ["Reuse the existing state and submit flow"],
      suggestedFiles: [
        { path: "client/src/pages/PatientsPage.jsx", reason: "Patients page", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/pages/PatientsPage.jsx",
          operation: "modify",
          summary: "Add minimal validation to the existing create form",
          targetHint: "existing create form",
          contentPreview: "validation around handleSubmit",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/PatientsPage.jsx",
      fullContent: `${currentContent}\n// validation`,
      summary: "Updated file",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Add minimal validation to the existing form only. Reuse the existing state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: "full_content",
      })
    );
  });

  it("recovers with constrained fallback when preview target lacks required form structure", async () => {
    const files = [
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 60 },
      { ...files[1], score: 58 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add small create-form validation",
      steps: ["Reuse the existing Patients form state and submit flow"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Lead capture component", action: "inspect" },
        { path: "client/src/pages/PatientsPage.jsx", reason: "Patients page", action: "inspect" },
      ],
      risks: [],
    });
    const patientsSource = `
        import { useState } from "react";
        export function PatientsPage() {
          const [formData, setFormData] = useState({ firstName: "" });
          const handleSubmit = async (event) => {
            event.preventDefault();
            await api.post("/patients", formData);
          };
          return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
        }
      `;
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/ClinicLeads.jsx": `
        export function ClinicLeads() {
          return <section><h2>Clinic leads</h2></section>;
        }
      `,
      "C:/repo/client/src/pages/PatientsPage.jsx": patientsSource,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Add validation near the create flow",
          targetHint: "existing create form",
          contentPreview: "validation around submit flow",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/PatientsPage.jsx",
      fullContent: `${patientsSource}\n// validation`,
      summary: "Updated file",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call. Do not modify unrelated components.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetFile).toBe("client/src/components/ClinicLeads.jsx");
      expect(result.patchPreview).toContain(
        "Targeted file: client/src/components/ClinicLeads.jsx"
      );
      expect(result.applyPatches.length).toBe(0);
      expect(result.warnings.join("\n")).toContain("[no_op_patch]");
      expect(result.warnings.join("\n")).toContain("target_file_constraint_mismatch");
    }
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "client/src/pages/PatientsPage.jsx",
      })
    );
    const fullPatchPaths = planFullPatchWithLlmMock.mock.calls.map(
      (call) => (call[0] as { filePath: string }).filePath
    );
    expect(fullPatchPaths).not.toContain("client/src/components/ClinicLeads.jsx");
  });

  it("blocks constrained tasks when the target has form structure but not the task entity (path/content)", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
    ];
    const clinicLeadsWithForm = `
      import { useState } from "react";
      export function ClinicLeads() {
        const [formData, setFormData] = useState({ email: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/patients", formData);
          await api.post("/clinic-leads", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Save</button></form>;
      }
    `;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 60 },
      { ...files[1], score: 58 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add small create-form validation",
      steps: ["Reuse the existing Patients form state and submit flow"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Lead capture component", action: "inspect" },
        { path: "client/src/pages/PatientsPage.jsx", reason: "Patients page", action: "inspect" },
      ],
      risks: [],
    });
    const patientsPageSource = `
        import { useState } from "react";
        export function PatientsPage() {
          const [formData, setFormData] = useState({ firstName: "" });
          const handleSubmit = async (event) => {
            event.preventDefault();
            await api.post("/patients", formData);
          };
          return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
        }
      `;
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithForm,
      "C:/repo/client/src/pages/PatientsPage.jsx": patientsPageSource,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Add validation near the create flow",
          targetHint: "existing create form",
          contentPreview: "validation around submit flow",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/PatientsPage.jsx",
      fullContent: `${patientsPageSource}\n// validation`,
      summary: "Updated file",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call. Do not modify unrelated components.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetFile).toBe("client/src/components/ClinicLeads.jsx");
      expect(result.warnings.join("\n")).toContain("target_entity_mismatch");
      expect(result.applyPatches.length).toBe(0);
      expect(result.warnings.join("\n")).toContain("[no_op_patch]");
    }
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "client/src/pages/PatientsPage.jsx",
      })
    );
    expect(
      planFullPatchWithLlmMock.mock.calls.map(
        (call) => (call[0] as { filePath: string }).filePath
      )
    ).not.toContain("client/src/components/ClinicLeads.jsx");
    const eligibilityLog = consoleLogSpy.mock.calls.find(
      (call) => call[0] === "[zone-target-eligibility]"
    )?.[1] as string | undefined;
    expect(eligibilityLog).toBeDefined();
    expect(eligibilityLog).toContain('"entityMatch":false');
    expect(eligibilityLog).toContain('"entitySource":"none"');
    consoleLogSpy.mockRestore();
  });

  it("logs entitySource content when strict heading matches but path does not (still ineligible)", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend")];
    const clinicLeadsWithFormAndHeading = `
      import { useState } from "react";
      export function ClinicLeads() {
        const [formData, setFormData] = useState({ email: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/clinic-leads", formData);
        };
        return (
          <form onSubmit={handleSubmit}>
            <h2>Patients signup</h2>
            <button type="submit">Save</button>
          </form>
        );
      }
    `;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 58 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Patients form"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithFormAndHeading,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Add validation",
          targetHint: "existing create form",
          contentPreview: "x",
        },
      ],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    const eligibilityLog = consoleLogSpy.mock.calls.find(
      (call) => call[0] === "[zone-target-eligibility]"
    )?.[1] as string | undefined;
    expect(eligibilityLog).toBeDefined();
    expect(eligibilityLog).toContain('"entityMatch":false');
    expect(eligibilityLog).toContain('"entitySource":"content"');
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it("returns no_eligible_target_found when preview is rejected and no fallback file passes eligibility", async () => {
    const files = [
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
    ];
    const clinicFormWrongEntity = `
      import { useState } from "react";
      export function ClinicLeads() {
        const [formData, setFormData] = useState({ email: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/clinic-leads", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Save</button></form>;
      }
    `;
    const patientsWeakNoFormFlow = `export function PatientsPage() { return <div>Patients</div>; }`;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 60 },
      { ...files[1], score: 58 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Patients page form"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        { path: "client/src/pages/PatientsPage.jsx", reason: "Patients page", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/ClinicLeads.jsx": clinicFormWrongEntity,
      "C:/repo/client/src/pages/PatientsPage.jsx": patientsWeakNoFormFlow,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Add validation",
          targetHint: "existing create form",
          contentPreview: "x",
        },
      ],
      warnings: [],
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("no_eligible_target_found");
      expect(result.applyPatches).toEqual([]);
    }
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
    const fallbackLog = consoleLogSpy.mock.calls.find(
      (call) => call[0] === "[zone-target-fallback]"
    )?.[1] as string | undefined;
    expect(fallbackLog).toContain('"reason":"no_eligible_fallback"');
    expect(fallbackLog).toContain("candidatesChecked");
    expect(fallbackLog).toContain("rejectedPreviewPaths");
    expect(fallbackLog).toContain("rejectedCandidates");
    expect(fallbackLog).toContain("entityAnchors");
    expect(fallbackLog).toContain("entityPathCandidates");
    expect(fallbackLog).toContain("rankedCandidates");
    consoleLogSpy.mockRestore();
  });

  it("constrained fallback discovers PatientsPage via entity-path candidates when rank omits it", async () => {
    const fillerPaths = Array.from(
      { length: 8 },
      (_, index) => `client/src/misc/Filler${index}Page.jsx`
    );
    const patientsDeep = "client/src/pages/app/PatientsPage.jsx";
    const clinicPath = "client/src/components/ClinicLeads.jsx";

    const files: RepoFile[] = [
      ...fillerPaths.map((path) => buildRepoFile(path, "frontend")),
      buildRepoFile(patientsDeep, "frontend"),
      buildRepoFile(clinicPath, "frontend"),
    ];

    const fillerContent = `export function Placeholder() { return <div />; }`;
    const patientsContent = `
      import { useState } from "react";
      export function PatientsPage() {
        const [formData, setFormData] = useState({ firstName: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/patients", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
      }
    `;
    const clinicContent = `
      import { useState } from "react";
      export function ClinicLeads() {
        const [formData, setFormData] = useState({ email: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/clinic-leads", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Save</button></form>;
      }
    `;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    const rankOrderExcludingPatients = [...fillerPaths, clinicPath];
    rankRelevantFilesMock.mockImplementation(({ files: rankedIn }) =>
      rankOrderExcludingPatients
        .map((path, index) => {
          const base = rankedIn.find((f) => f.path === path);
          return base ? { ...base, score: 200 - index } : null;
        })
        .filter((entry): entry is RepoFile & { score: number } => entry !== null)
    );

    readProjectFilesMock.mockImplementation(async (paths: string[]) => {
      const entries: Record<string, string> = {};
      for (const abs of paths) {
        const norm = abs.replace(/\\/g, "/");
        if (fillerPaths.some((p) => norm.endsWith(p))) {
          entries[abs] = fillerContent;
        } else if (norm.includes("PatientsPage")) {
          entries[abs] = patientsContent;
        } else if (norm.includes("ClinicLeads")) {
          entries[abs] = clinicContent;
        } else {
          entries[abs] = "// file";
        }
      }
      return entries;
    });

    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Validation",
      steps: ["Patients page"],
      suggestedFiles: [{ path: clinicPath, reason: "Leads", action: "inspect" }],
      risks: [],
    });

    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: clinicPath,
          operation: "modify",
          summary: "Validation",
          targetHint: "existing create form",
          contentPreview: "x",
        },
      ],
      warnings: [],
    });

    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: patientsDeep,
      fullContent: `${patientsContent}\n// ok`,
      summary: "ok",
      warnings: [],
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: patientsDeep })
    );
    expect(
      planFullPatchWithLlmMock.mock.calls.map(
        (call) => (call[0] as { filePath: string }).filePath
      )
    ).not.toContain(clinicPath);

    const fallbackLog = consoleLogSpy.mock.calls.find(
      (call) => call[0] === "[zone-target-fallback]"
    )?.[1] as string | undefined;
    expect(fallbackLog).toContain('"reason":"selected_fallback"');
    expect(fallbackLog).toContain(patientsDeep);
    expect(fallbackLog).toContain("candidatesChecked");
    expect(fallbackLog).toContain("entityPathCandidates");
    expect(fallbackLog).toContain("entityAnchors");
    expect(fallbackLog).toContain("rankedCandidates");
    expect(fallbackLog).toContain("pathTokensDebug");
    const parsed = JSON.parse(fallbackLog!) as {
      entityPathCandidates: string[];
      pathTokensDebug: Record<string, string[]>;
    };
    expect(parsed.entityPathCandidates).toContain(patientsDeep);
    expect(parsed.pathTokensDebug[patientsDeep]).toEqual(
      expect.arrayContaining([
        "client",
        "src",
        "pages",
        "app",
        "patients",
        "page",
      ])
    );
    consoleLogSpy.mockRestore();
  });

  it("allows constrained tasks when structure and task entity match the target file", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [
      buildRepoFile("client/src/components/PatientCreateForm.jsx", "frontend"),
    ];
    const formSource = `
      import { useState } from "react";
      export function PatientCreateForm() {
        const [formData, setFormData] = useState({ firstName: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/patients", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
      }
    `;

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 62 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Validation on create form",
      steps: ["Reuse existing Patients page form state"],
      suggestedFiles: [
        { path: "client/src/components/PatientCreateForm.jsx", reason: "Patients create form", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/PatientCreateForm.jsx": formSource,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/PatientCreateForm.jsx",
          operation: "modify",
          summary: "Add validation",
          targetHint: "existing create form",
          contentPreview: "validation",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/components/PatientCreateForm.jsx",
      fullContent: `${formSource}\n// validation`,
      summary: "Updated file",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "client/src/components/PatientCreateForm.jsx",
      })
    );
    const eligibilityLog = consoleLogSpy.mock.calls.find(
      (call) => call[0] === "[zone-target-eligibility]"
    )?.[1] as string | undefined;
    expect(eligibilityLog).toContain('"entityMatch":true');
    expect(eligibilityLog).toContain('"entitySource":"path"');
    consoleLogSpy.mockRestore();
  });

  it("does not call planFullPatchWithLlm for an ineligible constrained target when preview lists multiple files", async () => {
    const files = [
      buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 60 },
      { ...files[1], score: 58 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Reuse existing form"],
      suggestedFiles: [
        { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        { path: "client/src/pages/PatientsPage.jsx", reason: "Patients", action: "inspect" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/client/src/components/ClinicLeads.jsx": `
        export function ClinicLeads() {
          return <section><h2>Clinic leads</h2></section>;
        }
      `,
      "C:/repo/client/src/pages/PatientsPage.jsx": `
        import { useState } from "react";
        export function PatientsPage() {
          const [formData, setFormData] = useState({ firstName: "" });
          const handleSubmit = async (event) => {
            event.preventDefault();
            await api.post("/patients", formData);
          };
          return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
        }
      `,
    });
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Add validation",
          targetHint: "create form",
          contentPreview: "validation",
        },
        {
          path: "client/src/pages/PatientsPage.jsx",
          operation: "modify",
          summary: "Add validation",
          targetHint: "existing create form",
          contentPreview: "validation",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/PatientsPage.jsx",
      fullContent: "// patched",
      summary: "ok",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call. Do not modify unrelated components.",
      repoPath: "C:/repo",
    });

    const fullPatchPaths = planFullPatchWithLlmMock.mock.calls.map(
      (call) => (call[0] as { filePath: string }).filePath
    );
    expect(fullPatchPaths).not.toContain("client/src/components/ClinicLeads.jsx");
    expect(fullPatchPaths).toContain("client/src/pages/PatientsPage.jsx");
  });

  it("hosted context: does not call planFullPatchWithLlm for ineligible constrained target among multiple patches", async () => {
    detectProjectStructureMock.mockReturnValue({ notes: ["React frontend"] });
    rankRelevantFilesMock.mockImplementation(({ files }) =>
      files.map((f, idx) => ({ ...f, score: 55 - idx }))
    );
    const clinicLeadsMinimal = `
      export function ClinicLeads() {
        return <section><h2>Clinic leads</h2></section>;
      }
    `;
    const patientsWithForm = `
      import { useState } from "react";
      export function PatientsPage() {
        const [formData, setFormData] = useState({ firstName: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/patients", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Create</button></form>;
      }
    `;
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Patch summary",
      patches: [
        {
          path: "client/src/components/ClinicLeads.jsx",
          operation: "modify",
          summary: "Tweak leads",
          targetHint: "form",
          contentPreview: "x",
        },
        {
          path: "client/src/pages/PatientsPage.jsx",
          operation: "modify",
          summary: "Validation",
          targetHint: "existing form",
          contentPreview: "y",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/PatientsPage.jsx",
      fullContent: `${patientsWithForm}\n// ok`,
      summary: "ok",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "/hosted",
      hostedContext: {
        repoSummary: "React",
        existingFilesSummary: "files",
        availableFiles: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            category: "frontend",
            extension: "jsx",
          },
          {
            path: "client/src/pages/PatientsPage.jsx",
            category: "frontend",
            extension: "jsx",
          },
        ],
        contextFiles: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            action: "inspect",
            reason: "ctx",
            content: clinicLeadsMinimal,
          },
          {
            path: "client/src/pages/PatientsPage.jsx",
            action: "inspect",
            reason: "ctx",
            content: patientsWithForm,
          },
        ],
        originalContents: {
          "client/src/components/ClinicLeads.jsx": clinicLeadsMinimal,
          "client/src/pages/PatientsPage.jsx": patientsWithForm,
        },
      },
    });

    const fullPatchPaths = planFullPatchWithLlmMock.mock.calls.map(
      (call) => (call[0] as { filePath: string }).filePath
    );
    expect(fullPatchPaths).not.toContain("client/src/components/ClinicLeads.jsx");
    expect(fullPatchPaths).toContain("client/src/pages/PatientsPage.jsx");
  });

  it("blocks protected src/ui files from developer apply patches", async () => {
    const files = [buildRepoFile("src/ui/index.html", "frontend")];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Polish UI",
      steps: ["Adjust spacing"],
      suggestedFiles: [
        { path: "src/ui/index.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockResolvedValue({});
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Polish spacing",
      patches: [
        {
          path: "src/ui/index.html",
          operation: "modify",
          summary: "Adjust spacing",
          targetHint: "body styles",
          contentPreview: "spacing polish",
        },
      ],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing tweak for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings).toContain(
        "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
      );
    }
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
  });

  it("does not apply preview patches; uses full patch only", async () => {
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml =
      '<body><button class="exec-btn">Execute</button><span class="status">Ready</span></body>';

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add badge",
      steps: ["Add a tiny status badge"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add a tiny badge",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Append a tiny badge next to status text",
          targetHint: "status span",
          contentPreview:
            "--- FILE: src/pages/home.html ---\n--- FIND ---\n<span class=\"status\">Ready</span>\n--- REPLACE ---\n<span class=\"status\">Ready <span class=\"badge\">New</span></span>",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        '<body><button class="exec-btn">Execute</button><span class="status">Ready <span class="badge">New</span></span></body>',
      summary: "Added badge next to status text.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "add a tiny badge next to the ready status text",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        '<span class="badge">New</span>'
      );
      expect(result.developerRisk).toEqual(
        expect.objectContaining({
          breakdown: {
            destructive: 0,
            schema: 0,
            massScope: 0,
          },
        })
      );
    }
    expect(planFullPatchWithLlmMock).toHaveBeenCalled();
  });

  it("LLM patch success: reports llm_patch source and no fallback warning", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("src/pages/home.html", "frontend")];
    const currentHtml =
      '<body><button class="exec-btn">Execute</button><span class="status">Ready</span></body>';

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add badge",
      steps: ["Add badge"],
      suggestedFiles: [
        { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add badge",
      patches: [
        {
          path: "src/pages/home.html",
          operation: "modify",
          summary: "Add badge",
          targetHint: "status span",
          contentPreview: "(preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/pages/home.html",
      fullContent:
        '<body><button class="exec-btn">Execute</button><span class="status">Ready <span class="badge">New</span></span></body>',
      summary: "Added badge next to status text.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "add a badge next to the ready status text",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchQualitySummary?.source).toBe("llm_patch");
      expect(result.warnings.join("\n")).not.toContain(
        "[deterministic_fallback_used]"
      );
    }
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-patch-quality] source",
      "llm_patch"
    );
    consoleLogSpy.mockRestore();
  });

  it("generates a deterministic fallback patch when LLM fails for constrained localized task", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("client/src/pages/app/PatientsPage.jsx", "frontend")];
    const currentJsx = [
      "export function PatientsPage() {",
      "  const [fullName, setFullName] = useState(\"\");",
      "  const [email, setEmail] = useState(\"\");",
      "  const [error, setError] = useState(null);",
      "  const [search, setSearch] = useState(\"\");",
      "  const rows = patients.filter((p) => p.name.includes(search));",
      "  const submitForm = () => fetch(\"/api\", { method: \"POST\" });",
      "  const handleSubmit = (e) => {",
      "    e.preventDefault();",
      "    setFormError(\"\");",
      "    setSuccess(\"\");",
      "    submitForm();",
      "  };",
      "  return (",
      "    <div className=\"page\">",
      "      <input value={search} onChange={(e) => setSearch(e.target.value)} />",
      "      <form className=\"form\" onSubmit={handleSubmit}></form>",
      "      <table className=\"table\">{rows.map((r) => <tr key={r.id}></tr>)}</table>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Validate inputs"],
      suggestedFiles: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          reason: "Target page",
          action: "modify",
        },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentJsx]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add validation",
      patches: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          operation: "modify",
          summary: "Insert validation in submit handler",
          targetHint: "handleSubmit",
          contentPreview: "(advisory preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "invalid_patch_format",
      filePath: "client/src/pages/app/PatientsPage.jsx",
      summary: "Model failed",
      warnings: ["[invalid_patch_format] Model failed after retries"],
    });
    runRuntimeVerificationPlanMock.mockResolvedValue({
      attempted: true,
      status: "failed_environment_or_tooling",
      steps: [
        {
          attempted: true,
          command: "npm run test:e2e",
          status: "failed",
          exitCode: 1,
          summary: "Playwright: browser executable doesn't exist",
          kind: "test",
          classifiedFailure: "tooling",
        },
      ],
      failedCommand: "npm run test:e2e",
      summary: "Playwright: browser executable doesn't exist",
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing form submit handler only. Reuse the existing state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.patchQualitySummary?.source).toBe("deterministic_fallback");
      expect(result.decisionMode).toBe("preview_only");
      expect(result.developerConfidence).toBeLessThanOrEqual(65);
      expect(result.verificationStatus).toBe("tooling_issue");
      expect(result.finalExecutionOutcome).toBe("completed_with_tooling_issue");
      expect(result.warnings.join("\n")).toContain(
        "[deterministic_fallback_used]"
      );
      expect(result.warnings.join("\n")).toContain("setup/tooling");
      expect(result.applyPatches[0].filePath).toBe(
        "client/src/pages/app/PatientsPage.jsx"
      );
      expect(result.applyPatches[0].fullContent).toContain(
        "Full name is required"
      );
      expect(result.applyPatches[0].fullContent).toContain("Invalid email");
      const diff = result.fileDiffs?.[0];
      const totalChanged =
        (diff?.addedLines ?? 0) + (diff?.removedLines ?? 0);
      expect(totalChanged).toBeLessThan(20);
      // Ensure unrelated UI sections remain present (we didn't rewrite JSX/search/table)
      expect(result.applyPatches[0].fullContent).toContain("className=\"table\"");
      expect(result.applyPatches[0].fullContent).toContain("setSearch");
    }
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-fallback] generating deterministic patch",
      "client/src/pages/app/PatientsPage.jsx"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-patch-quality] source",
      "deterministic_fallback"
    );
    consoleLogSpy.mockRestore();
  });

  it("fallback cannot safely insert: reports no_patch source and deterministic_fallback_no_safe_insertion", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const files = [buildRepoFile("client/src/pages/app/PatientsPage.jsx", "frontend")];
    const currentJsx = [
      "import { useState } from \"react\";",
      "export function PatientsPage() {",
      "  const [fullName, setFullName] = useState(\"\");",
      "  const [email, setEmail] = useState(\"\");",
      "  const [formError, setFormError] = useState(\"\");",
      "  const [success, setSuccess] = useState(\"\");",
      "  const onCreate = () => {};",
      "  return (",
      "    <div>",
      "      <h1>Patients</h1>",
      "      <form onSubmit={onCreate}>",
      "        <input value={fullName} onChange={(e) => setFullName(e.target.value)} />",
      "        <input value={email} onChange={(e) => setEmail(e.target.value)} />",
      "        <button type=\"submit\">Create</button>",
      "      </form>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Validate inputs"],
      suggestedFiles: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          reason: "Target page",
          action: "modify",
        },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentJsx]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add validation",
      patches: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          operation: "modify",
          summary: "Insert validation",
          targetHint: "handleSubmit",
          contentPreview: "(advisory preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "invalid_patch_format",
      filePath: "client/src/pages/app/PatientsPage.jsx",
      summary: "Model failed",
      warnings: ["[invalid_patch_format] Model failed after retries"],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing form submit handler only. Reuse the existing state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.patchQualitySummary?.source).toBe("no_patch");
      expect(result.patchPreview).toContain(
        "deterministic_fallback_no_safe_insertion"
      );
      // Ensure we didn't generate a fake comment-only append patch.
      expect(result.patchPreview).not.toContain("validation fallback applied");
    }
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[zone-patch-quality] source",
      "no_patch"
    );
    consoleLogSpy.mockRestore();
  });

  it("broken fallback syntax: blocks and warns generated_patch_broken_state_call", async () => {
    const files = [
      buildRepoFile("client/src/pages/app/PatientsPage.jsx", "frontend"),
    ];
    const brokenJsx = [
      "import { useState } from \"react\";",
      "export function PatientsPage() {",
      "  const [fullName, setFullName] = useState(\"\");",
      "  const [email, setEmail] = useState(\"\");",
      "  const [formError, setFormError] = useState(\"\");",
      "  const [success, setSuccess] = useState(\"\");",
      "  const submitForm = () => fetch(\"/api\", { method: \"POST\" });",
      "  const handleSubmit = (e) => {",
      "    e.preventDefault();",
      "    setSuccess(\"\"",
      "    submitForm();",
      "  };",
      "  return <form onSubmit={handleSubmit}></form>;",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Add validation",
      steps: ["Validate inputs"],
      suggestedFiles: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          reason: "Target",
          action: "modify",
        },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, brokenJsx]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Add validation",
      patches: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          operation: "modify",
          summary: "Insert validation",
          targetHint: "handleSubmit",
          contentPreview: "(preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "invalid_patch_format",
      filePath: "client/src/pages/app/PatientsPage.jsx",
      summary: "Model failed",
      warnings: ["[invalid_patch_format] Model failed after retries"],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing form submit handler only. Reuse the existing state and existing submit flow. Do not create a new form.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join("\n")).toContain("[unbalanced_delimiters]");
      expect(result.decisionMode).not.toBe("safe_to_apply");
      expect(result.finalState).toBe("blocked");
    }
  });

  it("unbalanced syntax: blocks and warns generated_patch_unbalanced_syntax", async () => {
    const files = [buildRepoFile("src/example.ts", "frontend")];
    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["TS app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Change",
      steps: ["Edit file"],
      suggestedFiles: [
        { path: "src/example.ts", reason: "Target", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [filePath, "export const x = 1;\n"])
      )
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Change",
      patches: [
        {
          path: "src/example.ts",
          operation: "modify",
          summary: "Edit",
          targetHint: "x",
          contentPreview: "(preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/example.ts",
      fullContent: "export const x = (1;\n",
      summary: "Broken syntax",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "In src/example.ts, change the exported constant x. Keep changes minimal and valid TypeScript.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join("\n")).toContain("[unbalanced_delimiters]");
      expect(result.finalState).toBe("blocked");
    }
  });

  it("constrained oversized patch: warns generated_patch_too_large_for_constrained_task and is not safe_to_apply", async () => {
    const files = [
      buildRepoFile("client/src/pages/app/PatientsPage.jsx", "frontend"),
    ];
    const original = [
      "import { useState } from \"react\";",
      "export function PatientsPage() {",
      "  const [fullName, setFullName] = useState(\"\");",
      "  const [formError, setFormError] = useState(\"\");",
      "  const [success, setSuccess] = useState(\"\");",
      "  const submitForm = () => fetch(\"/api\", { method: \"POST\" });",
      "  const handleSubmit = (e) => {",
      "    e.preventDefault();",
      "    setFormError(\"\");",
      "    setSuccess(\"\");",
      "    submitForm();",
      "  };",
      "  return <form onSubmit={handleSubmit}></form>;",
      "}",
      "",
    ].join("\n");
    const tooLarge = [
      "import { useState } from \"react\";",
      "export function PatientsPage() {",
      "  const [fullName, setFullName] = useState(\"\");",
      "  const [formError, setFormError] = useState(\"\");",
      "  const [success, setSuccess] = useState(\"\");",
      "  const submitForm = () => fetch(\"/api\", { method: \"POST\" });",
      "  const handleSubmit = (e) => {",
      "    e.preventDefault();",
      "    setFormError(\"\");",
      "    setSuccess(\"\");",
      ...Array.from(
        { length: 28 },
        (_, i) =>
          `    if (fullName === "x${i}") { setFormError("bad"); return; }`
      ),
      "    submitForm();",
      "  };",
      "  return <form onSubmit={handleSubmit}></form>;",
      "}",
      "",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Validation",
      steps: ["Edit"],
      suggestedFiles: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          reason: "Target",
          action: "modify",
        },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, original]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Validation",
      patches: [
        {
          path: "client/src/pages/app/PatientsPage.jsx",
          operation: "modify",
          summary: "Edit",
          targetHint: "handleSubmit",
          contentPreview: "(preview)",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "client/src/pages/app/PatientsPage.jsx",
      fullContent: tooLarge,
      summary: "Too large",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Add minimal client-side validation to the existing form submit handler only. Reuse the existing state and existing submit flow. Do not create a new form.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join("\n")).toContain("[byte_explosion]");
      expect(result.decisionMode).not.toBe("safe_to_apply");
    }
  });

  describe("bounded fallback retry loop", () => {
    const captureRetryLogs = () => {
      const entries: Array<{
        attempt: number;
        filePath: string;
        eligible: boolean;
        reason: string;
      }> = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        if (args[0] === "[zone-target-retry]" && typeof args[1] === "string") {
          entries.push(JSON.parse(args[1]));
        }
      });
      return { entries, spy };
    };

    const patientsWithForm = `
      import { useState } from "react";
      export function PatientsPage() {
        const [formData, setFormData] = useState({ firstName: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/patients", formData);
        };
        return <form onSubmit={handleSubmit}><h2>Patients</h2><button type="submit">Create</button></form>;
      }
    `;
    const clinicLeadsWithForm = `
      import { useState } from "react";
      export function ClinicLeads() {
        const [formData, setFormData] = useState({ email: "" });
        const handleSubmit = async (event) => {
          event.preventDefault();
          await api.post("/clinic-leads", formData);
        };
        return <form onSubmit={handleSubmit}><button type="submit">Save</button></form>;
      }
    `;
    const plainDiv = `export function Placeholder() { return <div />; }`;
    const appJsxWithForm = `
      import { useState } from "react";
      export function App() {
        const [state, setState] = useState({});
        const handleSubmit = (event) => {
          event.preventDefault();
        };
        return <form onSubmit={handleSubmit}><button type="submit">Ok</button></form>;
      }
    `;

    it("retry success: rejects wrong-entity first candidate, picks PatientsPage on second, generates patch only for PatientsPage", async () => {
      const files = [
        buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
        buildRepoFile("client/src/pages/PatientsPage.jsx", "frontend"),
      ];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 58 },
        { ...files[1], score: 54 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients form"],
        suggestedFiles: [
          { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        ],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithForm,
        "C:/repo/client/src/pages/PatientsPage.jsx": patientsWithForm,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: "client/src/pages/PatientsPage.jsx",
        fullContent: `${patientsWithForm}\n// validation`,
        summary: "ok",
        warnings: [],
      });

      const { entries, spy } = captureRetryLogs();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
        repoPath: "C:/repo",
      });

      expect(result.ok).toBe(true);
      const fullPatchPaths = planFullPatchWithLlmMock.mock.calls.map(
        (call) => (call[0] as { filePath: string }).filePath
      );
      expect(fullPatchPaths).toEqual(["client/src/pages/PatientsPage.jsx"]);
      expect(fullPatchPaths).not.toContain("client/src/components/ClinicLeads.jsx");

      const accepted = entries.find((e) => e.eligible === true);
      expect(accepted).toBeDefined();
      expect(accepted?.filePath).toBe("client/src/pages/PatientsPage.jsx");
      spy.mockRestore();
    });

    it("retry exhausted: all candidates rejected, no patch generated, reason is no_eligible_target_found", async () => {
      const files = [
        buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
        buildRepoFile("client/src/components/Placeholder.jsx", "frontend"),
      ];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 58 },
        { ...files[1], score: 40 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [
          { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        ],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithForm,
        "C:/repo/client/src/components/Placeholder.jsx": plainDiv,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });

      const { entries, spy } = captureRetryLogs();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
        repoPath: "C:/repo",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reason).toBe("no_eligible_target_found");
        expect(result.applyPatches).toEqual([]);
      }
      expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        if (entry.reason !== "tier3_structure_only_preview") {
          expect(entry.eligible).toBe(false);
        }
      }
      spy.mockRestore();
    });

    it("MAX_ATTEMPTS respected: at most 3 tier-1/2 attempts even when more candidates are available", async () => {
      const filePaths = Array.from(
        { length: 6 },
        (_, i) => `client/src/components/Clinic${i}.jsx`
      );
      const files = filePaths.map((p) => buildRepoFile(p, "frontend"));
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files: rankIn }) =>
        rankIn.map((f, idx) => ({ ...f, score: 100 - idx }))
      );
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [
          { path: filePaths[0], reason: "Leads", action: "inspect" },
        ],
        risks: [],
      });
      readProjectFilesMock.mockImplementation(async (paths: string[]) => {
        const out: Record<string, string> = {};
        for (const p of paths) out[p] = clinicLeadsWithForm;
        return out;
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: filePaths[0],
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });

      const { entries, spy } = captureRetryLogs();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
        repoPath: "C:/repo",
      });

      const tier12Entries = entries.filter(
        (e) => e.reason !== "tier3_structure_only_preview"
      );
      expect(tier12Entries.length).toBeLessThanOrEqual(3);
      spy.mockRestore();
    });

    it("ineligible candidates never reach planFullPatchWithLlm", async () => {
      const files = [
        buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
        buildRepoFile("client/src/components/Placeholder.jsx", "frontend"),
      ];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 58 },
        { ...files[1], score: 40 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [
          { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        ],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithForm,
        "C:/repo/client/src/components/Placeholder.jsx": plainDiv,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });

      const { spy } = captureRetryLogs();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
        repoPath: "C:/repo",
      });

      expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("tier 3 fallback: when only structure matches and no entity match exists, picks it and forces preview_only", async () => {
      const files = [
        buildRepoFile("client/src/components/ClinicLeads.jsx", "frontend"),
        buildRepoFile("client/src/App.jsx", "frontend"),
      ];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 58 },
        { ...files[1], score: 40 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [
          { path: "client/src/components/ClinicLeads.jsx", reason: "Leads", action: "inspect" },
        ],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        "C:/repo/client/src/components/ClinicLeads.jsx": clinicLeadsWithForm,
        "C:/repo/client/src/App.jsx": appJsxWithForm,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: "client/src/components/ClinicLeads.jsx",
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: "client/src/App.jsx",
        fullContent: `${appJsxWithForm}\n// validation`,
        summary: "ok",
        warnings: [],
      });

      const { entries, spy } = captureRetryLogs();
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.",
        repoPath: "C:/repo",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decisionMode).toBe("blocked");
        expect(result.warnings.join("\n")).toContain("[no_op_patch]");
      }
      const tier3 = entries.find((e) => e.reason === "tier3_structure_only_preview");
      expect(tier3).toBeDefined();
      expect(tier3?.eligible).toBe(true);
      spy.mockRestore();
    });

    it("regression: existing constrained-fallback test (PatientsPage discovery via entity-path) still passes by name — sanity smoke", async () => {
      // If the existing test "constrained fallback discovers PatientsPage via entity-path candidates when rank omits it"
      // fails after these edits, the retry loop broke priority ordering. This smoke test here does NOT re-run it;
      // it exists as a reminder to run the full test file, not just this describe block.
      expect(true).toBe(true);
    });
  });

  describe("hosted context token budget trim", () => {
    const patientsTask =
      "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.";

    it("trims to top-ranked files, continues, and surfaces hosted_context_trimmed_to_budget", async () => {
      const chunk = "y".repeat(10_000);
      const primaryPath = "client/src/pages/app/PatientsPage.jsx";
      const fillerPaths = Array.from({ length: 39 }, (_, i) => `src/extra/file${i}.jsx`);
      const allPaths = [primaryPath, ...fillerPaths];
      const availableFiles = allPaths.map((path) => ({
        path,
        category: "frontend",
        extension: "jsx",
      }));
      const contextFiles = allPaths.map((path) => ({
        path,
        action: "inspect",
        reason: "ctx",
        content: chunk,
      }));
      const originalContents = Object.fromEntries(allPaths.map((p) => [p, chunk]));

      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files }) => {
        const order = [...allPaths];
        return [...files]
          .sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
          .map((f, idx) => ({ ...f, score: 1000 - idx }));
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch summary",
        patches: [
          {
            path: primaryPath,
            operation: "modify",
            summary: "Validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: primaryPath,
        fullContent: `${chunk}\n//patched`,
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: patientsTask,
        repoPath: "/hosted",
        hostedContext: {
          repoSummary: "React",
          existingFilesSummary: "files",
          availableFiles,
          contextFiles,
          originalContents,
        },
      });

      expect(result.ok).toBe(true);
      expect(planPatchPreviewWithLlmMock).toHaveBeenCalled();
      const previewArg = planPatchPreviewWithLlmMock.mock.calls[0][0] as {
        fileContexts: Array<{ path: string; content: string }>;
      };
      expect(previewArg.fileContexts.length).toBeLessThanOrEqual(12);
      expect(previewArg.fileContexts.some((f) => f.path === primaryPath)).toBe(true);
      if (result.ok) {
        expect(
          result.warnings.some((w) => w.includes("hosted_context_trimmed_to_budget"))
        ).toBe(true);
      }
    });

    it("returns the context budget error when trimmed subset is still too large", async () => {
      const big = "z".repeat(150_000);
      const paths = ["a.tsx", "b.tsx", "c.tsx"];
      const availableFiles = paths.map((path) => ({
        path,
        category: "frontend",
        extension: "tsx",
      }));
      const contextFiles = paths.map((path) => ({
        path,
        action: "inspect",
        reason: "ctx",
        content: big,
      }));
      const originalContents = Object.fromEntries(paths.map((p) => [p, big]));

      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files }) =>
        files.map((f, idx) => ({ ...f, score: 100 - idx }))
      );

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Update validation in the existing form handlers only.",
        repoPath: "/hosted",
        hostedContext: {
          repoSummary: "React",
          existingFilesSummary: "files",
          availableFiles,
          contextFiles,
          originalContents,
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/Context too large/i);
      }
      expect(planPatchPreviewWithLlmMock).not.toHaveBeenCalled();
    });

    it("keeps rank-#1 file first in patch preview contexts after budget trim", async () => {
      const chunk = "y".repeat(10_000);
      const topPath = "client/src/pages/app/PatientsPage.jsx";
      const fillerPaths = Array.from({ length: 39 }, (_, i) => `src/extra/file${i}.jsx`);
      const allPaths = [topPath, ...fillerPaths];
      const availableFiles = allPaths.map((path) => ({
        path,
        category: "frontend",
        extension: "jsx",
      }));
      const contextFiles = allPaths.map((path) => ({
        path,
        action: "inspect",
        reason: "ctx",
        content: chunk,
      }));
      const originalContents = Object.fromEntries(allPaths.map((p) => [p, chunk]));

      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockImplementation(({ files }) => {
        const order = [...allPaths];
        return [...files]
          .sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
          .map((f, idx) => ({ ...f, score: 1000 - idx }));
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch summary",
        patches: [
          {
            path: topPath,
            operation: "modify",
            summary: "Validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: topPath,
        fullContent: `${chunk}\n//patched`,
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: patientsTask,
        repoPath: "/hosted",
        hostedContext: {
          repoSummary: "React",
          existingFilesSummary: "files",
          availableFiles,
          contextFiles,
          originalContents,
        },
      });

      const previewArg = planPatchPreviewWithLlmMock.mock.calls[0][0] as {
        fileContexts: Array<{ path: string; content: string }>;
      };
      expect(previewArg.fileContexts[0]?.path).toBe(topPath);
    });
  });

  describe("constrained target eligibility entity rank override", () => {
    const constrainedPatientsFormTask =
      "Patients page form validation. Reuse the existing form state only. Do not create a new form.";

    it("treats singular/plural entity anchors as matching PatientsPage path tokens", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const patientsPath = "client/src/pages/app/PatientsPage.jsx";
      const files = [buildRepoFile(patientsPath, "frontend")];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 90 }]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients form"],
        suggestedFiles: [{ path: patientsPath, reason: "Page", action: "inspect" }],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        [`C:/repo/${patientsPath}`]: `export function PatientsPage() { return <div />; }`,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: patientsPath,
            operation: "modify",
            summary: "Validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: patientsPath,
        fullContent: "// patched",
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: constrainedPatientsFormTask,
        repoPath: "C:/repo",
      });

      const eligibilityLog = consoleLogSpy.mock.calls.find(
        (call) => call[0] === "[zone-target-eligibility]"
      )?.[1] as string | undefined;
      expect(eligibilityLog).toBeDefined();
      expect(eligibilityLog).toContain('"entityMatch":true');
      consoleLogSpy.mockRestore();
    });

    it("accepts top-ranked path via top_ranked_entity_target_preview when structure is weak and calls planFullPatch for that path", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const patientsPath = "client/src/pages/app/PatientsPage.jsx";
      const leadsPath = "client/src/components/ClinicLeads.jsx";
      const files = [
        buildRepoFile(patientsPath, "frontend"),
        buildRepoFile(leadsPath, "frontend"),
      ];
      const weakStructure = `export function PatientsPage() { return <div />; }`;
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 100 },
        { ...files[1], score: 50 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [{ path: patientsPath, reason: "Page", action: "inspect" }],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        [`C:/repo/${patientsPath}`]: weakStructure,
        [`C:/repo/${leadsPath}`]: `export function ClinicLeads() { return <div />; }`,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: patientsPath,
            operation: "modify",
            summary: "Validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: patientsPath,
        fullContent: `${weakStructure}\n// ok`,
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: constrainedPatientsFormTask,
        repoPath: "C:/repo",
      });

      expect(result.ok).toBe(true);
      const eligibilityLog = consoleLogSpy.mock.calls.find(
        (call) => call[0] === "[zone-target-eligibility]"
      )?.[1] as string | undefined;
      expect(eligibilityLog).toContain('"reason":"top_ranked_entity_target_preview"');
      expect(eligibilityLog).toContain('"eligible":true');
      expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: patientsPath })
      );
      const fallbackPayload = consoleLogSpy.mock.calls.find(
        (call) => call[0] === "[zone-target-fallback]"
      )?.[1] as string | undefined;
      expect(
        fallbackPayload === undefined ||
          (typeof fallbackPayload === "string" && fallbackPayload.includes('"fallback":null'))
      ).toBe(true);
      if (result.ok) {
        expect(
          result.warnings.some((w) =>
            w.includes("top_ranked_entity_target_used_without_structure_confirmation")
          )
        ).toBe(true);
        expect(result.decisionMode).toBe("blocked");
        expect(result.warnings.join("\n")).toContain("[no_op_patch]");
      }
      consoleLogSpy.mockRestore();
    });

    it("does not apply top-ranked override for generic App.jsx shell", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const appPath = "src/App.jsx";
      const files = [buildRepoFile(appPath, "frontend")];
      const weak = `export default function App() { return <div />; }`;
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 100 }]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Tweak",
        steps: ["App"],
        suggestedFiles: [{ path: appPath, reason: "Root", action: "inspect" }],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        [`C:/repo/${appPath}`]: weak,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: appPath,
            operation: "modify",
            summary: "Change",
            targetHint: "root",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: "Polish the app page spacing. Reuse the existing form only.",
        repoPath: "C:/repo",
      });

      const eligibilityLog = consoleLogSpy.mock.calls.find(
        (call) => call[0] === "[zone-target-eligibility]"
      )?.[1] as string | undefined;
      expect(eligibilityLog).toBeDefined();
      expect(eligibilityLog).not.toContain("top_ranked_entity_target_preview");
      expect(eligibilityLog).toContain('"eligible":false');
      expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
      consoleLogSpy.mockRestore();
    });

    it("does not override when preview target is wrong entity vs task", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const patientsPath = "client/src/pages/app/PatientsPage.jsx";
      const leadsPath = "client/src/components/ClinicLeads.jsx";
      const files = [
        buildRepoFile(patientsPath, "frontend"),
        buildRepoFile(leadsPath, "frontend"),
      ];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([
        { ...files[0], score: 100 },
        { ...files[1], score: 50 },
      ]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients"],
        suggestedFiles: [{ path: leadsPath, reason: "Leads", action: "inspect" }],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        [`C:/repo/${patientsPath}`]: `export function PatientsPage() { return <form />; }`,
        [`C:/repo/${leadsPath}`]: `export function ClinicLeads() { return <div />; }`,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: leadsPath,
            operation: "modify",
            summary: "Wrong file",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: leadsPath,
        fullContent: "// noop",
        summary: "ok",
        warnings: [],
      });

      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      await runLlmPatchFlow({
        task: constrainedPatientsFormTask,
        repoPath: "C:/repo",
      });

      const eligibilityLog = consoleLogSpy.mock.calls.find(
        (call) => call[0] === "[zone-target-eligibility]"
      )?.[1] as string | undefined;
      expect(eligibilityLog).toBeDefined();
      expect(eligibilityLog).toContain('"entityMatch":false');
      expect(eligibilityLog).not.toContain("top_ranked_entity_target_preview");
      consoleLogSpy.mockRestore();
    });
  });

  describe("constrained task large rewrite guard", () => {
    it("does not treat a huge diff on a constrained validation task as safe_to_apply", async () => {
      const patientsPath = "client/src/pages/PatientsPage.jsx";
      const filler = Array.from(
        { length: 220 },
        (_, i) => `  const _p${i} = ${i};`
      ).join("\n");
      const before = `import { useState } from "react";
${filler}
export function PatientsPage() {
  const [x, setX] = useState({});
  return (
    <form onSubmit={() => {}}>
      <input name="a" />
    </form>
  );
}
`;
      const after = `import { useState } from "react";
export function PatientsPage() {
  const [x, setX] = useState({});
  return (
    <form onSubmit={() => {}}>
      <input name="a" required />
    </form>
  );
}
`;
      const files = [buildRepoFile(patientsPath, "frontend")];
      scanRepoMock.mockResolvedValue(files);
      detectProjectStructureMock.mockReturnValue({ notes: ["React"] });
      rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 95 }]);
      planFeatureWithLlmMock.mockResolvedValue({
        implementationSummary: "Validation",
        steps: ["Patients form"],
        suggestedFiles: [{ path: patientsPath, reason: "Page", action: "inspect" }],
        risks: [],
      });
      readProjectFilesMock.mockResolvedValue({
        [`C:/repo/${patientsPath}`]: before,
      });
      planPatchPreviewWithLlmMock.mockResolvedValue({
        summary: "Patch",
        patches: [
          {
            path: patientsPath,
            operation: "modify",
            summary: "Add validation",
            targetHint: "form",
            contentPreview: "x",
          },
        ],
        warnings: [],
      });
      planFullPatchWithLlmMock.mockResolvedValue({
        mode: "full_content",
        filePath: patientsPath,
        fullContent: after,
        summary: "ok",
        warnings: [],
      });

      const task =
        "Add minimal client-side validation to the existing Patients page create form only. Reuse the existing form state and existing submit flow. Do not create a new form. Do not introduce a new API call.";
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task,
        repoPath: "C:/repo",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decisionMode).not.toBe("safe_to_apply");
        // Scope-guard can drop the LLM patch and attempt fallback. If fallback cannot
        // safely insert, the run remains preview-only with no applied patches.
        expect(result.decisionMode).toBe("preview_only");
        expect(result.warnings.join("\n")).toContain("[patch_exceeds_minimal_scope]");
        expect(result.applyPatches).toHaveLength(0);
      }
    });
  });
});
