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

const runAgentMock = vi.fn();
vi.mock("../core/runAgent.js", () => ({
  runAgent: runAgentMock
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

const formatOutputMock = vi.fn();
vi.mock("../core/formatOutput.js", () => ({
  formatOutput: formatOutputMock
}));

const loadPatchPlanMock = vi.fn();
vi.mock("./loadPatchPlan.js", () => ({
  loadPatchPlan: loadPatchPlanMock
}));

const runApplyFlowMock = vi.fn();
vi.mock("../apply/runApplyFlow.js", () => ({
  runApplyFlow: runApplyFlowMock
}));

const renderApplyResultMock = vi.fn();
vi.mock("../apply/renderApplyResult.js", () => ({
  renderApplyResult: renderApplyResultMock
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
    const savedResult = {
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
    } as SavedAgentResult;

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
    expect(runFeatureAgentMock).toHaveBeenCalledWith({
      task: "add treatment endpoint",
      targetPath: repoPath,
      mode: "preview",
      changedFiles: []
    });
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(loadSavedAgentResultMock).toHaveBeenCalledWith(repoPath);
    expect(buildCliViewModelMock).toHaveBeenCalledWith(savedResult);
    expect(renderCliResultMock).toHaveBeenCalledWith(cliViewModel, "summary");
    expect(mockLog).toHaveBeenCalledWith("Flow: legacy");
    expect(mockLog).toHaveBeenCalledWith("=== AGENT DECISION ===");
  });

  it("ci modunda blocked sonucu fail eder ve 1 döner", async () => {
    const savedResult = {
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
    } as SavedAgentResult;

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
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(loadSavedAgentResultMock).toHaveBeenCalledWith(repoPath);
    expect(buildCliViewModelMock).toHaveBeenCalledWith(savedResult);
    expect(renderCliResultMock).toHaveBeenCalledWith(cliViewModel, "summary");
    expect(evaluateCiResultMock).toHaveBeenCalledWith(savedResult);
    expect(mockLog).toHaveBeenCalledWith("Flow: legacy");
    expect(mockLog).toHaveBeenCalledWith("STATUS: BLOCKED");
    expect(mockLog).toHaveBeenCalledWith("decision=blocked ; confidence=0 ; errors=1");
  });

  it("taskOnly false iken legacy flow korunur", async () => {
    const savedResult = {
      version: 2,
      generatedAt: "2026-04-01T12:00:00.000Z",
      summary: "Legacy flow preserved",
      statusLine: "STATUS: PREVIEW",
      meta: {
        task: "rename helper",
        targetPath: "/repo",
        relevantFileCount: 1,
        suggestedFileCount: 1,
        patchCount: 1
      },
      intent: {
        rawTask: "rename helper",
        operation: "update",
        target: "helper",
        scope: "single",
        nestedTarget: null,
        confidence: "high",
        warnings: []
      },
      schema: {
        summary: "Schema clear",
        entities: [],
        relations: [],
        confidence: "high"
      },
      storage: {
        primaryStorage: "none",
        detectedClients: [],
        confidence: "high",
        reasoning: [],
        resourceStorageKind: "unknown"
      },
      validation: {
        patch: [],
        schema: []
      },
      issues: {
        summary: {
          total: 0,
          errors: 0,
          warnings: 0
        },
        grouped: [],
        topRisks: []
      },
      decision: {
        mode: "preview",
        confidence: 91,
        reason: "Low-risk change",
        recommendation: "Apply"
      },
      confidenceBreakdown: {
        finalScore: 91,
        level: "high",
        factors: {
          intentClarity: 90,
          schemaCertainty: 92,
          storageCertainty: 90,
          patchValidationHealth: 92
        }
      },
      confidenceDetails: {
        baseWeightedScore: 91,
        totalPenalty: 0,
        penalties: []
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
    } as SavedAgentResult;

    const cliViewModel = {
      decisionMode: "preview",
      decisionLabel: "PREVIEW ONLY",
      statusLine: "STATUS: PREVIEW",
      confidenceScore: 91,
      errorCount: 0,
      warningCount: 0,
      notes: [],
      topRisks: [],
      groupedIssues: [],
      rawResult: savedResult
    };

    runFeatureAgentMock.mockResolvedValue({});
    loadSavedAgentResultMock.mockResolvedValue(savedResult);
    buildCliViewModelMock.mockReturnValue(cliViewModel);
    renderCliResultMock.mockReturnValue("=== LEGACY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");
    const repoPath = path.resolve("/repo");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      repo: repoPath,
      taskOnly: false
    });

    expect(exitCode).toBe(0);
    expect(runFeatureAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith("Flow: legacy");
    expect(mockLog).toHaveBeenCalledWith("=== LEGACY RESULT ===");
  });

  it("task-only modda runAgent hata verirse 1 döner", async () => {
    runAgentMock.mockRejectedValue(new Error("heuristic failed"));

    const { runCliWithOptions } = await import("./index.js");
    const repoPath = path.resolve("/repo");

    const exitCode = await runCliWithOptions({
      task: "dangerous patch",
      repo: repoPath,
      taskOnly: true
    });

    expect(exitCode).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runFeatureAgentMock).not.toHaveBeenCalled();
    expect(formatOutputMock).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith("Task-only flow failed: heuristic failed");
  });

  it("task-only modda --format json geçince JSON output basar", async () => {
    const runAgentResult = {
      task: "drop users table",
      decision: { mode: "blocked", confidenceScore: 25 },
      risk: {
        score: 75,
        breakdown: {
          destructive: 50,
          schema: 25,
          critical: 0,
          lowRisk: 0,
          massScope: 0
        }
      },
      confidence: {
        score: 25,
        breakdown: {
          base: 100,
          destructivePenalty: -50,
          schemaPenalty: -25,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 0
        }
      },
      explanation: "BLOCKED: Risk score 75/100",
      recommendation: "Do not auto-apply.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue('{"task":"drop users table","decision":{"mode":"blocked"}}');

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "drop users table",
      taskOnly: true,
      format: "json"
    });

    expect(exitCode).toBe(0);
    expect(formatOutputMock).toHaveBeenCalledWith(
      runAgentResult,
      "json",
      { showTrace: false, verbose: false }
    );
const printedOutput = mockLog.mock.calls
  .flat()
  .filter((value) => typeof value === "string")
  .join("\n");

expect(printedOutput).toContain('{"task":"drop users table","decision":{"mode":"blocked"}}');
expect(printedOutput).toContain("=== GENERATED PATCH PLAN ===");
expect(printedOutput).toContain("Allowed: no");
expect(printedOutput).toContain("Strategy: blocked");  });

  it("task-only modda geçersiz --format değeri 1 döner ve hata basar", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY: Risk score 5/100",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true,
      format: "xml"
    });

    expect(exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --format")
    );
  });

  it("task-only modda --format belirtilmezse text (default) kullanılır", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY: Risk score 5/100",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== ZONE TEXT OUTPUT ===");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true
    });

    expect(exitCode).toBe(0);
    expect(formatOutputMock).toHaveBeenCalledTimes(1);
    expect(formatOutputMock).toHaveBeenCalledWith(
      runAgentResult,
      "text",
      { showTrace: false, verbose: false }
    );
const printedOutput = mockLog.mock.calls
  .flat()
  .filter((value) => typeof value === "string")
  .join("\n");

expect(printedOutput).toContain("=== ZONE TEXT OUTPUT ===");
expect(printedOutput).toContain("=== GENERATED PATCH PLAN ===");
expect(printedOutput).toContain("Allowed: yes");
expect(printedOutput).toContain("Strategy: safe");
expect(printedOutput).toContain("Intent: rename_symbol");  });

  it("task-only modda verbose açıkken execution bilgisini basar", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 91
      },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "Small localized change.",
      recommendation: "Safe to proceed.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");
    const repoPath = path.resolve("/repo");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      repo: repoPath,
      taskOnly: true,
      verbose: true
    });

    expect(exitCode).toBe(0);

    expect(mockLog).toHaveBeenCalledWith("\n[verbose] cli.options");
    expect(mockLog).toHaveBeenCalledWith("\n[verbose] repoPath");
    expect(mockLog).toHaveBeenCalledWith("\n[verbose] resultPath");
    expect(mockLog).toHaveBeenCalledWith("\n[verbose] runAgent.result");
    expect(mockLog).toHaveBeenCalledWith("\n[verbose] execution");
  });

  it("passes --trace flag to formatOutput", async () => {
    const runAgentResult = {
      task: "delete all users",
      decision: { mode: "blocked", confidenceScore: 25 },
      risk: {
        score: 75,
        breakdown: {
          destructive: 50,
          schema: 25,
          critical: 0,
          lowRisk: 0,
          massScope: 0
        }
      },
      confidence: {
        score: 25,
        breakdown: {
          base: 100,
          destructivePenalty: -50,
          schemaPenalty: -25,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 0
        }
      },
      explanation: "BLOCKED",
      recommendation: "Do not auto-apply.",
      topRisks: [],
      reasonCodes: [],
      trace: {
        decisionPath: ["Detected destructive signal"],
        decisionFactors: {
          riskThreshold: 71,
          triggeredBy: ["riskScore"]
        },
        confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25"
      }
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("TRACE OUTPUT");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "delete all users",
      taskOnly: true,
      trace: true,
      format: "text"
    });

    expect(exitCode).toBe(0);
    expect(formatOutputMock).toHaveBeenCalledWith(
      runAgentResult,
      "text",
      { showTrace: true, verbose: false }
    );
  });

  it("passes --verbose flag to formatOutput", async () => {
    const runAgentResult = {
      task: "delete all users",
      decision: { mode: "blocked", confidenceScore: 25 },
      risk: {
        score: 75,
        breakdown: {
          destructive: 50,
          schema: 25,
          critical: 0,
          lowRisk: 0,
          massScope: 0
        }
      },
      confidence: {
        score: 25,
        breakdown: {
          base: 100,
          destructivePenalty: -50,
          schemaPenalty: -25,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 0
        }
      },
      explanation: "BLOCKED",
      recommendation: "Do not auto-apply.",
      topRisks: [],
      reasonCodes: [],
      trace: {
        decisionPath: ["Detected destructive signal"],
        decisionFactors: {
          riskThreshold: 71,
          triggeredBy: ["riskScore"]
        },
        confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25"
      }
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("VERBOSE OUTPUT");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "delete all users",
      taskOnly: true,
      verbose: true,
      format: "text"
    });

    expect(exitCode).toBe(0);
    expect(formatOutputMock).toHaveBeenCalledWith(
      runAgentResult,
      "text",
      { showTrace: true, verbose: true }
    );
  });

  it("task-only modda --apply yoksa runApplyFlow çağrılmaz", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true
    });

    expect(exitCode).toBe(0);
    expect(runApplyFlowMock).not.toHaveBeenCalled();
    expect(loadPatchPlanMock).not.toHaveBeenCalled();
    expect(renderApplyResultMock).not.toHaveBeenCalled();
  });

  it("task-only modda --apply var ama --confirm-apply yoksa apply skip edilir", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true,
      apply: true
    });

    expect(exitCode).toBe(0);
    expect(runApplyFlowMock).not.toHaveBeenCalled();
    expect(loadPatchPlanMock).not.toHaveBeenCalled();
    expect(renderApplyResultMock).not.toHaveBeenCalled();

    expect(mockLog).toHaveBeenCalledWith("=== APPLY RESULT ===");
    expect(mockLog).toHaveBeenCalledWith(
      "Status: skipped\nReason: Apply requested but not confirmed. Re-run with --confirm-apply."
    );
  });

  it("task-only modda apply confirm edilmiş ama patch plan yoksa 1 döner", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: []
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true,
      apply: true,
      confirmApply: true
    });

    expect(exitCode).toBe(1);
    expect(loadPatchPlanMock).not.toHaveBeenCalled();
    expect(runApplyFlowMock).not.toHaveBeenCalled();

    expect(mockError).toHaveBeenCalledWith(
      "Task-only flow failed: Apply requested but no patch plan was provided. Use --patch-plan <file>."
    );
  });

  it("task-only modda apply confirm edilince patch plan yükler ve apply flow çalıştırır", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "safe_to_apply", confidenceScore: 90 },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
    };

    const patchPlan = {
      patches: [
        {
          filePath: "src/helpers.ts",
          nextContent: "export const newHelper = () => {};"
        }
      ]
    };

    const applyResult = {
      applied: true,
      filesChanged: ["src/helpers.ts"],
      summary: "Patch plan applied successfully."
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");
    loadPatchPlanMock.mockReturnValue(patchPlan);
    runApplyFlowMock.mockResolvedValue(applyResult);
    renderApplyResultMock.mockReturnValue(
      "Status: applied\nSummary: Patch plan applied successfully."
    );

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true,
      apply: true,
      confirmApply: true,
      patchPlan: "./patch-plan.json"
    });

    expect(exitCode).toBe(0);
    expect(loadPatchPlanMock).toHaveBeenCalledTimes(1);
    expect(runApplyFlowMock).toHaveBeenCalledTimes(1);
    expect(runApplyFlowMock).toHaveBeenCalledWith({
      result: runAgentResult,
      plan: patchPlan,
      request: {
        confirm: true
      }
    });
    expect(renderApplyResultMock).toHaveBeenCalledWith(applyResult);

    expect(mockLog).toHaveBeenCalledWith("=== APPLY RESULT ===");
    expect(mockLog).toHaveBeenCalledWith(
      "Status: applied\nSummary: Patch plan applied successfully."
    );
  });

  it("task-only modda apply sonucu applied değilse 1 döner", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: { mode: "preview_only", confidenceScore: 65 },
      risk: {
        score: 35,
        breakdown: {
          destructive: 0,
          schema: 10,
          critical: 0,
          lowRisk: 0,
          massScope: 0
        }
      },
      confidence: {
        score: 65,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: -10,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 0
        }
      },
      explanation: "PREVIEW ONLY",
      recommendation: "Review before apply.",
      topRisks: [],
      reasonCodes: ["PREVIEW_SCHEMA_UNCERTAINTY"]
    };

    const patchPlan = {
      patches: [
        {
          filePath: "src/helpers.ts",
          nextContent: "export const helper = () => {};"
        }
      ]
    };

    const applyResult = {
      applied: false,
      filesChanged: [],
      summary: "Decision is not eligible for apply."
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");
    loadPatchPlanMock.mockReturnValue(patchPlan);
    runApplyFlowMock.mockResolvedValue(applyResult);
    renderApplyResultMock.mockReturnValue(
      "Status: rejected\nSummary: Decision is not eligible for apply."
    );

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true,
      apply: true,
      confirmApply: true,
      patchPlan: "./patch-plan.json"
    });

    expect(exitCode).toBe(1);
    expect(renderApplyResultMock).toHaveBeenCalledWith(applyResult);
  });
  it("renders generated patch plan preview after the decision output", async () => {
    const runAgentResult = {
      task: "rename helper",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 90
      },
      risk: {
        score: 5,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: -10,
          massScope: 0
        }
      },
      confidence: {
        score: 100,
        breakdown: {
          base: 100,
          destructivePenalty: 0,
          schemaPenalty: 0,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 10
        }
      },
      explanation: "SAFE TO APPLY",
      recommendation: "Apply safely.",
      topRisks: [],
      reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
    };

    runAgentMock.mockResolvedValue(runAgentResult);
    formatOutputMock.mockReturnValue("=== TASK ONLY RESULT ===");

    const { runCliWithOptions } = await import("./index.js");

    const exitCode = await runCliWithOptions({
      task: "rename helper",
      taskOnly: true
    });

    expect(exitCode).toBe(0);

    const printedOutput = mockLog.mock.calls
      .flat()
      .filter((value) => typeof value === "string")
      .join("\n");

    expect(printedOutput).toContain("=== TASK ONLY RESULT ===");
    expect(printedOutput).toContain("=== GENERATED PATCH PLAN ===");
    expect(printedOutput).toContain("Allowed: yes");
    expect(printedOutput).toContain("Strategy: safe");
    expect(printedOutput).toContain("Intent: rename_symbol");
    expect(printedOutput).toContain("Operations:");
    expect(printedOutput).toContain("Reason:");
    expect(printedOutput).toContain("Derived From:");
    expect(printedOutput).toContain("- SAFE_LOW_RISK");
    expect(printedOutput).toContain("- SAFE_HIGH_CONFIDENCE");
  });
});
