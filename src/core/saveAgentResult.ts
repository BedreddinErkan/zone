import path from "node:path";
import type {
  AgentDecisionMode,
  ConfidenceLevel,
  FeatureAgentResult,
  SavedAgentResult,
  SavedDecisionMode
} from "../types/agent.js";
import { ensureDir, writeTextFile } from "../utils/files.js";

/**
 * Map internal decision mode -> saved mode
 */
function mapDecisionMode(mode: AgentDecisionMode): SavedDecisionMode {
  if (mode === "safe_to_apply") return "apply";
  if (mode === "blocked") return "blocked";
  return "preview";
}

/**
 * Convert numeric score to confidence level
 */
function mapConfidence(score: number): ConfidenceLevel {
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "low";
}

/**
 * Convert FeatureAgentResult -> SavedAgentResult
 */
function toSavedAgentResult(result: FeatureAgentResult): SavedAgentResult {
  return {
    summary: result.summary,

    intent: {
      rawTask: result.task,
      operation: result.intent.action ?? "unknown",
      target: result.intent.parentResource ?? "unknown",
      scope: result.intent.scope,
      nestedTarget: result.intent.nestedResource ?? null,
      confidence: mapConfidence(result.confidence.intentClarity)
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
      reasoning: result.storageInsight.reasoning
    },

    validation: {
      patch: result.patchValidationIssues,
      schema: result.schemaPatchWarnings
    },

    decision: {
      mode: mapDecisionMode(result.decision.mode),
      confidence: result.decision.confidenceScore,
      reason: result.decision.reason
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

    // ✅ YENİ
    statusLine: buildStatusLine(result)
  };
}
/**
 * Save agent result as structured engineering report
 */
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