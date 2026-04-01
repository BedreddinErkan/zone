import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedAgentResult } from "../types/agent.js";
import path from "node:path";

const mockLog = vi.fn();
const mockError = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock("node:fs", () => {
  return {
    promises: {
      writeFile: mockWriteFile,
      mkdir: mockMkdir
    }
  };
});

const runFeatureAgentMock = vi.fn();
vi.mock("../core/runFeatureAgent.js", () => ({
  runFeatureAgent: runFeatureAgentMock
}));

const loadSavedAgentResultMock = vi.fn();
vi.mock("../core/loadSavedAgentResult.js", () => ({
  loadSavedAgentResult: loadSavedAgentResultMock
}));

const evaluateCiResultMock = vi.fn();
vi.mock("../ci/evaluateCiResult.js", () => ({
  evaluateCiResult: evaluateCiResultMock
}));

const buildCliViewModelMock = vi.fn();
vi.mock("../core/result/buildCliViewModel.js", () => ({
  buildCliViewModel: buildCliViewModelMock
}));

const renderCliResultMock = vi.fn();
vi.mock("../core/result/renderCliResult.js", () => ({
  renderCliResult: renderCliResultMock
}));

describe("runCliWithOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);

    vi.stubGlobal("console", {
      log: mockLog,
      error: mockError
    });
  });

  it("standard modda saved result summary basar ve 0 döner", async () => {
    const savedResult: SavedAgentResult = {
      version: 2,
      generatedAt: "2026-04-01T12:00:00.000Z",
      summary: "Example summary",
      statusLine: "STATUS: PREVIEW",
      meta: {
        task: "add treatment endpoint",
        targetPath: "/repo",
        relevantFileCount: 3,
        suggestedFileCount: 2,
        patchCount: 1
      },
      intent: {
        rawTask: "add treatment endpoint",
        operation: "update",
        target: "treatment",
        scope: "single",
        nestedTarget: null,
        confidence: "medium",
        warnings: []
      },
      schema: {
        summary: "Schema summary",
        entities: ["treatments"],
        relations: [],
        confidence: "medium"
      },
      storage: {
        primaryStorage: "postgres",
        detectedClients: [],
        confidence: "medium",
        reasoning: ["Detected postgres"],
        resourceStorageKind: "separate_table"
      },
      validation: {
        patch: [],
        schema: []
      },
      issues: {
        summary: {
          total: 2,
          errors: 0,
          warnings: 2
        },
        grouped: [],
        topRisks: []
      },
      decision: {
        mode: "preview",
        confidence: 66,
        reason: "Warnings require review.",
        recommendation: "Preview çıktısını incele."
      },
      confidenceBreakdown: {
        finalScore: 66,
        level: "medium",
        factors: {
          intentClarity: 80,
          schemaCertainty: 58,
          storageCertainty: 55,
          patchValidationHealth: 72
        }
      },
      confidenceDetails: {
        baseWeightedScore: 74,
        totalPenalty: 8,
        penalties: [
          {
            code: "PATCH_WARNINGS",
            label: "Patch validation warnings",
            appliedPenalty: 8
          }
        ]
      },
      notes: {
        execution: [],
        assumptions: [],
        followUps: []
      },
      debug: {
        patchTargets: [],
        suggestedFiles: []
      }
    };

    const cliViewModel = {
      decisionMode: "preview",
      decisionLabel: "PREVIEW ONLY",
      statusLine: "STATUS: PREVIEW",
      confidenceScore: 66,
      errorCount: 0,
      warningCount: 2,
      notes: [],
      topRisks: [],
      groupedIssues: [],
      rawResult: savedResult
    };

    runFeatureAgentMock.mockResolvedValue({});
    loadSavedAgentResultMock.mockResolvedValue(savedResult);
    buildCliViewModelMock.mockReturnValue(cliViewModel);
    renderCliResultMock.mockReturnValue("=== AGENT DECISION ===");

    const { runCliWithOptions } = await import("./index.js");
    const repoPath = path.resolve("/repo");

    const exitCode = await runCliWithOptions({
      task: "add treatment endpoint",
      repo: repoPath,
      mode: "preview"
    });

    expect(exitCode).toBe(0);
    expect(runFeatureAgentMock).toHaveBeenCalledTimes(1);
    expect(loadSavedAgentResultMock).toHaveBeenCalledWith(repoPath);
    expect(buildCliViewModelMock).toHaveBeenCalledWith(savedResult);
    expect(renderCliResultMock).toHaveBeenCalledWith(cliViewModel, "summary");
    expect(mockLog).toHaveBeenCalledWith("=== AGENT DECISION ===");
  });

  it("ci modunda blocked sonucu fail eder ve 1 döner", async () => {
    const savedResult: SavedAgentResult = {
      version: 2,
      generatedAt: "2026-04-01T12:00:00.000Z",
      summary: "Blocked run",
      statusLine: "STATUS: BLOCKED",
      meta: {
        task: "dangerous patch",
        targetPath: "/repo",
        relevantFileCount: 1,
        suggestedFileCount: 1,
        patchCount: 1
      },
      intent: {
        rawTask: "dangerous patch",
        operation: "update",
        target: "billing",
        scope: "single",
        nestedTarget: null,
        confidence: "low",
        warnings: ["Ambiguous target"]
      },
      schema: {
        summary: "Schema uncertain",
        entities: [],
        relations: [],
        confidence: "low"
      },
      storage: {
        primaryStorage: "unknown",
        detectedClients: [],
        confidence: "low",
        reasoning: ["Low confidence"],
        resourceStorageKind: "unknown"
      },
      validation: {
        patch: [],
        schema: []
      },
      issues: {
        summary: {
          total: 1,
          errors: 1,
          warnings: 0
        },
        grouped: [],
        topRisks: [
        {
  id: "issue:runtime_failure",
  title: "Runtime failure",
  description: "boom",
  severity: "high",
  score: 100,
  category: "validation",
  source: "derived",
  relatedCode: "RUNTIME_FAILURE"
}
        ]
      },
      decision: {
        mode: "blocked",
        confidence: 0,
        reason: "Blocking issue",
        recommendation: "Do not apply."
      },
      confidenceBreakdown: {
        finalScore: 0,
        level: "low",
        factors: {
          intentClarity: 0,
          schemaCertainty: 0,
          storageCertainty: 0,
          patchValidationHealth: 0
        }
      },
      confidenceDetails: {
        baseWeightedScore: 0,
        totalPenalty: 100,
        penalties: [
          {
            code: "RUNTIME_FAILURE",
            label: "Runtime failure",
            appliedPenalty: 100
          }
        ]
      },
      notes: {
        execution: [],
        assumptions: [],
        followUps: []
      },
      debug: {
        patchTargets: [],
        suggestedFiles: []
      }
    };

    const cliViewModel = {
      decisionMode: "blocked",
      decisionLabel: "BLOCKED",
      statusLine: "STATUS: BLOCKED",
      confidenceScore: 0,
      errorCount: 1,
      warningCount: 0,
      notes: [],
      topRisks: ["RUNTIME_FAILURE: Blocking issue"],
      groupedIssues: [],
      rawResult: savedResult
    };

    runFeatureAgentMock.mockResolvedValue({});
    loadSavedAgentResultMock.mockResolvedValue(savedResult);
    buildCliViewModelMock.mockReturnValue(cliViewModel);
    renderCliResultMock.mockReturnValue("=== AGENT DECISION ===");
    evaluateCiResultMock.mockReturnValue({
      outcome: "fail",
      exitCode: 1,
      shouldFail: true,
      title: "CI evaluation failed",
      summary: "decision=blocked ; confidence=0 ; errors=1",
      annotations: ["Runtime failure"],
      statusLine: "STATUS: BLOCKED",
      summaryLine: "decision=blocked ; confidence=0 ; errors=1"
    });

    const { runCliWithOptions } = await import("./index.js");
    const repoPath = path.resolve("/repo");

    const exitCode = await runCliWithOptions({
      task: "dangerous patch",
      repo: repoPath,
      mode: "preview",
      ci: true
    });

    expect(exitCode).toBe(1);
    expect(runFeatureAgentMock).toHaveBeenCalledTimes(1);
    expect(loadSavedAgentResultMock).toHaveBeenCalledWith(repoPath);
    expect(buildCliViewModelMock).toHaveBeenCalledWith(savedResult);
    expect(renderCliResultMock).toHaveBeenCalledWith(cliViewModel, "summary");
    expect(evaluateCiResultMock).toHaveBeenCalledWith(savedResult);
    expect(mockLog).toHaveBeenCalledWith("STATUS: BLOCKED");
    expect(mockLog).toHaveBeenCalledWith("decision=blocked ; confidence=0 ; errors=1");
  });
});