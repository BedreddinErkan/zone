import path from "node:path";
import type {
  AgentDecisionMode,
  ConfidenceLevel,
  FeatureAgentResult,
  SavedAgentResult,
  SavedDecisionMode,
  ScoredRisk,
  ValidationIssue
} from "../types/agent.js";
import { scoreTopRisks } from "./result/scoreTopRisks.js";
import { ensureDir, writeTextFile } from "../utils/files.js";
import {
  normalizePatchRiskWarnings,
  normalizeArchitectureWarnings
} from "./normalizeIssues.js";

function mapDecisionMode(mode: AgentDecisionMode): SavedDecisionMode {
  if (mode === "safe_to_apply") return "apply";
  if (mode === "blocked") return "blocked";
  return "preview";
}

function mapConfidence(score: number): ConfidenceLevel {
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "low";
}

function severityWeight(severity: "info" | "warning" | "error"): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function sortIssues(input: ValidationIssue[]): ValidationIssue[] {
  return [...input].sort((a, b) => {
    const severityDiff = severityWeight(b.severity) - severityWeight(a.severity);
    if (severityDiff !== 0) return severityDiff;

    const fileA = a.file ?? "";
    const fileB = b.file ?? "";
    if (fileA !== fileB) return fileA.localeCompare(fileB);

    return a.code.localeCompare(b.code);
  });
}

function countIssues(issues: ValidationIssue[]): {
  total: number;
  errors: number;
  warnings: number;
} {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return {
    total: issues.length,
    errors,
    warnings
  };
}

function buildIssueGroups(result: FeatureAgentResult) {
  const patch = sortIssues(result.patchValidationIssues);
  const schema = sortIssues(result.schemaPatchWarnings);

  return [
    {
      key: "patch",
      label: "Patch validation",
      ...countIssues(patch),
      issues: patch
    },
    {
      key: "schema",
      label: "Schema validation",
      ...countIssues(schema),
      issues: schema
    },
    {
      key: "risk",
      label: "Patch risk warnings",
      total: result.patchRiskWarnings.length,
      errors: 0,
      warnings: result.patchRiskWarnings.length,
      issues: normalizePatchRiskWarnings(result.patchRiskWarnings)
    },
    {
      key: "architecture",
      label: "Architecture warnings",
      total: result.architectureWarnings.length,
      errors: 0,
      warnings: result.architectureWarnings.length,
      issues: normalizeArchitectureWarnings(result.architectureWarnings)
    }
  ].filter((group) => group.total > 0);
}

export function buildTopRisks(result: FeatureAgentResult): ScoredRisk[] {
  const allIssues: ValidationIssue[] = [
    ...result.patchValidationIssues,
    ...result.schemaPatchWarnings,
    ...normalizePatchRiskWarnings(result.patchRiskWarnings),
    ...normalizeArchitectureWarnings(result.architectureWarnings)
  ];

  return scoreTopRisks({
    issues: allIssues,
    decisionMode: result.decision.mode,
    limit: 5
  });
}

function buildRecommendation(result: FeatureAgentResult): string {
  const hasPatchError = result.patchValidationIssues.some(
    (issue) => issue.severity === "error"
  );
  const hasSchemaError = result.schemaPatchWarnings.some(
    (issue) => issue.severity === "error"
  );
  const hasWarnings =
    result.patchValidationIssues.some((issue) => issue.severity === "warning") ||
    result.schemaPatchWarnings.some((issue) => issue.severity === "warning") ||
    result.patchRiskWarnings.length > 0 ||
    result.architectureWarnings.length > 0;

  if (result.decision.mode === "blocked") {
    if (hasPatchError || hasSchemaError) {
      return "Apply yapma. Önce blocking validation hatalarını çöz ve agenti tekrar çalıştır.";
    }

    return "Apply yapma. Karar nedenlerini ve tüm riskleri inceleyip yeniden dene.";
  }

  if (result.decision.mode === "preview_only") {
    if (hasWarnings) {
      return "Preview çıktısını manuel incele. Warning ve risk sinyalleri temizlenmeden otomatik apply önerilmez.";
    }

    if (result.confidence.finalScore < 70) {
      return "Confidence düşük. Dry-run veya manuel inceleme sonrası ilerle.";
    }

    return "Manuel inceleme önerilir. Patch preview üzerinden doğrulama yap.";
  }

  return "Sonuç temiz görünüyor. Apply öncesi top riskleri ve patch hedeflerini hızlıca kontrol et.";
}

function toSavedAgentResult(result: FeatureAgentResult): SavedAgentResult {
  const groupedIssues = buildIssueGroups(result);
  const topRisks = buildTopRisks(result);

  const totalIssues =
    topRisks.length === 0
      ? countIssues([...result.patchValidationIssues, ...result.schemaPatchWarnings])
      : countIssues([
          ...result.patchValidationIssues,
          ...result.schemaPatchWarnings,
          ...normalizePatchRiskWarnings(result.patchRiskWarnings),
          ...normalizeArchitectureWarnings(result.architectureWarnings)
        ]);

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    summary: result.summary,
    statusLine: buildStatusLine(result),

    meta: {
      task: result.task,
      targetPath: result.targetPath,
      relevantFileCount: result.relevantFiles.length,
      suggestedFileCount: result.validatedSuggestedFiles.length,
      patchCount: result.patchPlan.patches.length
    },

    intent: {
      rawTask: result.task,
      operation: result.intent.action ?? "unknown",
      target: result.intent.parentResource ?? "unknown",
      scope: result.intent.scope,
      nestedTarget: result.intent.nestedResource ?? null,
      confidence: mapConfidence(result.confidence.intentClarity),
      warnings: result.intent.warnings
    },

    schema: {
      summary: result.schemaAwareSummary.summary,
      entities: result.schemaAwareSummary.entities,
      relations: result.schemaAwareSummary.relations,
      confidence: result.schemaAwareSummary.confidence
    },

    storage: {
      primaryStorage: result.storageInsight.primaryStorage,
      detectedClients: result.storageInsight.detectedClients,
      confidence: result.storageInsight.confidence,
      reasoning: result.storageInsight.reasoning,
      resourceStorageKind: result.storageInsight.resourceStorageKind ?? "unknown"
    },

    validation: {
      patch: result.patchValidationIssues,
      schema: result.schemaPatchWarnings
    },

    issues: {
      summary: totalIssues,
      grouped: groupedIssues,
      topRisks
    },

    decision: {
      mode: mapDecisionMode(result.decision.mode),
      confidence: result.decision.confidenceScore,
      reason: result.decision.reason,
      recommendation: buildRecommendation(result)
    },

    confidenceBreakdown: {
      finalScore: result.confidence.finalScore,
      level: mapConfidence(result.confidence.finalScore),
      factors: {
        intentClarity: result.confidence.intentClarity,
        schemaCertainty: result.confidence.schemaCertainty,
        storageCertainty: result.confidence.storageCertainty,
        patchValidationHealth: result.confidence.patchValidationHealth
      }
    },

    confidenceDetails: {
      baseWeightedScore: result.confidenceDetails.baseWeightedScore,
      totalPenalty: result.confidenceDetails.totalPenalty,
      penalties: result.confidenceDetails.penalties
    },

    notes: {
      execution: result.executionNotes.notes,
      assumptions: result.executionNotes.assumptions,
      followUps: result.executionNotes.followUps
    },

    debug: {
      patchTargets: result.patchPlan.patches.map((patch) => ({
        path: patch.path,
        operation: patch.operation
      })),
      suggestedFiles: result.validatedSuggestedFiles.map((file) => ({
        originalPath: file.originalPath,
        resolvedPath: file.resolvedPath ?? null,
        status: file.status,
        action: file.action
      }))
    }
  };
}

export async function saveAgentResult(
  result: FeatureAgentResult
): Promise<string> {
  const cacheDir = path.join(result.targetPath, ".agent-cache");
  await ensureDir(cacheDir);

  const outputPath = path.join(cacheDir, "last-result.json");
  const saved = toSavedAgentResult(result);

  await writeTextFile(outputPath, JSON.stringify(saved, null, 2));

  return outputPath;
}

function buildStatusLine(result: FeatureAgentResult): string {
  const warningCount =
    result.patchValidationIssues.length +
    result.schemaPatchWarnings.length +
    result.patchRiskWarnings.length +
    result.architectureWarnings.length;

  return `STATUS: ${result.decision.mode} | confidence=${result.confidence.finalScore} | warnings=${warningCount} | penalties=${result.confidenceDetails.penalties.length} | patches=${result.patchPlan.patches.length} | relevant=${result.relevantFiles.length} | suggested=${result.validatedSuggestedFiles.length}`;
}