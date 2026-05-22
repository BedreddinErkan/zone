import { log } from "../utils/logger.js";
import { writeCacheLog } from "../utils/commandCacheLog.js";
import {
  buildApplyRolledBackMarkerLog,
  type RolledBackError,
} from "./applyRollbackFeedback.js";
import type { TaskArchetype } from "./taskClassifier.js";
import type { IterCostUpdatePayload } from "../usage/iterCostMeter.js";

// ---------------------------------------------------------------------------
// emitArchetype — [zone-archetype]
// Emitted once per run at close (in runAgentLoop wrapper, not the for-loop).
// ---------------------------------------------------------------------------

export interface ArchetypeData {
  runId: string;
  archetype: TaskArchetype | null;
  archetypeConfidence: number | null;
  classifierCostUsd: number;
  tier: string | null;
  fallbackUsed: boolean;
  userOverride: null;
  finalIter: number | null;
  finalCostUsd: number;
  success: boolean;
  pipelineApplied: boolean;
  promotedFrom: TaskArchetype | null;
  promotionTrigger: string | null;
  promotedAtIter: number | null;
}

export function emitArchetype(data: ArchetypeData): void {
  log("[zone-archetype]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitArchetypePromoted — [zone-archetype-promoted]
// Emitted inside the for-loop when L5.1b-2 promotion fires.
// ---------------------------------------------------------------------------

export interface ArchetypePromotedData {
  runId: string | null | undefined;
  fromArchetype: TaskArchetype | null;
  toArchetype: "complex_multi_file";
  atIter: number | null;
  trigger: "iter_cap" | "rollback_x2" | "coaching_exhausted" | null;
}

export function emitArchetypePromoted(data: ArchetypePromotedData): void {
  log("[zone-archetype-promoted]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitCacheUsage — [zone-cache-usage]
// Emitted per-iteration when there is Anthropic cache activity.
// ---------------------------------------------------------------------------

export interface CacheUsageData {
  runId: string | null | undefined;
  iter: number;
  model: string | null;
  write: number;
  read: number;
  input_uncached: number;
  output: number;
  cacheHitRatio: number;
}

export function emitCacheUsage(data: CacheUsageData): void {
  log("[zone-cache-usage]", JSON.stringify({ event: "cache_call_usage", ...data }));
}

// ---------------------------------------------------------------------------
// emitTierConstraints — [zone-tier-constraints-applied]
// Emitted once per run when tier limits are active.
// ---------------------------------------------------------------------------

export interface TierConstraintsData {
  runId: string | null | undefined;
  tier: string;
  maxSubagentCalls: number;
  tokenBudgetCap: number;
  softIterWarn: number;
  classificationConfidence: number;
  fallbackUsed: boolean;
}

export function emitTierConstraints(data: TierConstraintsData): void {
  log("[zone-tier-constraints-applied]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitCoachingRule — [zone-coaching-rule]
// Emitted when the test-failure scope-check coaching rule fires.
// ---------------------------------------------------------------------------

export interface CoachingRuleData {
  runId: string | null | undefined;
  iter: number;
  rule: string;
  decision: "in_scope" | "out_of_scope" | "unclear";
  parsedFailingFile: string | null;
  modifiedFiles: string[];
}

export function emitCoachingRule(data: CoachingRuleData): void {
  log("[zone-coaching-rule]", JSON.stringify({ event: "coaching_rule_trigger", ...data }));
}

// ---------------------------------------------------------------------------
// emitCommandCacheSummary — [zone-command-cache-summary]
// Emitted at run close via both log() and writeCacheLog().
// ---------------------------------------------------------------------------

export interface CommandCacheSummaryData {
  runId: string | null | undefined;
  totalHits: number;
  totalMisses: number;
  totalSavedMs: number;
  cacheSize: number;
}

export function emitCommandCacheSummary(
  repoPath: string,
  data: CommandCacheSummaryData
): void {
  log("[zone-command-cache-summary]", JSON.stringify(data));
  writeCacheLog(repoPath, "[zone-command-cache-summary]", data as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// emitApplyRolledBackFeedback — [zone-apply-rolled-back-feedback]
// Emitted at natural_completion and max_iterations rollback sites (×2).
// ---------------------------------------------------------------------------

export interface ApplyRolledBackFeedbackData {
  site: "natural_completion" | "max_iterations";
  label: string;
  durationMs?: number;
  baselineErrorCount?: number;
  postErrorCount?: number;
  errorCount: number;
  filePathsRestored: string[];
  runId: string | null | undefined;
}

export function emitApplyRolledBackFeedback(data: ApplyRolledBackFeedbackData): void {
  log("[zone-apply-rolled-back-feedback]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitApplyRolledBackMarker — [zone-apply-rolled-back-marker]
// Emitted at natural_completion and max_iter rollback sites (×2).
// Delegates payload construction to buildApplyRolledBackMarkerLog.
// ---------------------------------------------------------------------------

export type ApplyRolledBackMarkerSite = "natural_completion" | "max_iter" | "inline_ts_check";

export interface ApplyRolledBackMarkerInput {
  site: ApplyRolledBackMarkerSite;
  markerMessage: string;
  errors: RolledBackError[];
  filePathsRestored: string[];
  runId: string | null | undefined;
}

export function emitApplyRolledBackMarker(input: ApplyRolledBackMarkerInput): void {
  log(
    "[zone-apply-rolled-back-marker]",
    JSON.stringify(
      buildApplyRolledBackMarkerLog({
        site: input.site,
        markerMessage: input.markerMessage,
        errors: input.errors,
        filePathsRestored: input.filePathsRestored,
        runId: input.runId ?? null,
      })
    )
  );
}

// ---------------------------------------------------------------------------
// emitVerifyWarnSurfaced — [zone-verify-warn-surfaced]
// Emitted at natural_completion and token_budget_exceeded warn sites (×2).
// ---------------------------------------------------------------------------

export interface VerifyWarnSurfacedData {
  site: "natural_completion" | "token_budget_exceeded";
  label: string;
  durationMs?: number;
  baselineErrorCount?: number;
  postErrorCount?: number;
  errorCount: number;
  runId: string | null | undefined;
}

export function emitVerifyWarnSurfaced(data: VerifyWarnSurfacedData): void {
  log("[zone-verify-warn-surfaced]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitAgentFinalAssessment — [zone-agent-final-assessment]
// Emitted at natural_completion (×1) and max_iterations (×1).
// Payloads differ by trigger site — represented as a discriminated union.
// ---------------------------------------------------------------------------

export type AgentFinalAssessmentData =
  | {
      triggeredBy: "natural_completion";
      verificationReason: string;
      patchValidatedByAgent: boolean;
      inferredFrom: "tag" | "heuristic";
      summaryPreview: string;
    }
  | {
      triggeredBy: "max_iterations";
      finalVerificationReason: string;
      inferredFrom: string;
      patchValidatedByAgent: boolean;
    };

export function emitAgentFinalAssessment(data: AgentFinalAssessmentData): void {
  log("[zone-agent-final-assessment]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Re-export IterCostUpdatePayload for callers that spread lastIterCostPayload
// but also need the type without an extra import.
// ---------------------------------------------------------------------------
export type { IterCostUpdatePayload };
