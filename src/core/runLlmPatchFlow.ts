import { extractPriorRunSummary } from "../llm/applyRollbackFeedback.js";
import { computeFileDiff } from "./fileDiff.js";
import type { DiffLine } from "./fileDiff.js";
import { readFsConversationEvents } from "./conversationFilesystemStore.js";
import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { extractFunctionRanges } from "../ast/extractFunctionRange.js";
import { extractSymbolContext } from "../ast/extractSymbolContext.js";
import { existsSync, readFileSync, writeFileSync, statSync, accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { planPatchPreviewWithLlm } from "../llm/planPatchPreview.js";
import { planFullPatchWithLlm } from "../llm/planFullPatch.js";
import { plannerStep, type PlannerStepOutput } from "../llm/plannerStep.js";
import { getDynamicContextLimit } from "../repo/getDynamicContextLimit.js";
import { tryRecoverDeveloperPatchFromModelOutput } from "./patchConversion.js";
import { detectFramework, type ProjectFramework } from "../repo/detectFramework.js";
import {
  generateExecutionPlan,
  isAnswerOnlyPlan,
  type ExecutionPlan,
} from "../llm/executionPlan.js";
import { computeRiskScore } from "./computeRiskScore.js";
import {
  evaluatePlanAlignment,
  type PlanAlignmentResult,
} from "./evaluatePlanAlignment.js";
import { verifyPatch, type VerificationResult } from "./verifyPatch.js";
import { detectVerificationPlan } from "./detectVerificationCommand.js";
import {
  runRuntimeVerificationPlan,
  type RuntimeVerificationResult,
  type RuntimeVerificationPlanResult,
} from "./runRuntimeVerification.js";
import { getInferenceMode } from "../llm/openaiClient.js";
import type { LLMProvider } from "../llm/types.js";
import {
  buildRetryGuidanceFromFailure,
  formatRetryGuidanceBrief,
} from "./buildRetryGuidanceFromFailure.js";
import {
  detectIntentMismatch,
  type IntentMismatchReasonCode,
} from "../engine/intentMismatchDetector.js";
import {
  detectDesignSystemSignals,
  type DesignSystemSignals,
} from "../engine/designSystemSignals.js";
import { scorePatchQuality } from "../engine/patchQualityScorer.js";
import { resolveSafetyLevel } from "../engine/safetyLevelResolver.js";
import { enforceMicroEditProtection } from "../engine/microEditProtection.js";
import { ApiKeyError } from "../llm/factory.js";
import { validatePatchCorrectness } from "../engine/patchCorrectnessValidator.js";
import { parseDeveloperPatchText } from "./developerPatchParse.js";
import { applyLlmPatches } from "./applyLlmPatches.js";
import { parseTaskIntent, type TaskIntent } from "./taskIntentParser.js";
import { tryAstPatchFallback } from "./astPatchFallback.js";
import {
  runAgentLoop,
  type AgentLoopResult,
  type VerificationReason,
} from "../llm/agentLoop.js";
import { resolveAgentPath } from "../tools/toolExecutor.js";
import { stripVerificationTag } from "../llm/verification/index.js";
import {
  isPlanOrchestrationEnabled,
  buildStepTask,
  aggregateOrchestratorResults,
} from "./planOrchestrator.js";
import {
  completeTodo,
  executionPlanToTodos,
  finalizeTodos,
  findTodoIdForFile,
  startTodo,
  todoIdForStepIndex,
  type RunTodo,
  type TodoStatus,
} from "./todoLifecycle.js";
import {
  collectVerificationCommands,
  type VerificationCommand,
} from "./verdictClassifier.js";
import { parseVerificationErrorWithRepo as parseVerificationError } from "./parseVerificationError.js";
import type { PatchPreviewItem, RankedRepoFile } from "../types/agent.js";
import type { ConversationBillingMode } from "../types/conversation.js";
import type { RepoFile } from "../types/project.js";
import { startZoneApiPerfRun } from "../api/zoneApiPerf.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConversationByThreadId } from "../billing/conversationRepository.js";
import {
  createAgentLifecycleEvent,
  type AgentLifecycleEvent,
  type LlmPatchProgressUpdate,
  type RunSummaryPayload,
  type ZoneHandoffReport,
  type ZoneStructuredProgressEvent,
} from "./agentLifecycleEvents.js";
import { cacheHitRatio, type IterCostUpdatePayload } from "../usage/iterCostMeter.js";
import { costLogPath, appendIterCostRecord, appendRunSummary } from "../usage/costLogger.js";
import { computeWorkerMaxIterations, ANSWER_ONLY_ITER_BUDGET } from "../llm/subagents.js";
import {
  classifyTask,
  type TaskArchetype,
  type TaskClassification,
  type TaskTier,
} from "../llm/taskClassifier.js";
import {
  buildPipelineConfig,
  readArchetypeFlagsFromEnv,
  buildDispatcherCapabilityFilter,
  INVESTIGATION_PIPELINE,
  type PipelineConfig,
} from "../llm/archetypeDispatcher.js";
import { type CapabilityFilter } from "../tools/capabilities.js";
import { getRunCost } from "../usage/usageTracker.js";
import {
  generateFinalRunReport,
  type FinalRunReport,
} from "./generateFinalRunReport.js";
import { embedText } from "../embeddings/embedFile.js";
import {
  getEmbeddingCountForRepo,
  matchSimilarFiles,
  isEmbeddingBackendAvailable,
} from "../embeddings/embeddingsRepository.js";
import { indexRepoFiles } from "../embeddings/indexRepository.js";
import { logger, debugLog, errorLog, log } from "../utils/logger.js";
import { attachRunIdentity } from "../llm/openaiContext.js";
import { resolveTierLimits, type TierLimits } from "../llm/tierLimits.js";
import {
  requestRevisionApproval,
  type RevisionDecision,
} from "../llm/revisionApprovals.js";
import { buildToolCallPatch } from "./toolCallPatch.js";
import { toolCallIdentifyingArg } from "./toolCallIdentifyingArg.js";

const MAX_FINAL_ANSWER_CHARS = 100_000;

/**
 * F1.4 C3: filter for the runLlmPatchFlow onProgress sink. toolExecutor
 * emits diagnostic telemetry like
 *   `{"event":"zone-tool-apply-patch-identity-swap-allowed-as-rename",...}`
 * via the same onProgress callback that user-visible tool_call titles
 * flow through. Without filtering, the UI's tool_call renderer surfaces
 * the raw JSON in the chat. This helper returns true for any onProgress
 * message that looks like a JSON object with `"event":"zone-..."` — those
 * payloads stay a side-channel for tests / manual diagnostic readers.
 *
 * Exported for unit-test coverage; the runtime callsite is inline above
 * inside the runAgentLoop input definition.
 */
export function isZoneInternalTelemetryProgress(msg: unknown): boolean {
  const trimmed = String(msg ?? "").trim();
  if (!trimmed.startsWith("{")) return false;
  return /"event"\s*:\s*"zone-/.test(trimmed);
}

export type LlmPatchFlowResult =
  | {
      ok: true;
      patchPreview: string;
      warnings: string[];
      developerConfidence?: number;
      developerRisk?: {
        score: number;
        breakdown: {
          destructive: number;
          schema: number;
          massScope: number;
        };
      };
      intentMismatch?: {
        hasMismatch: boolean;
        severity: "none" | "low" | "medium" | "high";
        reasonCodes: IntentMismatchReasonCode[];
        warnings: string[];
      };
      patchQuality?: {
        qualityScore: number;
        qualityWarnings: string[];
        patchSizeScore: number;
        structurePreservationScore: number;
        designSystemComplianceScore: number;
        semanticAlignmentScore: number;
      };
      patchQualitySummary?: {
        source: PatchSource;
        fallbackUsed: boolean;
        changedFileCount: number;
        totalChangedLines: number;
      };
      designSystemSignals?: DesignSystemSignals;
      safetyResolution?: {
        safetyLevel:
          | "safe_auto_apply"
          | "safe_with_review"
          | "preview_only"
          | "high_risk_blocked";
        safetyReasons: string[];
        confidenceAdjusted?: number;
      };
      microEditProtection?: {
        isViolation: boolean;
        violationReasons: string[];
        shouldForcePreview: boolean;
        shouldDowngradeSafety: boolean;
      };
      reason?: string;
      patchSource?: PatchSource;
      // Phase J.4: dropped "preview_only" (J.1 collapsed it into safe_to_apply).
      // The four live values: safe_to_apply (default success), blocked
      // (security violation), rolled_back (J.3 verification regression),
      // chat (non-patch conversational flow).
      decisionMode?: "safe_to_apply" | "blocked" | "chat" | "rolled_back";
      finalState?: "safe_to_apply" | "blocked" | "chat" | "rolled_back";
      /** Phase H.7: agent loop terminated at token-budget hard limit (95%
       *  of TOKEN_BUDGET_CAP). UI shows "Token budget reached" pill. The
       *  patch verdict still reflects whatever was produced before exit. */
      tokenBudgetExceeded?: boolean;
      /** Phase Q.2: agent loop terminated because the same tool was called
       *  with identical args too many times. UI shows an amber notice. */
      loopDetected?: { toolName: string; count: number };
      /** L5.1b-2: non-null when the dispatcher soft-promoted this run mid-loop. */
      promotedFromArchetype?: TaskArchetype | null;
      /** Phase J.3: post-apply verification regressed (patch introduced new
       *  errors). Staging was discarded; UI shows "Apply rolled back" amber
       *  banner with the diff for inspection but no undo button. */
      rolledBackReason?: string;
      rolledBackErrors?: string[];
      /** When decisionMode is chat, surfaced to the UI as the assistant message. */
      chatResponse?: string;
      finalExecutionOutcome?:
        | "completed"
        | "completed_with_verification_skipped"
        | "completed_with_tooling_issue"
        | "failed_verification"
        | "failed_after_retry"
        | "completed_with_issues";
      resultState?:
        | "completed_verified"
        | "completed_after_repair"
        | "failed_verification"
        | "failed_after_repair"
        | "completed_with_tooling_issue";
      verificationStatus?:
        | "passed"
        | "skipped"
        | "tooling_issue"
        | "code_failed"
        | "timeout";
      finalVerificationFailure?: {
        status: RuntimeVerificationResult["status"];
        command?: string;
        summary: string;
        rootCause?: string;
        normalizedFailureReason?: string;
        incorrectAssumption?: string;
        requiredFix?: string;
        constraint?: string;
        scopeConstraint?: string;
      };
      attemptsUsed?: number;
      validationBlocked?: boolean;
      plan?: ExecutionPlan;
      planAlignment?: PlanAlignmentResult;
      verification?: VerificationResult;
      runtimeVerification?: RuntimeVerificationResult;
      verificationAttempts?: Array<{
        command?: string;
        status: string;
        failureType?: "code_related" | "tooling_issue" | "timeout" | "skipped";
        failureSummary: string;
      }>;
      repairAttempts?: Array<{
        attempt: number;
        files: string[];
        status: "generated" | "applied" | "skipped" | "failed";
        summary: string;
      }>;
      targetFile?: string;
      patchesAlreadyApplied?: boolean;
      verificationReason?: string;
      verificationNote?: string;
      /** verdict-fix Tur: classified run_command outcomes (test/build/typecheck)
       *  the agent actually executed during this run. Empty array when the
       *  agent ran no recognizable verification commands. UI uses this to
       *  show honest secondary text under the verdict badge. */
      verificationCommands?: import("./verdictClassifier.js").VerificationCommand[];
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      patchResults: PatchResult[];
      fileDiffs?: FileDiff[];
      contextFiles?: string[];
      lifecycleEvents?: AgentLifecycleEvent[];
      finalRunReport: FinalRunReport;
      handoffReport?: ZoneHandoffReport;
    }
  | {
      ok: false;
      reason: string;
      refineFeedback?: string;
      discardedStaging?: Map<string, string>;
      lifecycleEvents?: AgentLifecycleEvent[];
      finalRunReport?: FinalRunReport;
    };

// Phase J.4: fields kept inside the result shape for log/observability but
// stripped from the public HTTP response. After J.1 collapsed preview_only
// into safe_to_apply, none of these gate UI behavior — they live on as
// internal context for [zone-patch-result] / [zone-decision-mode] traces
// and the run summary persisted to storage. The CLI doesn't read them.
const J4_INTERNAL_ONLY_FIELDS = [
  "developerConfidence",
  "developerRisk",
  "intentMismatch",
  "patchQuality",
  "patchQualitySummary",
  "designSystemSignals",
  "safetyResolution",
  "microEditProtection",
  "verificationReason",
  "verificationNote",
  "verificationCommands",
  "verificationStatus",
  "verification",
  "runtimeVerification",
  "verificationAttempts",
  "repairAttempts",
  "finalVerificationFailure",
  "attemptsUsed",
  "plan",
  "planAlignment",
  "finalExecutionOutcome",
  "resultState",
  "validationBlocked",
] as const;

/**
 * Phase J.4 — return only the public-shape fields to the HTTP client. The
 * `result` object passed in keeps all its keys for logging upstream; this
 * helper produces a sibling shape with the heuristic / observability-only
 * fields removed before `res.json(...)` ships it.
 *
 * Failure responses (`ok: false`) are returned untouched — they only carry
 * `{ ok, reason, lifecycleEvents?, finalRunReport? }` to start with.
 */
export function toPublicLlmPatchResponse(
  result: Record<string, unknown>
): Record<string, unknown> {
  if (!result || result.ok !== true) return result;
  const out: Record<string, unknown> = { ...result };
  for (const field of J4_INTERNAL_ONLY_FIELDS) {
    if (field in out) delete out[field];
  }
  return out;
}

type PatchSource =
  | "llm_patch"
  | "llm_patch_recovered"
  | "ast_fallback"
  | "deterministic_fallback"
  | "agent_loop"
  | "no_patch";

export type PatchResult = {
  filePath: string;
  status: "applied" | "skipped" | "failed";
  reason?: string;
};

// DiffLine moved to src/core/fileDiff.ts; re-exported here for backward compat.
export type { DiffLine };

export type FileDiff = {
  filePath: string;
  diff: DiffLine[];
  addedLines: number;
  removedLines: number;
};

const RUN_SUMMARY_DEFAULT_VERIFICATION_REASON: VerificationReason =
  "no_verification_attempted";

function deriveAgentVerificationSummary(input: {
  reason?: VerificationReason | string | null;
  loopSuccess?: boolean;
  hadRunCommandFailure?: boolean;
}): {
  decisionMode: RunSummaryPayload["verification"]["decisionMode"];
  note: string;
} {
  const reason = String(
    input.reason || RUN_SUMMARY_DEFAULT_VERIFICATION_REASON
  ) as VerificationReason;
  if (reason === "tests_passed") {
    return { decisionMode: "safe_to_apply", note: "Tests passed" };
  }
  if (reason === "tests_skipped_no_infra") {
    return {
      decisionMode: "safe_to_apply",
      note: "Tests skipped (no test infrastructure found)",
    };
  }
  if (reason === "tests_failed_unrelated") {
    return {
      decisionMode: "safe_to_apply",
      note: "Tests had pre-existing failures — not caused by this patch",
    };
  }
  // Phase J.1: confidence/verification heuristics no longer gate apply.
  // tests_inconclusive / tests_failed_by_patch / loop-with-errors all map
  // to safe_to_apply now. Real test failures will get a verification rollback
  // safety net in Phase J.3 (out of scope here). The verdict notes still
  // surface the agent's findings for the UI/run-summary.
  if (reason === "tests_inconclusive") {
    return {
      decisionMode: "safe_to_apply",
      note: "Tests inconclusive (environment issue) — review manually",
    };
  }
  if (reason === "tests_failed_by_patch") {
    return {
      decisionMode: "safe_to_apply",
      note: "Tests failed — patch may need revision",
    };
  }

  return {
    decisionMode: "safe_to_apply",
    note:
      input.loopSuccess && !input.hadRunCommandFailure
        ? "Patch applied by agent (no test verification)"
        : "Agent loop encountered errors during execution",
  };
}

function aggregateToolsUsed(
  toolCallLog?: AgentLoopResult["toolCallLog"] | null
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of Array.isArray(toolCallLog) ? toolCallLog : []) {
    const tool = String(entry?.tool || "").trim();
    if (!tool) continue;
    out[tool] = (out[tool] ?? 0) + 1;
  }
  return out;
}

function deriveRuntimeVerificationReason(
  verificationStatus?: string | null
): VerificationReason {
  if (verificationStatus === "passed") return "tests_passed";
  if (verificationStatus === "skipped") return "tests_skipped_no_infra";
  if (verificationStatus === "tooling_issue" || verificationStatus === "timeout") {
    return "tests_inconclusive";
  }
  if (verificationStatus === "code_failed") return "tests_failed_by_patch";
  return RUN_SUMMARY_DEFAULT_VERIFICATION_REASON;
}

function deriveRuntimeVerificationNote(input: {
  verificationStatus?: string | null;
  runtimeVerificationPlan?: RuntimeVerificationPlanResult | null;
  runtimeVerification?: RuntimeVerificationResult | null;
}): string {
  const summary =
    String(input.runtimeVerificationPlan?.summary || "").trim() ||
    String(input.runtimeVerification?.summary || "").trim();
  if (summary) return summary;
  if (input.verificationStatus === "passed") return "Runtime verification passed";
  if (input.verificationStatus === "skipped") return "Runtime verification skipped";
  if (input.verificationStatus === "tooling_issue") {
    return "Runtime verification could not complete because of setup/tooling";
  }
  if (input.verificationStatus === "timeout") return "Runtime verification timed out";
  if (input.verificationStatus === "code_failed") return "Runtime verification failed";
  return "";
}

function runtimeVerificationCommands(
  runtimeVerificationPlan?: RuntimeVerificationPlanResult | null
): VerificationCommand[] {
  const steps = Array.isArray(runtimeVerificationPlan?.steps)
    ? runtimeVerificationPlan.steps
    : [];
  return steps.flatMap((step) => {
    const category =
      step.kind === "typecheck"
        ? "typecheck"
        : step.kind === "test"
          ? "test"
          : null;
    if (!category) return [];
    const outcome =
      step.status === "passed"
        ? "passed"
        : step.status === "failed" || step.status === "timeout"
          ? "failed"
          : "unknown";
    return [
      {
        command: String(step.command || "").slice(0, 240),
        category,
        outcome,
      },
    ];
  });
}

function assembleRunSummary(input: {
  fileDiffs?: Array<Pick<FileDiff, "filePath" | "addedLines" | "removedLines">> | null;
  toolCallLog?: AgentLoopResult["toolCallLog"] | null;
  verificationReason?: VerificationReason | string | null;
  verificationNote?: string | null;
  verificationCommands?: VerificationCommand[] | null;
  decisionMode?: "safe_to_apply" | "preview_only" | "blocked" | "chat" | "rolled_back" | null;
  totalUsd?: number | null;
  iterCost?: Pick<
    IterCostUpdatePayload,
    "iter_count" | "total_input_uncached" | "total_cache_read" | "total_cache_write"
  > | null;
}): RunSummaryPayload {
  const filesChanged = (Array.isArray(input.fileDiffs) ? input.fileDiffs : []).map((fd) => ({
    filePath: String(fd?.filePath || ""),
    addedLines: Number(fd?.addedLines ?? 0) || 0,
    removedLines: Number(fd?.removedLines ?? 0) || 0,
  }));
  const reason = String(
    input.verificationReason || RUN_SUMMARY_DEFAULT_VERIFICATION_REASON
  ) as VerificationReason;
  // Phase J.4: RunSummaryPayload.verification.decisionMode narrowed to
  // "safe_to_apply" | "rolled_back" (no preview_only after J.1's collapse).
  // Anything that isn't an explicit rolled_back is reported as safe_to_apply
  // for the structured run summary — the verbose verificationReason / note
  // alongside still carries the nuance.
  const decisionMode: "safe_to_apply" | "rolled_back" =
    input.decisionMode === "rolled_back" ? "rolled_back" : "safe_to_apply";
  const totalUsd = Number(input.totalUsd ?? 0) || 0;
  const iterCount = Number(input.iterCost?.iter_count ?? 0) || 0;
  const cacheHitPct =
    cacheHitRatio({
      input_uncached: Number(input.iterCost?.total_input_uncached ?? 0) || 0,
      cache_write: Number(input.iterCost?.total_cache_write ?? 0) || 0,
      cache_read: Number(input.iterCost?.total_cache_read ?? 0) || 0,
    }) * 100;

  return {
    filesChanged,
    toolsUsed: aggregateToolsUsed(input.toolCallLog),
    verification: {
      reason,
      note: String(input.verificationNote || ""),
      commands: Array.isArray(input.verificationCommands)
        ? input.verificationCommands
        : [],
      decisionMode,
    },
    cost: {
      totalUsd,
      iterCount,
      cacheHitPct,
      avgIterUsd: iterCount > 0 ? totalUsd / iterCount : 0,
    },
  };
}

function countJsxTagsDiagnostic(src: string): {
  opens: number;
  closes: number;
  selfClosing: number;
} {
  // Strip strings and comments conservatively so matches inside them don't skew counts.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ");
  const selfClosing =
    (stripped.match(/<[A-Za-z][A-Za-z0-9_.]*\b[^<>]*\/>/g) ?? []).length;
  const closes =
    (stripped.match(/<\/[A-Za-z][A-Za-z0-9_.]*\s*>/g) ?? []).length;
  // Any `<Tag ...>` that is not self-closing.
  const allOpens =
    (stripped.match(/<[A-Za-z][A-Za-z0-9_.]*\b[^<>]*>/g) ?? []).length;
  const opens = Math.max(0, allOpens - selfClosing);
  return { opens, closes, selfClosing };
}

function buildDiffHeadSample(diff: DiffLine[], maxChars = 200): string {
  const formatted = diff
    .filter((line) => line.type !== "unchanged")
    .map((line) => `${line.type === "added" ? "+" : "-"}${line.content}`)
    .join("\n");
  return formatted.length <= maxChars
    ? formatted
    : `${formatted.slice(0, maxChars)}…`;
}

type HostedDeveloperContextInput = {
  repoSummary: string;
  projectNotes?: string[];
  existingFilesSummary: string;
  availableFiles: Array<{
    path: string;
    category: string;
    extension: string;
  }>;
  contextFiles: Array<{
    path: string;
    action: string;
    reason: string;
    content: string;
  }>;
  originalContents: Record<string, string>;
};

function hostedDeveloperContextHasHostedFiles(
  ctx: HostedDeveloperContextInput | undefined
): boolean {
  if (!ctx) return false;
  if (Array.isArray(ctx.contextFiles) && ctx.contextFiles.length > 0) return true;
  const legacy = (ctx as { files?: unknown[] }).files;
  return Array.isArray(legacy) && legacy.length > 0;
}

function findFunctionDeclarationIndex(source: string, funcName: string): number {
  const patterns = [
    `function ${funcName}`,
    `async function ${funcName}`,
    `function ${funcName}(`,
    `async function ${funcName}(`,
  ];
  for (const p of patterns) {
    const i = source.indexOf(p);
    if (i >= 0) return i;
  }
  return -1;
}

/** Best-effort: detect comment/JSDoc tasks that already appear satisfied in file text. */
function isTaskAlreadyDone(task: string, fileContent: string): boolean {
  if (!/add.*comment|add.*jsdoc/i.test(task)) {
    return false;
  }
  const funcMatch = task.match(/(?:above|for|to)\s+(?:the\s+)?(\w+)\s+function/i);
  if (!funcMatch?.[1]) {
    return false;
  }
  const funcName = funcMatch[1];
  const funcIdx = findFunctionDeclarationIndex(fileContent, funcName);
  if (funcIdx <= 0) {
    return false;
  }
  const before = fileContent.slice(Math.max(0, funcIdx - 200), funcIdx);
  if (before.includes("/**") || before.includes("//")) {
    return true;
  }
  return false;
}

function isDeprioritizedConfigPathForFrontendTask(filePath: string): boolean {
  const n = filePath.replace(/\\/g, "/").toLowerCase();
  return n.endsWith("requirements.txt") || n.includes("ai-service/requirements.txt");
}

function taskLooksLikeReactOrJsxValidation(task: string): boolean {
  const t = task.toLowerCase();
  return (
    /\bjsx\b/.test(t) ||
    /\breact\b/.test(t) ||
    /\.jsx\b/.test(t) ||
    /\.tsx\b/.test(t) ||
    /\bcomponent\b/.test(t) ||
    /\bvalidation\b/.test(t)
  );
}

function parseExactLineReplaceTask(task: string): { findLine: string; replaceLine: string } | null {
  const lines = String(task || "").split(/\r?\n/);
  let findLine = "";
  let replaceLine = "";
  for (let i = 0; i < lines.length; i += 1) {
    const l = String(lines[i] ?? "");
    if (/replace\s+this\s+exact\s+line\s*:/i.test(l)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const c = String(lines[j] ?? "").trim();
        if (!c) continue;
        findLine = c;
        i = j;
        break;
      }
      continue;
    }
    if (/^\s*with\s*:/i.test(l)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const c = String(lines[j] ?? "").trim();
        if (!c) continue;
        replaceLine = c;
        i = j;
        break;
      }
    }
  }
  if (!findLine || !replaceLine) return null;
  if (findLine === replaceLine) return null;
  return { findLine, replaceLine };
}

function buildQuoteVariants(line: string): string[] {
  const s = String(line || "");
  const out = new Set<string>();
  out.add(s);
  if (s.includes('\\"')) {
    out.add(s.replace(/\\"/g, '"'));
    out.add(s.replace(/\\"/g, "'"));
  }
  if (s.includes('"')) {
    out.add(s.replace(/"/g, "'"));
  }
  if (s.includes("'")) {
    out.add(s.replace(/'/g, '"'));
  }
  return Array.from(out);
}

function extractFirstStringLiteralFromLine(line: string): string | null {
  const s = String(line || "");
  // Very small heuristic: first "..." or '...'
  const m = s.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/);
  if (!m) return null;
  const raw = typeof m[1] === "string" ? m[1] : typeof m[2] === "string" ? m[2] : "";
  return raw;
}

function inferReplacementFromPatchedFile(opts: {
  before: string;
  after: string;
  oldExpected: string;
}): string | null {
  const beforeLines = String(opts.before || "").split(/\r?\n/);
  const afterLines = String(opts.after || "").split(/\r?\n/);
  const beforeIdx = beforeLines.findIndex((l) => l.includes(opts.oldExpected));
  if (beforeIdx < 0) return null;
  const beforeLine = beforeLines[beforeIdx] ?? "";
  const oldLiteral = extractFirstStringLiteralFromLine(beforeLine);
  if (!oldLiteral || oldLiteral !== opts.oldExpected) {
    // Still allow: if oldExpected is substring, fall back.
    if (!beforeLine.includes(opts.oldExpected)) return null;
  }

  // Build a loose anchor using the parts around the oldExpected (trimmed).
  const parts = beforeLine.split(opts.oldExpected);
  const prefix = String(parts[0] ?? "").trim();
  const suffix = String(parts[1] ?? "").trim();

  const afterCandidate =
    afterLines[beforeIdx] ??
    afterLines.find((l) => (prefix ? l.includes(prefix) : true) && (suffix ? l.includes(suffix) : true)) ??
    "";
  if (!afterCandidate) return null;

  const newLiteral = extractFirstStringLiteralFromLine(afterCandidate);
  if (!newLiteral) return null;
  if (newLiteral === opts.oldExpected) return null;
  return newLiteral;
}

function tryApplyExactLineReplacement(opts: {
  fileContent: string;
  findLine: string;
  replaceLine: string;
}): { ok: true; fullContent: string } | { ok: false; reason: string } {
  const normalizeForLooseMatch = (s: string) =>
    String(s || "")
      .normalize("NFD")
      // Strip diacritics (e.g. ş -> s + ¸).
      .replace(/\p{M}/gu, "")
      // Normalize Turkish dotted/dotless i.
      .replace(/ı/g, "i")
      .replace(/İ/g, "I");

  const findVariants = buildQuoteVariants(opts.findLine).map((s) => s.trim()).filter(Boolean);
  const replaceVariants = buildQuoteVariants(opts.replaceLine).map((s) => s.trim()).filter(Boolean);
  if (findVariants.length === 0 || replaceVariants.length === 0) {
    return { ok: false, reason: "no_variants" };
  }
  const findVariantsNormalized = findVariants.map((v) => ({
    raw: v,
    norm: normalizeForLooseMatch(v),
  }));

  const lines = opts.fileContent.split(/\r?\n/);
  const matches: Array<{ index: number; originalLine: string; findVariant: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const originalLine = lines[i] ?? "";
    const trimmed = originalLine.trim();
    if (!trimmed) continue;
    const trimmedNorm = normalizeForLooseMatch(trimmed);
    const matched = findVariantsNormalized.find((v) => v.norm === trimmedNorm)?.raw;
    if (matched) matches.push({ index: i, originalLine, findVariant: matched });
  }

  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) return { ok: false, reason: `ambiguous_${matches.length}` };

  const m = matches[0];
  const leadingWs = (m.originalLine.match(/^\s*/) ?? [""])[0];
  const trailingWs = (m.originalLine.match(/\s*$/) ?? [""])[0];
  const preferSingleQuote = m.findVariant.includes("'") && !m.findVariant.includes('"');
  const replacement =
    preferSingleQuote
      ? replaceVariants.find((r) => r.includes("'")) ?? opts.replaceLine.trim()
      : replaceVariants.find((r) => r.includes('"')) ?? opts.replaceLine.trim();

  lines[m.index] = `${leadingWs}${replacement}${trailingWs}`;
  const fullContent = lines.join("\n");
  if (fullContent === opts.fileContent) return { ok: false, reason: "no_change" };
  return { ok: true, fullContent };
}

/** First line matching `Target file: <path>` (case-insensitive). */
function extractExplicitTarget(task: string): string | null {
  for (const line of task.split(/\r?\n/)) {
    const m = line.match(/^\s*Target\s+file:\s*(.+?)\s*$/i);
    if (m) {
      const raw = m[1].trim().replace(/^[`'"]+|[`'"]+$/g, "");
      if (raw.length > 0) {
        return raw.replace(/\\/g, "/");
      }
    }
  }
  return null;
}

function normalizeExplicitTargetPathKey(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

/**
 * Resolve `Target file:` against the raw repo file list (not ranked/trimmed views).
 * Order: exact path → normalized slashes → case-insensitive full path → basename match only if unique.
 */
function resolveExplicitTarget(
  allFiles: RepoFile[],
  targetPath: string | null
): RepoFile | null {
  if (!targetPath) {
    return null;
  }
  const norm = normalizeExplicitTargetPathKey(targetPath);
  if (!norm) {
    return null;
  }
  for (const f of allFiles) {
    if (f.path === targetPath) {
      return f;
    }
  }
  for (const f of allFiles) {
    if (normalizeExplicitTargetPathKey(f.path) === norm) {
      return f;
    }
  }
  const lower = norm.toLowerCase();
  for (const f of allFiles) {
    if (normalizeExplicitTargetPathKey(f.path).toLowerCase() === lower) {
      return f;
    }
  }
  const base = norm.split("/").filter(Boolean).pop() ?? "";
  if (!base) {
    return null;
  }
  const baseLower = base.toLowerCase();
  const basenameMatches = allFiles.filter((f) => {
    const seg = normalizeExplicitTargetPathKey(f.path).split("/").filter(Boolean).pop() ?? "";
    return seg.toLowerCase() === baseLower;
  });
  if (basenameMatches.length === 1) {
    return basenameMatches[0] ?? null;
  }
  return null;
}

function parseExplicitTargetFileLineFromTask(task: string): string | null {
  return extractExplicitTarget(task);
}

function findRepoFileByExplicitTarget(
  allFiles: RepoFile[],
  explicitTargetPath: string | null
): RepoFile | null {
  return resolveExplicitTarget(allFiles, explicitTargetPath);
}

function mergeExplicitRepoFileIntoRankedFiles(
  ranked: RankedRepoFile[],
  explicit: RepoFile
): RankedRepoFile[] {
  const maxScore = ranked.length > 0 ? Math.max(...ranked.map((f) => f.score)) : 0;
  const boosted = maxScore + 10_000;
  const explicitLower = normalizeExplicitTargetPathKey(explicit.path).toLowerCase();
  const withoutDup = ranked.filter(
    (f) => normalizeExplicitTargetPathKey(f.path).toLowerCase() !== explicitLower
  );
  const asRanked: RankedRepoFile = { ...explicit, score: boosted };
  return [asRanked, ...withoutDup];
}

function resolvedFileContextsIncludePath(
  contexts: Array<{ path: string }>,
  canonPath: string
): boolean {
  const want = normalizeExplicitTargetPathKey(canonPath).toLowerCase();
  return contexts.some((f) => normalizeExplicitTargetPathKey(f.path).toLowerCase() === want);
}

async function loadExplicitTargetFileContentForPatchContext(input: {
  canonPath: string;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): Promise<string> {
  const { canonPath, hostedContext, allFiles } = input;
  if (hostedContext) {
    if (Object.prototype.hasOwnProperty.call(hostedContext.originalContents, canonPath)) {
      return hostedContext.originalContents[canonPath] ?? "";
    }
    for (const [k, v] of Object.entries(hostedContext.originalContents)) {
      if (normalizeExplicitTargetPathKey(k).toLowerCase() === normalizeExplicitTargetPathKey(canonPath).toLowerCase()) {
        return v ?? "";
      }
    }
    const ctx = hostedContext.contextFiles.find((f) => f.path === canonPath);
    if (ctx) {
      return ctx.content;
    }
    const ctxInsensitive = hostedContext.contextFiles.find(
      (f) =>
        normalizeExplicitTargetPathKey(f.path).toLowerCase() ===
        normalizeExplicitTargetPathKey(canonPath).toLowerCase()
    );
    if (ctxInsensitive) {
      return ctxInsensitive.content;
    }
  }
  const repoFile = allFiles.find((f) => f.path === canonPath) ?? findRepoFileByExplicitTarget(allFiles, canonPath);
  if (!repoFile?.absolutePath) {
    return "";
  }
  const disk = await readProjectFiles([repoFile.absolutePath]);
  return disk[repoFile.absolutePath] ?? "";
}

function isPathGroundedForPreviewFallback(input: {
  path: string;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): boolean {
  if (isIrrelevantDeveloperContextPath(input.path) || isProtectedDeveloperUiPath(input.path)) {
    return false;
  }
  if (input.hostedContext) {
    return Object.prototype.hasOwnProperty.call(
      input.hostedContext.originalContents,
      input.path
    );
  }
  return input.allFiles.some((f) => f.path === input.path);
}

const EXPLICIT_TARGET_NOT_FOUND_WARNING =
  "[EXPLICIT_TARGET_NOT_FOUND] Target file was not found in the selected repository/context.";

function taskTextMentionsRepoPath(task: string, path: string): boolean {
  const t = task.toLowerCase();
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  if (base && t.includes(base.toLowerCase())) {
    return true;
  }
  if (t.includes(normalized.toLowerCase())) {
    return true;
  }
  return false;
}

/** Dependency / config paths we must not use as ranked preview-empty fallback unless the task names them. */
function isUnrelatedRankedFallbackPath(path: string, task: string): boolean {
  if (taskTextMentionsRepoPath(task, path)) {
    return false;
  }
  const n = path.replace(/\\/g, "/").toLowerCase();
  const base = n.split("/").pop() ?? "";

  if (base === ".gitignore" || n.endsWith("/.gitignore")) {
    return true;
  }
  if (base.startsWith(".env") || n.includes("/.env")) {
    return true;
  }
  const lockNames = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "poetry.lock",
    "uv.lock",
    "cargo.lock",
    "gemfile.lock",
    "pipfile.lock",
  ]);
  if (lockNames.has(base) || base.endsWith(".lock")) {
    return true;
  }
  if (base === "pipfile") {
    return true;
  }
  if (base === "requirements.txt" || n.endsWith("/requirements.txt")) {
    return true;
  }
  if (base === ".npmrc" || base === ".yarnrc.yml" || base === ".pnpmfile.cjs") {
    return true;
  }
  if (base.endsWith(".pem")) {
    return true;
  }
  if (/^tsconfig.*\.json$/i.test(base) || base === "jsconfig.json") {
    return true;
  }
  if (/^(vite|vitest|webpack|rollup|tailwind|postcss|eslint|prettier|jest|playwright)\.config\./i.test(base)) {
    return true;
  }
  if (/^\.eslintrc/i.test(base) || base.startsWith(".prettierrc")) {
    return true;
  }
  if (base === "docker-compose.yml" || base === "docker-compose.yaml") {
    return true;
  }
  return false;
}

function pickRankedPreviewEmptyFallbackPath(input: {
  task: string;
  fullRankedFiles: RankedRepoFile[];
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): string | null {
  const deprioritizeConfig = taskLooksLikeReactOrJsxValidation(input.task);
  const ranked = [...input.fullRankedFiles];
  if (deprioritizeConfig) {
    ranked.sort((a, b) => {
      const aBad = isDeprioritizedConfigPathForFrontendTask(a.path) ? 1 : 0;
      const bBad = isDeprioritizedConfigPathForFrontendTask(b.path) ? 1 : 0;
      if (aBad !== bBad) {
        return aBad - bBad;
      }
      return b.score - a.score;
    });
  }

  for (const f of ranked) {
    if (isUnrelatedRankedFallbackPath(f.path, input.task)) {
      continue;
    }
    if (
      isPathGroundedForPreviewFallback({
        path: f.path,
        hostedContext: input.hostedContext,
        allFiles: input.allFiles,
      })
    ) {
      return f.path;
    }
  }
  return null;
}

type PreviewEmptyFallbackResolution =
  | { kind: "path"; path: string }
  | { kind: "explicit_target_not_grounded"; explicitPath: string }
  | { kind: "none" };

function resolvePreviewEmptyFallbackPath(input: {
  task: string;
  explicitTargetParsed: string | null;
  fullRankedFiles: RankedRepoFile[];
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): PreviewEmptyFallbackResolution {
  const explicit = input.explicitTargetParsed;
  if (explicit) {
    const repoFile = findRepoFileByExplicitTarget(input.allFiles, explicit);
    if (
      repoFile &&
      !isIrrelevantDeveloperContextPath(repoFile.path) &&
      !isProtectedDeveloperUiPath(repoFile.path)
    ) {
      return { kind: "path", path: repoFile.path };
    }
    return { kind: "explicit_target_not_grounded", explicitPath: explicit };
  }
  const rankedPick = pickRankedPreviewEmptyFallbackPath(input);
  return rankedPick ? { kind: "path", path: rankedPick } : { kind: "none" };
}

/** A fully-populated TaskIntent representing "I don't know what this is". */
const UNKNOWN_INTENT: TaskIntent = {
  rawTask: "",
  normalizedTask: "",
  action: "unknown",
  resourceKind: "unknown",
  scope: "unknown",
  mentionsNestedItem: false,
  destructiveRisk: false,
  routeHints: [],
  paramHints: [],
  warnings: [],
  codeIntent: "unknown",
};

const GENERIC_UI_SCAFFOLD_PATTERNS = [
  "welcome to my app",
  "get started",
  "features",
  "application dashboard",
];

const GENERIC_DOCUMENT_SCAFFOLD_PATTERNS = [
  "<title>document</title>",
  '<div id="app"></div>',
  "<div id=\"app\"></div>",
  "/path/to/your/script.js",
];

const CRITICAL_UI_ANCHORS = [
  "zone",
  "recent runs",
  "execute",
  "reset",
  "patch preview",
];

const DEVELOPER_VAGUE_TASK_WARNING =
  "[VAGUE_TASK] Task is too vague to generate a reliable patch. Please describe the specific file, function, and change needed.";
const ZONE_INTERNAL_TASK_WARNING =
  "[ZONE_INTERNAL_TASK] Task targets Zone itself, not the selected repo. Switch to the Zone codebase or clarify the intended target before patching.";

const DEVELOPER_GENERIC_TASK_PHRASES = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
]);

const DEVELOPER_GENERIC_TASK_TOKENS = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
]);

const VAGUE_COMBINATIONS = [
  /^(improve|update|fix|enhance|optimize|clean up|refactor)\s+(the\s+)?(dashboard|ui|app|page|layout|component|screen|design|interface)\.?$/i,
  /^make\s+(the\s+)?(dashboard|ui|app|page|layout|component|screen)\s+(better|cleaner|nicer|faster)\.?$/i,
];

const DEVELOPER_TASK_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "on",
  "in",
  "with",
  "and",
  "or",
  "this",
  "that",
  "please",
]);

const MICRO_EDIT_INTENT_TERMS = [
  "spacing",
  "padding",
  "margin",
  "gap",
  "alignment",
  "align",
  "typo",
  "wording",
  "label text",
  "label",
  "placeholder",
  "small css tweak",
];

const UI_MAPPING_RISK_TERMS = ["swap", "mapping", "reversed", "order", "before/after"];

const ZONE_INTERNAL_ZONE_TERMS = [
  "zone ui",
  "zone itself",
  "zone product",
  "zone thread ui",
  "zone execution ui",
  "zone inspect panel",
  "zone billing summary",
  "zone run-state",
  "zone run state",
  "zone developer flow",
];

const ZONE_INTERNAL_RUNTIME_TERMS = [
  "agentic developer flow",
  "run-state mapping",
  "preview_only",
  "files changed",
  "done result behavior",
  "hosted /api/patch",
  "/api/patch behavior",
  "recent runs",
  "patch preview",
  "inspect panel",
  "thread ui",
  "execution ui",
  "billing summary",
  "run-state",
  "run state",
  "developer flow",
];

const IRRELEVANT_DEVELOPER_CONTEXT_SEGMENTS = [
  "/.env",
  "/.gitignore",
  "/.idea/",
  "/.claude/",
  "/venv/",
  "/site-packages/",
  "/node_modules/",
  "/build/",
  "/dist/",
  "/.agent-cache/",
  "/.agent-patches/",
  "/.agent-backups/",
  "/agent-cache/",
  "/agent-patches/",
  "/agent-backups/",
];

function isUiFilePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.endsWith(".html") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".jsx") ||
    normalized.includes("/ui/") ||
    normalized.includes("/components/") ||
    normalized.includes("/pages/")
  );
}

function isSmallUiPolishTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return [
    "ui",
    "polish",
    "readability",
    "spacing",
    "font",
    "style",
    "layout",
    "hierarchy",
    "align",
    "badge",
    "preview",
    "theme",
  ].some((term) => normalized.includes(term));
}

function isMicroEditUiTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return (
    isSmallUiPolishTask(task) &&
    [
      "spacing",
      "margin",
      "padding",
      "font-size",
      "font size",
      "line-height",
      "line height",
      "alignment",
      "align",
      "label",
      "text polish",
      "copy polish",
      "small",
    ].some((term) => normalized.includes(term))
  );
}

export function detectMicroEditIntent(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  return MICRO_EDIT_INTENT_TERMS.some((term) => normalized.includes(term));
}

export function detectUiMappingRiskIntent(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  return UI_MAPPING_RISK_TERMS.some((term) => normalized.includes(term));
}

export function isIrrelevantDeveloperContextPath(filePath: string): boolean {
  const normalized = `/${filePath.replace(/\\/g, "/").toLowerCase().replace(/^\/+/, "")}`;
  return IRRELEVANT_DEVELOPER_CONTEXT_SEGMENTS.some((segment) =>
    normalized.includes(segment)
  );
}

function isHostedEnvironment(): boolean {
  return (
    process.env.ZONE_INFERENCE_MODE === "hosted" ||
    Boolean(process.env.ZONE_API_BASE_URL)
  );
}

function extractStructureTokens(content: string): string[] {
  const tokens = new Set<string>();
  const regex = /\b(?:id|class)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(content)) !== null) {
    const parts = match[1]
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const part of parts) {
      tokens.add(part.toLowerCase());
    }
  }
  return [...tokens];
}

function normalizeUiContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function countPreservedTokens(currentTokens: string[], nextTokens: string[]): number {
  return currentTokens.filter((token) => nextTokens.includes(token)).length;
}

function extractCriticalAnchors(content: string): string[] {
  const normalized = normalizeUiContent(content);
  return CRITICAL_UI_ANCHORS.filter((anchor) => normalized.includes(anchor));
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trim();
}

function stripCommentsForComparison(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/^\s*--.*$/gm, "")
    .trim();
}

function stripCommentOnlyLines(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*)/.test(line))
    .join("\n")
    .trim();
}

function countChangedLines(before: string, after: string): number {
  const diff = computeFileDiff(before, after);
  return diff.filter((line) => line.type !== "unchanged").length;
}

function countTotalLines(content: string): number {
  if (!content.trim()) return 0;
  return content.replace(/\r\n/g, "\n").split("\n").length;
}

function countPatternMatches(content: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => {
    const matches = content.match(pattern);
    return total + (matches?.length ?? 0);
  }, 0);
}

function detectExistingStructureTaskConstraints(task: string): {
  requiresExistingForm: boolean;
  requiresExistingSubmitFlow: boolean;
  requiresExistingState: boolean;
  avoidsNewForm: boolean;
  avoidsNewApiCall: boolean;
} {
  const normalizedTask = task.toLowerCase();

  return {
    requiresExistingForm:
      /\bexisting form\b/.test(normalizedTask) ||
      /\bcreate form\b/.test(normalizedTask) ||
      /\breuse existing form\b/.test(normalizedTask) ||
      /\bdo not create (?:a )?new form\b/.test(normalizedTask),
    requiresExistingSubmitFlow:
      /\bexisting submit flow\b/.test(normalizedTask) ||
      /\breuse existing submit flow\b/.test(normalizedTask) ||
      /\bsubmit flow\b/.test(normalizedTask),
    requiresExistingState:
      /\breuse (?:the )?existing state\b/.test(normalizedTask) ||
      /\bexisting state\b/.test(normalizedTask),
    avoidsNewForm: /\bdo not create (?:a )?new form\b/.test(normalizedTask),
    avoidsNewApiCall:
      /\bdo not introduce (?:a )?new api call\b/.test(normalizedTask) ||
      /\bdo not add (?:a )?new api call\b/.test(normalizedTask) ||
      /\bno new api call\b/.test(normalizedTask),
  };
}

function isConstrainedLocalizedPatchTask(task: string): boolean {
  const constraints = detectExistingStructureTaskConstraints(task);
  return (
    constraints.requiresExistingForm ||
    constraints.requiresExistingSubmitFlow ||
    constraints.requiresExistingState ||
    constraints.avoidsNewForm ||
    constraints.avoidsNewApiCall
  );
}

function scoreConstraintAwareContextFile(input: {
  task: string;
  content: string;
}): number {
  const constraints = detectExistingStructureTaskConstraints(input.task);
  if (
    !constraints.requiresExistingForm &&
    !constraints.requiresExistingSubmitFlow &&
    !constraints.requiresExistingState &&
    !constraints.avoidsNewForm &&
    !constraints.avoidsNewApiCall
  ) {
    return 0;
  }

  const content = input.content.toLowerCase();
  const hasFormStructure =
    countPatternMatches(content, [
      /<form\b/g,
      /\buseform\b/g,
      /\bformik\b/g,
      /\bformstate\b/g,
      /\bformvalues\b/g,
      /\bformdata\b/g,
    ]) > 0;
  const hasSubmitFlow =
    countPatternMatches(content, [
      /\bonsubmit\b/g,
      /\bhandlesubmit\b/g,
      /\bsubmit[a-z0-9_]*\s*\(/g,
      /\bsubmit[a-z0-9_]*\s*=/g,
      /type\s*=\s*["']submit["']/g,
      /\bpreventdefault\s*\(/g,
    ]) > 0;
  const hasStateHandling =
    countPatternMatches(content, [
      /\busestate\b/g,
      /\busereducer\b/g,
      /\bformstate\b/g,
      /\bset[a-z0-9_]+\s*\(/g,
    ]) > 0;
  const hasApiUsage =
    countPatternMatches(content, [
      /\bfetch\s*\(/g,
      /\baxios\./g,
      /\bapi\.(?:get|post|put|patch|delete)\s*\(/g,
      /\bclient\.(?:get|post|put|patch|delete)\s*\(/g,
      /\bmutate(?:async)?\s*\(/g,
    ]) > 0;

  let score = 0;

  if (constraints.requiresExistingForm) {
    score += hasFormStructure ? 26 : -18;
  }

  if (constraints.requiresExistingSubmitFlow) {
    score += hasSubmitFlow ? 20 : -14;
  }

  if (constraints.requiresExistingState) {
    score += hasStateHandling ? 16 : -10;
  }

  if (constraints.avoidsNewForm && !hasFormStructure) {
    score -= 12;
  }

  if (constraints.avoidsNewApiCall && hasSubmitFlow && hasApiUsage) {
    score += 8;
  }

  if (hasFormStructure && hasSubmitFlow && hasStateHandling) {
    score += 12;
  }

  return score;
}

const CONSTRAINT_ENTITY_LEAD_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "each",
  "every",
  "our",
  "your",
  "my",
  "their",
  "its",
  "existing",
  "new",
  "entire",
  "whole",
  "full",
  "same",
  "other",
  "unrelated",
  "any",
  "another",
  "generic",
  "current",
  "original",
  "given",
  "specified",
  "login",
  "sign",
  "up",
  "out",
  "home",
  "main",
  "landing",
  "error",
  "settings",
  "search",
  "create",
  "submit",
  "edit",
  "update",
  "delete",
  "filter",
  "sort",
  "select",
  "client",
  "server",
  "side",
  "web",
  "mobile",
  "add",
  "use",
  "using",
  "apply",
  "build",
  "make",
  "get",
  "set",
  "empty",
  "blank",
  "single",
  "multi",
  "related",
  "only",
  "first",
  "last",
  "next",
  "previous",
]);

function normalizeConstrainedTaskText(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Lead words before page/form/… must not become entity anchors (instruction / meta noise). */
const CONSTRAINT_ENTITY_EXTRACTED_ANCHOR_STOPWORDS = new Set([
  "e2e",
  "random",
  "task",
  "goal",
  "form",
  "create",
  "add",
  "modify",
  "existing",
  "file",
  "page",
  "component",
  "logic",
]);

function extractConstrainedTaskEntityAnchors(normalizedTask: string): string[] {
  const patterns = [
    /\b([a-z][a-z0-9]+)\s+page\b/g,
    /\b([a-z][a-z0-9]+)\s+form\b/g,
    /\b([a-z][a-z0-9]+)\s+component\b/g,
    /\b([a-z][a-z0-9]+)\s+screen\b/g,
    /\b([a-z][a-z0-9]+)\s+view\b/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(normalizedTask)) !== null) {
      const word = match[1];
      if (word && !CONSTRAINT_ENTITY_LEAD_STOPWORDS.has(word)) {
        found.push(word);
      }
    }
  }
  const unique = [...new Set(found.map((word) => word.toLowerCase()))];
  return unique.filter(
    (word) =>
      word.length >= 4 &&
      !CONSTRAINT_ENTITY_EXTRACTED_ANCHOR_STOPWORDS.has(word)
  );
}

function escapeRegExpChars(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ConstrainedEntitySource = "path" | "content" | "none";

function splitIdentifierTokens(identifier: string): string[] {
  const raw = identifier.trim();
  if (!raw) {
    return [];
  }
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2");
  return spaced
    .split(/[^a-zA-Z0-9]+/g)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

const PATH_ENTITY_COMPOUND_SUFFIXES = [
  "page",
  "pages",
  "form",
  "forms",
  "list",
  "lists",
  "view",
  "views",
  "grid",
  "table",
  "modal",
  "dialog",
  "panel",
  "screen",
  "wizard",
];

function expandGluedLowercaseCompoundTokens(token: string): string[] {
  const lower = token.toLowerCase();
  if (!/^[a-z0-9]+$/.test(lower) || lower.length < 6) {
    return [];
  }
  const out: string[] = [];
  for (const suffix of PATH_ENTITY_COMPOUND_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      out.push(lower.slice(0, -suffix.length));
    }
  }
  return out;
}

function tokenizePathSegmentForEntityMatch(segment: string): string[] {
  const withoutExt = segment.replace(/\.[^/.]+$/, "");
  const tokens = new Set<string>();
  for (const token of splitIdentifierTokens(withoutExt)) {
    tokens.add(token);
    for (const extra of expandGluedLowercaseCompoundTokens(token)) {
      tokens.add(extra);
    }
  }
  for (const part of withoutExt.toLowerCase().split(/[-_]+/g)) {
    if (part.length > 0) {
      tokens.add(part);
      for (const token of splitIdentifierTokens(part)) {
        tokens.add(token);
      }
      for (const extra of expandGluedLowercaseCompoundTokens(part)) {
        tokens.add(extra);
      }
    }
  }
  return [...tokens];
}

function collectPathEntityTokens(filePath: string): string[] {
  const normalizedSlashes = filePath.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/").filter(Boolean);
  const tokens = new Set<string>();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const withoutExt =
      index === segments.length - 1 ? segment.replace(/\.[^/.]+$/, "") : segment;
    for (const token of tokenizePathSegmentForEntityMatch(withoutExt)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function variantsForConstrainedEntityAnchor(anchor: string): string[] {
  const lower = anchor.toLowerCase();
  const variants = new Set<string>([lower]);
  if (lower.length >= 4 && lower.endsWith("s")) {
    variants.add(lower.slice(0, -1));
  } else if (lower.length >= 4 && !lower.endsWith("s")) {
    variants.add(`${lower}s`);
  }
  return [...variants];
}

function pathTokensHitEntityVariants(
  pathTokens: string[],
  entityAnchors: string[]
): boolean {
  if (!Array.isArray(pathTokens) || !Array.isArray(entityAnchors)) {
    return false;
  }

  for (const anchor of entityAnchors) {
    const normalizedAnchor = anchor.toLowerCase();

    for (const token of pathTokens) {
      const normalizedToken = token.toLowerCase();

      // Exact match
      if (normalizedToken === normalizedAnchor) {
        return true;
      }

      // Singular / plural variations
      if (
        normalizedToken === normalizedAnchor + "s" ||
        normalizedToken === normalizedAnchor + "es" ||
        normalizedAnchor === normalizedToken + "s" ||
        normalizedAnchor === normalizedToken + "es"
      ) {
        return true;
      }

      // Partial / contains match
      if (
        normalizedToken.includes(normalizedAnchor) ||
        normalizedAnchor.includes(normalizedToken)
      ) {
        return true;
      }
    }
  }

  return false;
}

function pathAlignsWithConstrainedTaskEntityAnchors(
  filePath: string,
  entityAnchors: string[]
): boolean {
  if (entityAnchors.length === 0) {
    return true;
  }
  const normalizedAnchors = entityAnchors.map((anchor) => anchor.toLowerCase());
  const pathTokens = collectPathEntityTokens(filePath);
  return normalizedAnchors.every((anchor) =>
    pathTokensHitEntityVariants(pathTokens, [anchor])
  );
}

const CONSTRAINED_FALLBACK_RANKED_READ_LIMIT = 12;
const CONSTRAINED_FALLBACK_ENTITY_PATH_CAP = 16;
const CONSTRAINED_FALLBACK_MAX_READ_PATHS = 24;

function buildConstrainedFallbackPathTokensDebug(
  paths: string[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    out[path] = collectPathEntityTokens(path);
  }
  return out;
}

function collectConstrainedFallbackEntityPathCandidates(input: {
  developerContextFiles: RepoFile[];
  entityAnchors: string[];
  rejectedPaths: Set<string>;
}): Array<{ path: string; score: number }> {
  if (input.entityAnchors.length === 0) {
    return [];
  }
  const matches: Array<{ path: string; score: number }> = [];
  const seen = new Set<string>();
  for (const file of input.developerContextFiles) {
    const { path } = file;
    if (input.rejectedPaths.has(path) || seen.has(path)) {
      continue;
    }
    if (
      isIrrelevantDeveloperContextPath(path) ||
      isProtectedDeveloperUiPath(path)
    ) {
      continue;
    }
    if (!pathAlignsWithConstrainedTaskEntityAnchors(path, input.entityAnchors)) {
      continue;
    }
    seen.add(path);
    matches.push({ path, score: 0 });
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return matches.slice(0, CONSTRAINED_FALLBACK_ENTITY_PATH_CAP);
}

function extractLeadingExportedComponentTokens(fileContent: string): string[] {
  const head = fileContent.slice(0, 8000);
  const names: string[] = [];
  const defaultFn = head.match(/export\s+default\s+function\s+(\w+)/);
  if (defaultFn?.[1]) {
    names.push(defaultFn[1]);
  }
  const namedExportFn = head.match(/export\s+function\s+(\w+)/);
  if (namedExportFn?.[1]) {
    names.push(namedExportFn[1]);
  }
  const exportConst = head.match(/export\s+const\s+(\w+)\s*=/);
  if (exportConst?.[1]) {
    names.push(exportConst[1]);
  }
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of splitIdentifierTokens(name)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function stripQuotedJsxStringsForHeadingScan(fragment: string): string {
  return fragment.replace(
    /(["'`])(?:\\.|(?!\1).)*\1/g,
    " "
  );
}

function strictFormHeadingMatchesEntityVariants(
  fileContent: string,
  variants: string[]
): boolean {
  const lower = fileContent.toLowerCase();
  const formIndex = lower.indexOf("<form");
  if (formIndex < 0) {
    return false;
  }
  const closeTag = lower.indexOf("</form>", formIndex);
  const slice =
    closeTag >= 0
      ? fileContent.slice(formIndex, closeTag)
      : fileContent.slice(formIndex, formIndex + 4000);
  const dequoted = stripQuotedJsxStringsForHeadingScan(slice);
  const headingPattern = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  const legendPattern = /<legend[^>]*>([\s\S]*?)<\/legend>/gi;
  const chunks: string[] = [];
  let headingMatch: RegExpExecArray | null = null;
  headingPattern.lastIndex = 0;
  while ((headingMatch = headingPattern.exec(dequoted)) !== null) {
    chunks.push(headingMatch[1]);
  }
  legendPattern.lastIndex = 0;
  while ((headingMatch = legendPattern.exec(dequoted)) !== null) {
    chunks.push(headingMatch[1]);
  }
  return chunks.some((chunk) => {
    const plain = chunk
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return variants.some((variant) => {
      if (variant.length < 3) {
        return false;
      }
      const boundary = new RegExp(
        `\\b${escapeRegExpChars(variant)}s?\\b`,
        "i"
      );
      return boundary.test(plain);
    });
  });
}

function strictSecondaryEntitySignals(
  fileContent: string,
  variants: string[]
): boolean {
  const exportTokens = extractLeadingExportedComponentTokens(fileContent);
  if (pathTokensHitEntityVariants(exportTokens, variants)) {
    return true;
  }
  return strictFormHeadingMatchesEntityVariants(fileContent, variants);
}

function evaluateConstrainedEntityAlignment(input: {
  filePath: string;
  fileContent: string;
  anchors: string[];
}): {
  entityMatch: boolean;
  entitySource: ConstrainedEntitySource;
} {
  if (input.anchors.length === 0) {
    return { entityMatch: true, entitySource: "none" };
  }
  const pathTokens = collectPathEntityTokens(input.filePath);
  let pathHitAll = true;
  let secondaryHitAll = true;
  for (const anchor of input.anchors) {
    const variants = variantsForConstrainedEntityAnchor(anchor);
    if (!pathTokensHitEntityVariants(pathTokens, [anchor])) {
      pathHitAll = false;
    }
    if (!strictSecondaryEntitySignals(input.fileContent, variants)) {
      secondaryHitAll = false;
    }
  }
  const entityMatch = pathHitAll;
  const entitySource: ConstrainedEntitySource = entityMatch
    ? "path"
    : secondaryHitAll
      ? "content"
      : "none";
  return { entityMatch, entitySource };
}

function assessConstrainedTargetEligibility(input: {
  task: string;
  filePath: string;
  fileContent: string;
  topRankedRelevantPath?: string | null;
}): {
  eligible: boolean;
  score: number;
  structureScore: number;
  entityMatch: boolean;
  entitySource: ConstrainedEntitySource;
  reason: string;
  topRankedEntityMatch: boolean;
  overrideReason: string | null;
  pathTokens: string[];
  entityAnchors: string[];
} {
  const normalizedTask = normalizeConstrainedTaskText(input.task);
  const entityAnchors = extractConstrainedTaskEntityAnchors(normalizedTask);
  const pathTokens = collectPathEntityTokens(input.filePath);
  const structureScore = scoreConstraintAwareContextFile({
    task: input.task,
    content: input.fileContent,
  });
  const structureOk = structureScore >= 20;
  const { entityMatch, entitySource } = evaluateConstrainedEntityAlignment({
    filePath: input.filePath,
    fileContent: input.fileContent,
    anchors: entityAnchors,
  });

  const topRankedPath =
    typeof input.topRankedRelevantPath === "string" &&
    input.topRankedRelevantPath.length > 0
      ? input.topRankedRelevantPath
      : null;
  const topRankedEntityMatch =
    topRankedPath !== null &&
    topRankedPath === input.filePath &&
    entityAnchors.length > 0 &&
    entityMatch &&
    !isProtectedDeveloperUiPath(input.filePath) &&
    !isConstrainedGenericShellPatchPath(input.filePath);

  if (!structureOk) {
    if (topRankedEntityMatch) {
      return {
        eligible: true,
        score: structureScore,
        structureScore,
        entityMatch: true,
        entitySource: "path",
        reason: "top_ranked_entity_target_preview",
        topRankedEntityMatch: true,
        overrideReason: "top_ranked_entity_target_preview",
        pathTokens,
        entityAnchors,
      };
    }
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch,
      entitySource,
      reason: "target_file_constraint_mismatch",
      topRankedEntityMatch,
      overrideReason: null,
      pathTokens,
      entityAnchors,
    };
  }

  if (!entityMatch) {
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch: false,
      entitySource,
      reason: "target_entity_mismatch",
      topRankedEntityMatch,
      overrideReason: null,
      pathTokens,
      entityAnchors,
    };
  }

  return {
    eligible: true,
    score: structureScore,
    structureScore,
    entityMatch: true,
    entitySource,
    reason: "constraint_structure_ok",
    topRankedEntityMatch,
    overrideReason: null,
    pathTokens,
    entityAnchors,
  };
}

const CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS = new Set([
  "target_entity_mismatch",
  "target_file_constraint_mismatch",
]);

function isProtectedDeveloperUiPath(patchPath: string): boolean {
  return patchPath.startsWith("src/ui/") || patchPath === "src/ui/index.html";
}

const CONSTRAINED_GENERIC_SHELL_BASENAMES = new Set([
  "app.jsx",
  "app.tsx",
  "app.js",
  "app.ts",
  "index.jsx",
  "index.tsx",
  "index.js",
  "index.ts",
  "layout.jsx",
  "layout.tsx",
  "layout.js",
  "layout.ts",
]);

function isConstrainedGenericShellPatchPath(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return CONSTRAINED_GENERIC_SHELL_BASENAMES.has(base);
}

async function loadDeveloperModifyPatchSourceContent(input: {
  patchPath: string;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
  hostedForceLoadedContent?: ReadonlyMap<string, string>;
}): Promise<
  | { ok: true; content: string }
  | { ok: false; reason: "missing_hosted_context" }
> {
  const forced = input.hostedForceLoadedContent?.get(input.patchPath);
  const hostedOriginalContent =
    input.hostedContext &&
    Object.prototype.hasOwnProperty.call(
      input.hostedContext.originalContents,
      input.patchPath
    )
      ? input.hostedContext.originalContents[input.patchPath] ?? ""
      : undefined;
  const hostedContextFileContent =
    input.hostedContext?.contextFiles.find((file) => file.path === input.patchPath)
      ?.content;

  if (typeof forced === "string") {
    return { ok: true, content: forced };
  }

  if (
    input.hostedContext &&
    typeof hostedOriginalContent === "undefined" &&
    typeof hostedContextFileContent === "undefined"
  ) {
    const repoFile = input.allFiles.find((f) => f.path === input.patchPath);
    const abs = repoFile?.absolutePath;
    if (typeof abs === "string" && abs.length > 0 && abs !== input.patchPath) {
      const disk = await readProjectFiles([abs]);
      const fromDisk = disk[abs];
      if (typeof fromDisk === "string" && fromDisk.length > 0) {
        return { ok: true, content: fromDisk };
      }
    }
    return { ok: false, reason: "missing_hosted_context" };
  }

  const repoFile = input.allFiles.find((f) => f.path === input.patchPath);
  const absolutePath = repoFile?.absolutePath;

  const content = input.hostedContext
    ? hostedOriginalContent ?? hostedContextFileContent ?? ""
    : absolutePath !== undefined
      ? ((await readProjectFiles([absolutePath]))[absolutePath] ?? "")
      : "";
  return { ok: true, content };
}

async function buildConstrainedFallbackContentByPath(input: {
  resolvedFileContexts: Array<{ path: string; content: string }>;
  selectedContextFiles: Array<{ path: string }>;
  rankedCandidates: Array<{ path: string; score: number }>;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const file of input.resolvedFileContexts) {
    map.set(file.path, file.content);
  }
  if (input.hostedContext) {
    for (const file of input.hostedContext.contextFiles) {
      map.set(file.path, file.content);
    }
    for (const [pathKey, value] of Object.entries(
      input.hostedContext.originalContents
    )) {
      if (!map.has(pathKey)) {
        map.set(pathKey, value ?? "");
      }
    }
  }

  async function ensureRepoPathLoaded(path: string): Promise<void> {
    if (
      map.has(path) ||
      isIrrelevantDeveloperContextPath(path) ||
      isProtectedDeveloperUiPath(path)
    ) {
      return;
    }
    const absolutePath = input.allFiles.find((file) => file.path === path)
      ?.absolutePath;
    if (typeof absolutePath !== "string") {
      return;
    }
    const contents = await readProjectFiles([absolutePath]);
    map.set(path, contents[absolutePath] ?? "");
  }

  for (const entry of input.selectedContextFiles) {
    await ensureRepoPathLoaded(entry.path);
  }

  for (const ranked of input.rankedCandidates) {
    await ensureRepoPathLoaded(ranked.path);
  }

  return map;
}

function buildConstrainedSyntheticModifyPatch(filePath: string): PatchPreviewItem {
  return {
    path: filePath,
    operation: "modify",
    summary:
      "Constrained localized task fallback after preview target eligibility rejection",
    targetHint: "constrained_fallback_target",
    contentPreview: "",
  };
}

type ConstrainedFallbackPickResult =
  | {
      ok: true;
      path: string;
      content: string;
      rankScore: number;
      candidatesChecked: number;
      rejectedCandidates: Array<{ path: string; reason: string; score: number }>;
    }
  | {
      ok: false;
      candidatesChecked: number;
      rejectedCandidates: Array<{ path: string; reason: string; score: number }>;
    };

function pickConstrainedDeveloperApplyTargetFallback(input: {
  task: string;
  rejectedPaths: Set<string>;
  contentByPath: Map<string, string>;
  relevantFileScores: Map<string, number>;
}): ConstrainedFallbackPickResult {
  const rejectedCandidates: Array<{ path: string; reason: string; score: number }> =
    [];
  const entries = [...input.contentByPath.entries()].filter(
    ([path]) =>
      !input.rejectedPaths.has(path) &&
      !isIrrelevantDeveloperContextPath(path) &&
      !isProtectedDeveloperUiPath(path)
  );
  entries.sort(
    (a, b) =>
      (input.relevantFileScores.get(b[0]) ?? 0) -
        (input.relevantFileScores.get(a[0]) ?? 0) || a[0].localeCompare(b[0])
  );

  const eligible: Array<{
    path: string;
    content: string;
    rankScore: number;
  }> = [];
  for (const [path, content] of entries) {
    const eligibility = assessConstrainedTargetEligibility({
      task: input.task,
      filePath: path,
      fileContent: content,
    });
    if (!eligibility.eligible) {
      rejectedCandidates.push({
        path,
        reason: eligibility.reason,
        score: eligibility.structureScore,
      });
      continue;
    }
    eligible.push({
      path,
      content,
      rankScore: input.relevantFileScores.get(path) ?? 0,
    });
  }

  const candidatesChecked = entries.length;
  if (eligible.length === 0) {
    return { ok: false, candidatesChecked, rejectedCandidates };
  }
  eligible.sort((a, b) => {
    if (b.rankScore !== a.rankScore) {
      return b.rankScore - a.rankScore;
    }
    return a.path.localeCompare(b.path);
  });
  const best = eligible[0];
  return {
    ok: true,
    path: best.path,
    content: best.content,
    rankScore: best.rankScore,
    candidatesChecked,
    rejectedCandidates,
  };
}

function hasSensitiveLogging(content: string): boolean {
  const loggingCalls = [
    ...content.matchAll(
      /\b(?:console\.(?:log|info|debug|warn|error)|logger\.\w+)\s*\(([\s\S]*?)\)/gi
    ),
  ];

  return loggingCalls.some((match) =>
    /\b(password|secret|token|key|credential|credentials|auth|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\b/i.test(
      match[1] ?? ""
    )
  );
}

function introducesNewEmptyCatch(
  originalContent: string,
  fullContent: string
): boolean {
  const emptyCatchPattern =
    /catch\s*(?:\(\s*[^)]*\s*\))?\s*\{\s*(?:(?:\/\*\s*ignored\s*\*\/)|(?:\/\/\s*ignored)|(?:\/\*\s*\*\/)|\s*)\}/gi;
  const originalMatches = originalContent.match(emptyCatchPattern)?.length ?? 0;
  const nextMatches = fullContent.match(emptyCatchPattern)?.length ?? 0;
  return nextMatches > originalMatches;
}

function removesValidationOrGuards(
  originalContent: string,
  fullContent: string,
  diffLines?: string[]
): boolean {
  const originalStripped = stripCommentsForComparison(originalContent)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const fullStripped = stripCommentsForComparison(fullContent)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (originalStripped === fullStripped) {
    return false;
  }

  const originalWithoutComments = stripCommentsForComparison(originalContent);
  const nextWithoutComments = stripCommentsForComparison(fullContent);
  const patterns = [
    /\bvalidate[A-Za-z0-9_]*\b/g,
    /\bsanitize[A-Za-z0-9_]*\b/g,
    /\bassert[A-Za-z0-9_]*\b/g,
    /\bcheck[A-Za-z0-9_]*\b/g,
    /\bguard[A-Za-z0-9_]*\b/g,
    /\bthrow\s+new\s+Error\b/g,
    /\bif\s*\(!/g,
  ];

  if ((diffLines?.length ?? 0) > 0) {
    const removedLines = (diffLines ?? [])
      .filter((line) => line.startsWith("-") && !line.startsWith("--"))
      .map((line) => stripCommentsForComparison(line.slice(1)));

    return patterns.some((pattern) => {
      pattern.lastIndex = 0;
      const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
      pattern.lastIndex = 0;
      const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
      pattern.lastIndex = 0;
      const removedByDiff = removedLines.some((line) => {
        pattern.lastIndex = 0;
        return pattern.test(line);
      });
      pattern.lastIndex = 0;
      return beforeCount > 0 && afterCount < beforeCount && removedByDiff;
    });
  }

  return patterns.some((pattern) => {
    const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
    const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
    return beforeCount > 0 && afterCount < beforeCount;
  });
}

function weakensAuthChecks(originalContent: string, fullContent: string): boolean {
  const authPatterns = [
    /\bisAuthenticated\b/g,
    /\brequiresAuth\b/g,
    /@AuthGuard\b/g,
    /\bhasRole\b/g,
    /\bisAdmin\b/g,
  ];
  const bypassPatterns = [
    /\bif\s*\(\s*true\s*\)/g,
    /\breturn\s+true\s*;/g,
    /\bskip\s+auth\b/gi,
    /\bbypass\s+auth\b/gi,
  ];

  const originalWithoutComments = stripCommentsForComparison(originalContent);
  const nextWithoutComments = stripCommentsForComparison(fullContent);
  const removedAuthCheck = authPatterns.some((pattern) => {
    const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
    const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
    return beforeCount > 0 && afterCount < beforeCount;
  });

  if (removedAuthCheck) {
    return true;
  }

  return bypassPatterns.some((pattern) => pattern.test(nextWithoutComments));
}

export function validateDeveloperOutput(input: {
  task: string;
  filePath: string;
  fullContent: string;
  originalContent: string;
  diffLines?: string[];
}): {
  blocked: boolean;
  warnings: string[];
  confidencePenalty: number;
} {
  const computedDiffLines = computeFileDiff(
    input.originalContent,
    input.fullContent
  ).map(
    (line) =>
      `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
  );
  const totalRemovedLines = computedDiffLines.filter((l) =>
    l.startsWith("-")
  ).length;
  const totalAddedLines = computedDiffLines.filter((l) =>
    l.startsWith("+")
  ).length;
  const totalOriginalLines = input.originalContent.split("\n").length;
  const isFullFileRewrite =
    totalRemovedLines > totalOriginalLines * 0.5 &&
    totalAddedLines > totalOriginalLines * 0.3;
  const addedDiffLines = computedDiffLines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
  const hasRemovedDiffLines = computedDiffLines.some((line) =>
    line.startsWith("-")
  );
  if (
    addedDiffLines.length > 0 &&
    !hasRemovedDiffLines &&
    addedDiffLines.every((line) => /^(?:\/\/|\/\*|\*)/.test(line))
  ) {
    return {
      blocked: false,
      warnings: [],
      confidencePenalty: 0,
    };
  }

  const warnings: string[] = [];
  let blocked = false;
  let confidencePenalty = 0;

  if (hasSensitiveLogging(input.fullContent)) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled."
    );
  }

  if (
    !isFullFileRewrite &&
    removesValidationOrGuards(
      input.originalContent,
      input.fullContent,
      input.diffLines
    )
  ) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards."
    );
  }

  if (
    !isFullFileRewrite &&
    weakensAuthChecks(input.originalContent, input.fullContent)
  ) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization."
    );
  }

  if (introducesNewEmptyCatch(input.originalContent, input.fullContent)) {
    warnings.push(
      "[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks."
    );
    confidencePenalty += 20;
  }

  const originalNormalized = normalizeWhitespace(input.originalContent);
  const nextNormalized = normalizeWhitespace(input.fullContent);
  const originalWithoutCommentLines = normalizeWhitespace(
    stripCommentOnlyLines(input.originalContent)
  );
  const nextWithoutCommentLines = normalizeWhitespace(
    stripCommentOnlyLines(input.fullContent)
  );
  const originalWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.originalContent)
  );
  const nextWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.fullContent)
  );
  if (
    originalWithoutCommentLines === nextWithoutCommentLines ||
    originalNormalized === nextNormalized ||
    originalWithoutComments === nextWithoutComments
  ) {
    warnings.push("[DEVELOPER_FILLER_PATCH] No meaningful changes detected.");
    confidencePenalty += 30;
  }

  const totalLines = countTotalLines(input.originalContent || input.fullContent);
  const changedLines = countChangedLines(input.originalContent, input.fullContent);
  if (totalLines > 50 && changedLines / Math.max(totalLines, 1) > 0.6) {
    warnings.push(
      "[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file."
    );
    confidencePenalty += 25;
  }

  return {
    blocked,
    warnings,
    confidencePenalty: Math.min(confidencePenalty, 100),
  };
}

export function isVagueDeveloperTask(task: string): boolean {
  const normalizedTask = task.trim().toLowerCase().replace(/\s+/g, " ");
  const words = normalizedTask.split(/\s+/).filter(Boolean);
  if (DEVELOPER_GENERIC_TASK_PHRASES.has(normalizedTask)) return true;
  if (VAGUE_COMBINATIONS.some((pattern) => pattern.test(task.trim()))) {
    return true;
  }

  const tokens = normalizedTask
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

  if (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        DEVELOPER_GENERIC_TASK_TOKENS.has(token) ||
        DEVELOPER_TASK_STOPWORDS.has(token)
    )
  ) {
    return true;
  }

  const hasSpecificTarget = tokens.some(
    (token) =>
      token.length >= 3 &&
      !DEVELOPER_GENERIC_TASK_TOKENS.has(token) &&
      !DEVELOPER_TASK_STOPWORDS.has(token)
  );

  if (words.length < 4 && !hasSpecificTarget) {
    return true;
  }

  return !hasSpecificTarget;
}

/**
 * High-precision greeting/gratitude detector — separate from isVagueDeveloperTask.
 * Only matches explicit chitchat tokens; false negatives ("hi there") are low-harm
 * (they get the clarification ask instead of a greeting, which is acceptable).
 * @internal exported for unit testing only
 */
const CHITCHAT_TOKENS = new Set([
  "hi", "hello", "hey", "yo", "sup", "howdy", "greetings", "salutations",
  "thanks", "thank", "thankyou", "cheers", "you",
  "good", "morning", "afternoon", "evening", "night",
  "bye", "goodbye", "cya", "later",
]);
export function isChitchat(task: string): boolean {
  const words = task.trim().toLowerCase().replace(/[!?.]+$/g, "").split(/\s+/);
  return words.length <= 4 && words.every(w => CHITCHAT_TOKENS.has(w));
}

const FAREWELL_TOKENS = new Set(["bye", "goodbye", "cya", "later"]);
const GRATITUDE_TOKENS = new Set(["thanks", "thank", "thankyou", "cheers", "you"]);

/**
 * Categorizes a chitchat input. Priority: farewell > gratitude > greeting.
 * Safe to call on non-chitchat inputs — defaults to "greeting".
 * @internal exported for unit testing only
 */
export function classifyChitchat(task: string): "greeting" | "gratitude" | "farewell" {
  const words = task.trim().toLowerCase().replace(/[!?.]+$/g, "").split(/\s+/);
  if (words.some(w => FAREWELL_TOKENS.has(w))) return "farewell";
  if (words.some(w => GRATITUDE_TOKENS.has(w))) return "gratitude";
  return "greeting";
}

function isHiddenDeveloperWarning(warning: string): boolean {
  return (
    warning.startsWith("[DEVELOPER_EMPTY_CATCH]") ||
    warning.startsWith("[DEVELOPER_FILLER_PATCH]") ||
    warning.startsWith("[DEVELOPER_MASS_CHANGE]")
  );
}

export function filterVisibleDeveloperWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !isHiddenDeveloperWarning(warning));
}

function hasDeveloperWarning(
  warnings: string[],
  code:
    | "[DEVELOPER_EMPTY_CATCH]"
    | "[DEVELOPER_FILLER_PATCH]"
    | "[DEVELOPER_MASS_CHANGE]"
): boolean {
  return warnings.some((warning) => warning.startsWith(code));
}

export function calculateDeveloperConfidence(input: {
  baseConfidence?: number;
  warnings: string[];
  changedFileCount: number;
  changedFileMetrics: Array<{ totalLines: number; changedLines: number }>;
  vagueTask: boolean;
}): number {
  let totalPenalty = 0;

  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_MASS_CHANGE]")) {
    totalPenalty += 10;
  }
  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_EMPTY_CATCH]")) {
    totalPenalty += 10;
  }
  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_FILLER_PATCH]")) {
    totalPenalty += 15;
  }

  for (const metric of input.changedFileMetrics) {
    if (
      metric.totalLines > 200 &&
      metric.changedLines / Math.max(metric.totalLines, 1) > 0.4
    ) {
      totalPenalty += 10;
    }
  }

  if (input.changedFileCount > 2) {
    totalPenalty += (input.changedFileCount - 2) * 5;
  }

  let confidence = Math.max(
    0,
    Math.min(input.baseConfidence ?? 95, 95 - totalPenalty)
  );

  if (input.vagueTask) {
    confidence = Math.min(confidence, 60);
  }

  return confidence;
}

export type DeveloperPatchScope = {
  changedFileCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  totalChangedLines: number;
  rewriteLikeSuspicion: boolean;
  cssRewriteSuspicion: boolean;
};

type TaskRiskResult = ReturnType<typeof computeRiskScore>;

const REWRITE_SUSPICION_MIN_TOTAL_LINES = 20;
const REWRITE_SUSPICION_MIN_CHANGED_LINES = 20;

function logRiskDebug(label: string, payload: Record<string, unknown>): void {
  debugLog(`[zone-debug] ${label}: ${JSON.stringify(payload)}`);
}

export function analyzePatchScope(input: {
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  originalContents: Record<string, string>;
}): DeveloperPatchScope {
  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  let rewriteLikeSuspicion = false;
  let cssRewriteSuspicion = false;

  for (const patch of input.applyPatches) {
    const before = input.originalContents[patch.filePath] ?? "";
    const diff = computeFileDiff(before, patch.fullContent);
    const addedLines = diff.filter((line) => line.type === "added").length;
    const removedLines = diff.filter((line) => line.type === "removed").length;
    const changedLines = addedLines + removedLines;
    const totalLines = countTotalLines(before || patch.fullContent);
    const changedRatio = changedLines / Math.max(totalLines, 1);

    totalAddedLines += addedLines;
    totalRemovedLines += removedLines;

    if (
      before.trim() &&
      totalLines >= REWRITE_SUSPICION_MIN_TOTAL_LINES &&
      changedLines >= REWRITE_SUSPICION_MIN_CHANGED_LINES &&
      changedRatio > 0.6
    ) {
      rewriteLikeSuspicion = true;
    }

    if (
      patch.filePath.toLowerCase().endsWith(".css") &&
      before.trim() &&
      totalLines > 0 &&
      (changedLines > 30 || changedRatio > 0.45)
    ) {
      cssRewriteSuspicion = true;
    }
  }

  return {
    changedFileCount: input.applyPatches.length,
    totalAddedLines,
    totalRemovedLines,
    totalChangedLines: totalAddedLines + totalRemovedLines,
    rewriteLikeSuspicion,
    cssRewriteSuspicion,
  };
}

function isSmallLocalizedPatchScope(patchScope: DeveloperPatchScope): boolean {
  return (
    patchScope.changedFileCount <= 1 &&
    patchScope.totalChangedLines <= 20 &&
    !patchScope.rewriteLikeSuspicion &&
    !patchScope.cssRewriteSuspicion
  );
}

function isConstrainedTaskByText(task: string): boolean {
  const t = task.toLowerCase();
  return (
    t.includes("minimal") ||
    t.includes("existing") ||
    t.includes("do not create") ||
    t.includes("reuse") ||
    t.includes("no rewrite")
  );
}

/** Constrained / micro-edit tasks must not ship huge rewrites as a normal safe patch. */
function assessConstrainedTaskLargeRewrite(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): { flagged: boolean; blockApply: boolean } {
  const constrained = isConstrainedLocalizedPatchTask(input.task);
  const microMinimal = detectMicroEditIntent(input.task);
  if (!constrained && !microMinimal) {
    return { flagged: false, blockApply: false };
  }
  const ps = input.patchScope;
  const removedHeavierThanAdded =
    ps.totalRemovedLines > ps.totalAddedLines + 50 &&
    ps.totalRemovedLines > 100;
  const flagged =
    ps.rewriteLikeSuspicion ||
    ps.totalChangedLines > 80 ||
    removedHeavierThanAdded;

  if (!flagged) {
    return { flagged: false, blockApply: false };
  }

  // Hard-block auto-apply only for constrained localized tasks (not micro-edit-only polish).
  const blockApply =
    constrained &&
    (ps.totalChangedLines > 80 ||
      ps.rewriteLikeSuspicion ||
      (ps.totalRemovedLines > ps.totalAddedLines * 1.5 &&
        ps.totalChangedLines > 100));

  return { flagged: true, blockApply };
}

function softenTaskRiskForLocalizedPatch(input: {
  taskRiskResult: TaskRiskResult;
  patchScope: DeveloperPatchScope;
}): TaskRiskResult {
  const { taskRiskResult, patchScope } = input;
  const nonCriticalSignals = taskRiskResult.signals.filter(
    (signal) => signal !== "critical_domain" && signal !== "low_risk"
  );

  if (
    !isSmallLocalizedPatchScope(patchScope) ||
    nonCriticalSignals.length > 0 ||
    !taskRiskResult.signals.includes("critical_domain")
  ) {
    return taskRiskResult;
  }

  return {
    ...taskRiskResult,
    score: Math.min(taskRiskResult.score, 20),
  };
}

function formatDeveloperRiskSignals(input: {
  breakdown: {
    destructive: number;
    schema: number;
    massScope: number;
  };
}): string[] {
  const signals: string[] = [];

  if (input.breakdown.destructive > 0) signals.push("destructive");
  if (input.breakdown.schema > 0) signals.push("schema");
  if (input.breakdown.massScope > 0) signals.push("mass_scope");

  return signals;
}

function syncDeveloperRiskWarnings(input: {
  warnings: string[];
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
}): string[] {
  const withoutTaskRiskWarnings = input.warnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score") &&
      !warning.startsWith("[HIGH_RISK] Risk signals detected:") &&
      !warning.startsWith("[ELEVATED_RISK] Risk signals detected:")
  );

  const riskSignals = formatDeveloperRiskSignals({
    breakdown: input.developerRisk.breakdown,
  });

  if (riskSignals.length === 0) {
    return withoutTaskRiskWarnings;
  }

  if (input.developerRisk.score >= 71) {
    return [
      ...withoutTaskRiskWarnings,
      `[HIGH_RISK] Risk signals detected: ${riskSignals.join(
        ", "
      )}. Review carefully before applying.`,
    ];
  }

  if (input.developerRisk.score >= 31) {
    return [
      ...withoutTaskRiskWarnings,
      `[ELEVATED_RISK] Risk signals detected: ${riskSignals.join(", ")}.`,
    ];
  }

  return withoutTaskRiskWarnings;
}

const SMALL_SAFE_PATCH_MAX_CHANGED_LINES = 20;
const SMALL_SAFE_PATCH_RISK_CAP = 25;

function qualifiesForSafePatchRiskCap(input: {
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
  patchScope: DeveloperPatchScope;
  hasIntentMismatch: boolean;
  hasMicroEditViolation: boolean;
  hasValidationBlock: boolean;
}): boolean {
  return (
    input.developerRisk.breakdown.destructive === 0 &&
    input.developerRisk.breakdown.schema === 0 &&
    input.developerRisk.breakdown.massScope === 0 &&
    input.patchScope.changedFileCount <= 1 &&
    input.patchScope.totalChangedLines <= SMALL_SAFE_PATCH_MAX_CHANGED_LINES &&
    !input.patchScope.rewriteLikeSuspicion &&
    !input.patchScope.cssRewriteSuspicion &&
    !input.hasIntentMismatch &&
    !input.hasMicroEditViolation &&
    !input.hasValidationBlock
  );
}

function applySafePatchRiskCap(input: {
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
  patchScope: DeveloperPatchScope;
  hasIntentMismatch: boolean;
  hasMicroEditViolation: boolean;
  hasValidationBlock: boolean;
}): number {
  if (!qualifiesForSafePatchRiskCap(input)) {
    return input.developerRisk.score;
  }

  return Math.min(input.developerRisk.score, SMALL_SAFE_PATCH_RISK_CAP);
}

function collectAddedPatchLines(input: {
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  originalContents: Record<string, string>;
}): string[] {
  return input.applyPatches.flatMap((patch) => {
    const before = input.originalContents[patch.filePath] ?? "";
    return computeFileDiff(before, patch.fullContent)
      .filter((line) => line.type === "added")
      .map((line) => line.content);
  });
}

export function evaluateIntentPatchMismatch(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): {
  suspicious: boolean;
  confidenceCap?: number;
  warnings: string[];
  risk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
      };
    };
  } {
  const mismatch = detectIntentMismatch({
    taskIntent: detectMicroEditIntent(input.task) ? "micro_edit" : "standard",
    patchScope: input.patchScope,
  });

  if (!mismatch.hasMismatch) {
      return {
        suspicious: false,
        warnings: [],
      risk: {
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
        },
      };
    }

    let massScope = 35;
    if (input.patchScope.changedFileCount > 1) {
    massScope = Math.max(massScope, 45);
  }
  if (input.patchScope.totalChangedLines > 30) {
    massScope = Math.max(massScope, 55);
  }
  if (input.patchScope.cssRewriteSuspicion) {
    massScope = Math.max(massScope, 60);
  }
  if (input.patchScope.rewriteLikeSuspicion) {
      massScope = Math.max(massScope, 65);
    }

    return {
      suspicious: true,
      confidenceCap: mismatch.confidenceCap,
      warnings: mismatch.warnings,
      risk: {
        score: massScope,
        breakdown: {
        destructive: 0,
        schema: 0,
        massScope,
      },
    },
  };
}

export function evaluateUiMappingRisk(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): {
  applies: boolean;
  confidenceCap?: number;
  forcePreviewOnly: boolean;
  warnings: string[];
  risk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
} {
  if (!detectUiMappingRiskIntent(input.task)) {
    return {
      applies: false,
      forcePreviewOnly: false,
      warnings: [],
      risk: {
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      },
    };
  }

  const massScope =
    input.patchScope.changedFileCount > 1 ||
    input.patchScope.totalChangedLines > 40 ||
    input.patchScope.rewriteLikeSuspicion
      ? 45
      : 25;

  return {
    applies: true,
    confidenceCap: 70,
    forcePreviewOnly: massScope >= 40,
    warnings: [
      "UI mapping/order changes are higher-risk and should be reviewed carefully.",
    ],
    risk: {
      score: massScope,
      breakdown: {
        destructive: 0,
        schema: 0,
        massScope,
      },
    },
  };
}

export function normalizeLineForMatch(line: string): string {
  return line.replace(/\t/g, "  ").replace(/\s+/g, " ").trim();
}

function buildTrigrams(value: string): string[] {
  if (value.length < 3) {
    return value ? [value] : [];
  }

  const trigrams: string[] = [];
  for (let i = 0; i <= value.length - 3; i += 1) {
    trigrams.push(value.slice(i, i + 3));
  }
  return trigrams;
}

export function scoreLineSimilarity(a: string, b: string): number {
  const left = normalizeLineForMatch(a);
  const right = normalizeLineForMatch(b);

  if (!left && !right) {
    return 1;
  }

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    return 0.9;
  }

  const leftTrigrams = buildTrigrams(left);
  const rightTrigrams = buildTrigrams(right);

  if (leftTrigrams.length === 0 || rightTrigrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  for (const trigram of rightTrigrams) {
    rightCounts.set(trigram, (rightCounts.get(trigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const trigram of leftTrigrams) {
    const count = rightCounts.get(trigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      rightCounts.set(trigram, count - 1);
    }
  }

  const score = (2 * intersection) / (leftTrigrams.length + rightTrigrams.length);
  return Math.max(0, score);
}

type FuzzyReplaceResult =
  | {
      success: true;
      content: string;
      score: number;
      bestMatch: string;
    }
  | {
      success: false;
      reason: "low_confidence" | "ambiguous_match" | "not_found";
      score: number;
      bestMatch: string;
    };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (idx <= haystack.length) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) break;
    count += 1;
    idx = next + needle.length;
  }
  return count;
}

function detectPrimaryLineEnding(content: string): "\r\n" | "\n" {
  return /\r\n/.test(content) ? "\r\n" : "\n";
}

function convertReplacementLineEndings(
  replace: string,
  lineEnding: "\r\n" | "\n"
): string {
  if (lineEnding === "\n") {
    return replace.replace(/\r\n/g, "\n");
  }
  // Convert LF-only newlines to CRLF; preserve existing CRLF.
  return replace.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function buildLfNormalizedIndexMap(raw: string): {
  normalized: string;
  /** Maps normalized index -> raw index (start). Length is normalized.length + 1. */
  normToRaw: number[];
} {
  const normToRaw: number[] = [];
  let normalized = "";
  let normPos = 0;
  for (let i = 0; i < raw.length; ) {
    normToRaw[normPos] = i;
    const ch = raw[i] ?? "";
    if (ch === "\r" && raw[i + 1] === "\n") {
      normalized += "\n";
      normPos += 1;
      i += 2;
      continue;
    }
    normalized += ch;
    normPos += 1;
    i += 1;
  }
  normToRaw[normPos] = raw.length;
  return { normalized, normToRaw };
}

function countChangedLinesLocalized(before: string, after: string): number {
  const diff = computeFileDiff(before, after);
  const added = diff.filter((d) => d.type === "added").length;
  const removed = diff.filter((d) => d.type === "removed").length;
  return added + removed;
}

function containsLoneLf(content: string): boolean {
  // Detect '\n' that is not part of '\r\n'
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n" && content[i - 1] !== "\r") return true;
  }
  return false;
}

function containsPatchProtocolMarkers(content: string): boolean {
  return (
    content.includes("--- FIND ---") ||
    content.includes("--- REPLACE ---") ||
    content.includes("--- END ---") ||
    content.includes("--- FILE:") ||
    content.includes("--- FILE ---")
  );
}

function buildLineFrequencyMap(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function scoreLineOverlap(targetLines: string[], candidateLines: string[]): number {
  const targetCounts = buildLineFrequencyMap(targetLines);
  const candidateCounts = buildLineFrequencyMap(candidateLines);
  let overlap = 0;

  for (const [line, targetCount] of targetCounts.entries()) {
    overlap += Math.min(targetCount, candidateCounts.get(line) ?? 0);
  }

  return overlap / Math.max(targetLines.length, candidateLines.length, 1);
}

export function scoreOrderedSimilarity(
  targetLines: string[],
  candidateLines: string[]
): number {
  let bestRatio = 0;

  for (let offset = -3; offset <= 3; offset += 1) {
    let matches = 0;

    for (let i = 0; i < targetLines.length; i += 1) {
      const candidateIndex = i + offset;
      if (candidateIndex < 0 || candidateIndex >= candidateLines.length) {
        continue;
      }

      matches += scoreLineSimilarity(targetLines[i], candidateLines[candidateIndex]);
    }

    const ratio = matches / Math.max(targetLines.length, candidateLines.length, 1);
    if (ratio > bestRatio) {
      bestRatio = ratio;
    }
  }

  return bestRatio;
}

export function scoreCandidateMatch(
  targetLines: string[],
  candidateLines: string[]
): number {
  if (targetLines.length === 0 && candidateLines.length === 0) {
    return 100;
  }

  const orderedScore = scoreOrderedSimilarity(targetLines, candidateLines);
  const overlapScore = scoreLineOverlap(targetLines, candidateLines);
  const lengthPenalty = Math.min(
    Math.abs(targetLines.length - candidateLines.length) * 4,
    12
  );

  return Math.min(
    100,
    Math.max(
      0,
      Math.round(orderedScore * 70 + overlapScore * 30 - lengthPenalty)
    )
  );
}

function buildMicroEditSnippet(filePath: string, content: string, task: string): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const cssTerms = task.match(/[.#]?[\w-]+(?:\s*\{)?/g) || [];
  const colorTerms = task.match(/#[0-9a-fA-F]{3,6}/g) || [];
  const classTerms = task.match(/[\w-]+-btn|[\w-]+-badge|[\w-]+-bar/g) || [];

  const searchTerms = [
    ...new Set(
      [
        ...cssTerms.map((term) => term.replace(/[{}]/g, "").trim()),
        ...colorTerms,
        ...classTerms,
      ].filter((term) => term.length > 2)
    ),
  ];

  let bestLine = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    const score = searchTerms.filter((term) =>
      lineLower.includes(term.toLowerCase())
    ).length;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (bestLine === -1) {
    return lines.slice(0, 30).join("\n");
  }

  const start = Math.max(0, bestLine - 10);
  const end = Math.min(lines.length, bestLine + 11);

  return [
    `// === SNIPPET: ${filePath} lines ${start + 1}-${end} of ${lines.length} ===`,
    ...lines.slice(start, end),
    "// === END SNIPPET ===",
  ].join("\n");
}

type ContextAnchor = {
  lineIndex: number;
  score: number;
};

function isAnchorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  return /^(import\s|const\s+\w+\s*=\s*require\(|.*\sfrom\s+["']|export\s|class\s|interface\s|enum\s|struct\s|async function\s|function\s|def\s|fun\s|\s*(public|private|protected)\s+[\w<>\[\],\s]+\()/.test(
    trimmed
  );
}

function countTaskOverlap(taskWords: string[], line: string): number {
  const normalizedLine = line.toLowerCase();
  return taskWords.filter((word) => normalizedLine.includes(word)).length;
}

export function smartContextWindow(input: {
  fileContent: string;
  task: string;
  maxChars?: number;
}): {
  snippet: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  isTruncated: boolean;
} {
  const maxChars = input.maxChars ?? 6000;
  const lines = input.fileContent.split("\n");
  const totalLines = lines.length;

  if (input.fileContent.length <= maxChars) {
    return {
      snippet: input.fileContent,
      startLine: 1,
      endLine: totalLines,
      totalLines,
      isTruncated: false,
    };
  }

  const taskWords = [...new Set(
    input.task
      .toLowerCase()
      .split(/[^a-z0-9_#.-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3)
  )];

  const anchorIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isAnchorLine(line))
    .map(({ index }) => index);

  const indexes = anchorIndexes.length > 0 ? anchorIndexes : [0];
  const anchors: ContextAnchor[] = indexes.map((lineIndex) => ({
    lineIndex,
    score: countTaskOverlap(taskWords, lines[lineIndex]),
  }));

  let centerAnchorIndex = 0;
  for (let i = 1; i < anchors.length; i += 1) {
    if (
      anchors[i].score > anchors[centerAnchorIndex].score ||
      (anchors[i].score === anchors[centerAnchorIndex].score &&
        anchors[i].lineIndex < anchors[centerAnchorIndex].lineIndex)
    ) {
      centerAnchorIndex = i;
    }
  }

  const blockRanges = indexes.map((lineIndex, index) => ({
    start: lineIndex,
    end: (indexes[index + 1] ?? totalLines) - 1,
  }));

  let left = centerAnchorIndex;
  let right = centerAnchorIndex;

  const buildSnippet = (startBlock: number, endBlock: number) => {
    const firstTenEnd = Math.min(10, totalLines);
    const mainStart = blockRanges[startBlock].start;
    const mainEnd = blockRanges[endBlock].end + 1;

    const selectedLines = [
      ...lines.slice(0, firstTenEnd),
      ...(mainStart < firstTenEnd ? lines.slice(firstTenEnd, mainEnd) : lines.slice(mainStart, mainEnd)),
    ];

    const startLine = 1;
    const endLine =
      mainStart < firstTenEnd ? mainEnd : Math.max(firstTenEnd, mainEnd);

    return {
      snippet: selectedLines.join("\n"),
      startLine,
      endLine,
    };
  };

  let window = buildSnippet(left, right);

  while (window.snippet.length < maxChars) {
    const canExpandLeft = left > 0;
    const canExpandRight = right < blockRanges.length - 1;

    if (!canExpandLeft && !canExpandRight) {
      break;
    }

    const nextLeftSize = canExpandLeft
      ? buildSnippet(left - 1, right).snippet.length
      : Number.POSITIVE_INFINITY;
    const nextRightSize = canExpandRight
      ? buildSnippet(left, right + 1).snippet.length
      : Number.POSITIVE_INFINITY;

    if (nextLeftSize <= maxChars && nextLeftSize <= nextRightSize) {
      left -= 1;
      window = buildSnippet(left, right);
      continue;
    }

    if (nextRightSize <= maxChars) {
      right += 1;
      window = buildSnippet(left, right);
      continue;
    }

    break;
  }

  return {
    snippet: window.snippet,
    startLine: window.startLine,
    endLine: window.endLine,
    totalLines,
    isTruncated: true,
  };
}

// computeFileDiff moved to src/core/fileDiff.ts; re-exported here for backward compat.
export { computeFileDiff };

export function fuzzyFindAndReplace(
  content: string,
  find: string,
  replace: string
): FuzzyReplaceResult {
  const lineEnding = detectPrimaryLineEnding(content);
  const exactCount = countOccurrences(content, find);
  if (exactCount === 1) {
    return {
      success: true,
      content: content.replace(find, convertReplacementLineEndings(replace, lineEnding)),
      score: 100,
      bestMatch: find,
    };
  }
  if (exactCount > 1) {
    return {
      success: false,
      reason: "ambiguous_match",
      score: 0,
      bestMatch: find,
    };
  }

  const map = buildLfNormalizedIndexMap(content);
  const normalizedFind = find.replace(/\r\n/g, "\n");
  const normalizedReplace = convertReplacementLineEndings(replace, lineEnding);
  const normalizedCount = countOccurrences(map.normalized, normalizedFind);
  if (normalizedCount === 1) {
    const normIdx = map.normalized.indexOf(normalizedFind);
    const rawStart = map.normToRaw[normIdx] ?? 0;
    const rawEnd = map.normToRaw[normIdx + normalizedFind.length] ?? content.length;
    return {
      success: true,
      content: content.slice(0, rawStart) + normalizedReplace + content.slice(rawEnd),
      score: 99,
      bestMatch: map.normalized.slice(normIdx, normIdx + normalizedFind.length),
    };
  }
  if (normalizedCount > 1) {
    return {
      success: false,
      reason: "ambiguous_match",
      score: 0,
      bestMatch: normalizedFind,
    };
  }

  const contentLines = map.normalized.split("\n");
  const targetLinesRaw = normalizedFind.split("\n");
  const targetLines = targetLinesRaw.map(normalizeLineForMatch).filter(Boolean);

  if (targetLines.length === 0) {
    return {
      success: false,
      reason: "low_confidence",
      score: 0,
      bestMatch: "",
    };
  }

  let bestCandidate:
    | {
        start: number;
        length: number;
        score: number;
        bestMatch: string;
      }
    | undefined;

  const minWindow = Math.max(1, targetLines.length - 3);
  const maxWindow = Math.min(contentLines.length, targetLines.length + 3);

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += 1) {
    for (let start = 0; start <= contentLines.length - windowSize; start += 1) {
      const rawSlice = contentLines.slice(start, start + windowSize);
      const normalizedSlice = rawSlice.map(normalizeLineForMatch).filter(Boolean);
      if (normalizedSlice.length === 0) {
        continue;
      }

      const score = scoreCandidateMatch(targetLines, normalizedSlice);
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          start,
          length: windowSize,
          score,
          bestMatch: rawSlice.join("\n"),
        };
      }
    }
  }

  if (!bestCandidate || bestCandidate.score < 80) {
    return {
      success: false,
      reason: "low_confidence",
      score: bestCandidate?.score ?? 0,
      bestMatch: bestCandidate?.bestMatch ?? "",
    };
  }

  // Apply the best candidate window as a localized replacement on the RAW content using index mapping.
  const lineStartIdx: number[] = [0];
  for (let i = 0; i < map.normalized.length; i += 1) {
    if (map.normalized[i] === "\n") lineStartIdx.push(i + 1);
  }
  const normStart = lineStartIdx[bestCandidate.start] ?? 0;
  const normEnd =
    lineStartIdx[bestCandidate.start + bestCandidate.length] ?? map.normalized.length;
  const rawStart = map.normToRaw[normStart] ?? 0;
  const rawEnd = map.normToRaw[normEnd] ?? content.length;

  return {
    success: true,
    content: content.slice(0, rawStart) + normalizedReplace + content.slice(rawEnd),
    score: bestCandidate.score,
    bestMatch: bestCandidate.bestMatch,
  };
}

export function detectZoneInternalTask(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  if (ZONE_INTERNAL_ZONE_TERMS.some((term) => normalized.includes(term))) {
    return true;
  }

  if (!/\bzone\b/i.test(normalized)) {
    return false;
  }

  return ZONE_INTERNAL_RUNTIME_TERMS.some((term) => normalized.includes(term));
}

function isDeveloperPatchParseStructurallyEmpty(
  parsed: NonNullable<ReturnType<typeof parseDeveloperPatchText>>
): boolean {
  if (parsed.noChangeNeeded) return false;
  if (parsed.createContent !== undefined) return false;
  return parsed.edits.length === 0;
}

function isInstructionLikeFindBlock(find: string): boolean {
  const t = String(find || "").toLowerCase().trim();

  return (
    t.includes("insert this") ||
    t.includes("insert here") ||
    t.includes("where selectedupload is used") ||
    t.includes("usage:") ||
    t.includes("usage example") ||
    t.includes("example:") ||
    t.includes("wrap image preview") ||
    t.includes("guard for") ||
    t.includes("guard:") ||
    t.includes("ensure selectedupload") ||
    t.includes("placeholder") ||
    t.includes("your code here") ||
    t.includes("replace this")
  );
}

function applyDeveloperPatchText(
  currentContent: string,
  rawPatchText: string,
  options?: { filePath?: string }
): { ok: true; fullContent: string } | { ok: false; warning: string } {
  debugLog("[zone-patch-raw]", rawPatchText.slice(0, 1000));
  const trimmedPatch = rawPatchText.trim();
  if (
    trimmedPatch !== "NO_CHANGE_NEEDED" &&
    !rawPatchText.includes("--- FILE:")
  ) {
    console.warn(
      "[zone-patch] rejected patch text without --- FILE: (skipping parse)"
    );
    return {
      ok: false,
      warning:
        "[invalid_patch_format] Model did not return a valid patch structure",
    };
  }
  const parsed = parseDeveloperPatchText(rawPatchText);
  if (!parsed || isDeveloperPatchParseStructurallyEmpty(parsed)) {
    console.warn("[zone-patch] empty parse result");
    return {
      ok: false,
      warning:
        "[invalid_patch_format] Model response could not be parsed into a valid patch",
    };
  }
  debugLog("[zone-patch-protocol-parsed]");

  if (parsed.createContent !== undefined) {
    if (currentContent.trim()) {
      return {
        ok: false,
        warning:
          "[DEVELOPER_PATCH_FORMAT] CREATE blocks are not allowed for existing files.",
      };
    }
    return { ok: true, fullContent: parsed.createContent };
  }

  if (parsed.noChangeNeeded) {
    return { ok: true, fullContent: currentContent };
  }

  let updatedContent = currentContent;
  for (const edit of parsed.edits) {
    const originalLineEnding = detectPrimaryLineEnding(updatedContent);
    const normalizedContent = updatedContent.replace(/\r\n/g, "\n");
    const normalizedFind = edit.find.replace(/\r\n/g, "\n");

    debugLog(
      "[zone-find-debug] FIND block first 200 chars:",
      edit.find.slice(0, 200)
    );
    debugLog(
      "[zone-find-debug] File contains match:",
      normalizedContent.includes(normalizedFind)
    );

    if (!edit.find.trim()) {
      return {
        ok: false,
        warning:
          "[DEVELOPER_PATCH_FORMAT] FIND blocks must target an existing non-empty block.",
      };
    }
    if (isInstructionLikeFindBlock(edit.find)) {
      debugLog("[zone-patch-protocol-leak-blocked]");
      return {
        ok: false,
        warning:
          "[PATCH_PROTOCOL_LEAK] " +
          JSON.stringify({
            reason: "patch_protocol_leak",
            syntheticFindBlock: true,
          }),
      };
    }
    const findLinesNonEmpty = edit.find
      .trim()
      .split("\n")
      .filter((l) => l.trim()).length;
    const replaceLineCount = edit.replace.split("\n").length;
    // If REPLACE preserves FIND verbatim and only appends new lines, treat as a pure addition.
    // In that case, the "anchor too small" heuristic is overly aggressive and can block valid insertions.
    const normalizedFindTrimmed = normalizedFind.trimEnd();
    const normalizedReplace = edit.replace.replace(/\r\n/g, "\n");
    const replacePreservesFind =
      normalizedFindTrimmed.length > 0 &&
      normalizedReplace.startsWith(normalizedFindTrimmed);
    const findLineCountRaw = edit.find.replace(/\r\n/g, "\n").split("\n").length;
    const addedLines = Math.max(0, replaceLineCount - findLineCountRaw);
    const isPureAddition = replacePreservesFind && addedLines > 10;

    if (!isPureAddition && findLinesNonEmpty <= 2 && replaceLineCount > 20) {
      const filePath = options?.filePath ?? "(unknown)";
      debugLog(
        "[zone-anchor-too-small-blocked]",
        JSON.stringify({
          filePath,
          findLines: findLinesNonEmpty,
          replaceLines: replaceLineCount,
          isPureAddition,
          addedLines,
        })
      );
      return {
        ok: false,
        warning:
          "[ANCHOR_TOO_SMALL_FOR_LARGE_REPLACE] " +
          JSON.stringify({
            reason: "anchor_too_small_for_large_replace",
            findLines: findLinesNonEmpty,
            replaceLines: replaceLineCount,
            isPureAddition,
            addedLines,
          }),
      };
    }
    const findCountRaw = countOccurrences(normalizedContent, normalizedFind);
    const lineEnding = originalLineEnding;
    const preservedBefore = lineEnding === "\r\n" ? !containsLoneLf(updatedContent) : true;
    debugLog(
      "[zone-patch-match-count]",
      JSON.stringify({ raw: findCountRaw })
    );

    // CRITICAL correctness guard:
    // If raw match count is 0, we must NOT apply unless LF/CRLF normalization yields exactly one match.
    // We already normalized CRLF→LF above, so this 0-match path is a true miss now.

    const nextContent = fuzzyFindAndReplace(normalizedContent, normalizedFind, edit.replace.replace(/\r\n/g, "\n"));
    if (!nextContent.success) {
      debugLog(
        "[zone-patch-apply-mode]",
        nextContent.reason === "ambiguous_match" ? "failed" : "failed"
      );
      return {
        ok: false,
        warning:
          "[PATCH_FIND_NOT_FOUND] " +
          JSON.stringify({
            success: false,
            reason: nextContent.reason,
            score: nextContent.score,
            bestMatch: nextContent.bestMatch,
          }),
      };
    }
    if (findCountRaw === 0) {
      const changed = countChangedLinesLocalized(updatedContent, nextContent.content);
      if (changed === 0) {
        return {
          ok: false,
          warning:
            "[PATCH_NO_MATCH_ABORT] " +
            JSON.stringify({
              reason: "no_op_or_zero_match",
            }),
        };
      }
    }
    const mode = findCountRaw === 1 ? "exact" : nextContent.score >= 99 ? "exact" : "fuzzy";
    debugLog("[zone-patch-apply-mode]", mode);
    const preservedAfter =
      lineEnding === "\r\n" ? !containsLoneLf(nextContent.content) : true;
    debugLog(
      "[zone-patch-line-ending-preserved]",
      preservedBefore && preservedAfter
    );
    debugLog(
      "[zone-patch-localized-change-lines]",
      countChangedLinesLocalized(updatedContent, nextContent.content)
    );
    if (containsPatchProtocolMarkers(nextContent.content)) {
      debugLog("[zone-patch-protocol-leak-blocked]");
      return {
        ok: false,
        warning:
          "[PATCH_PROTOCOL_LEAK] " +
          JSON.stringify({
            reason: "patch_protocol_leak",
            leakedMarkers: true,
          }),
      };
    }
    updatedContent =
      lineEnding === "\r\n"
        ? nextContent.content.replace(/\n/g, "\r\n")
        : nextContent.content;
  }

  return { ok: true, fullContent: updatedContent };
}

export const __testOnly_applyDeveloperPatchText = applyDeveloperPatchText;

const SAFE_PREVIEW_REUSE_MAX_CHARS = 4000;

function canReusePatchPreviewAsFinalPatch(input: {
  patchCount: number;
  contentPreview: string;
  taskRiskResult: TaskRiskResult;
}): boolean {
  return (
    input.patchCount === 1 &&
    input.taskRiskResult.score === 0 &&
    input.taskRiskResult.breakdown.destructive === 0 &&
    input.taskRiskResult.breakdown.schema === 0 &&
    input.taskRiskResult.breakdown.massScope === 0 &&
    input.contentPreview.trim().length > 0 &&
    input.contentPreview.length <= SAFE_PREVIEW_REUSE_MAX_CHARS
  );
}

function buildApplyPatchFromPreview(input: {
  patch: { operation: "create" | "modify"; contentPreview: string };
  currentContent: string;
}): { ok: true; fullContent: string } | { ok: false } {
  if (input.patch.operation === "create" && !input.currentContent.trim()) {
    return {
      ok: true,
      fullContent: input.patch.contentPreview,
    };
  }

  const applied = applyDeveloperPatchText(
    input.currentContent,
    input.patch.contentPreview
  );
  if (!applied.ok) {
    return { ok: false };
  }

  return applied;
}

function findBalancedBraceBlock(input: {
  content: string;
  openBraceIndex: number;
}): { endExclusive: number } | null {
  const { content, openBraceIndex } = input;
  if (openBraceIndex < 0 || openBraceIndex >= content.length) return null;
  if (content[openBraceIndex] !== "{") return null;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = openBraceIndex; i < content.length; i += 1) {
    const ch = content[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    } else if (inSingle && ch === "'") {
      inSingle = false;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    } else if (inDouble && ch === '"') {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { endExclusive: i + 1 };
      }
    }
  }

  return null;
}

function findSubmitHandlerBlock(fileContent: string): {
  start: number;
  endExclusive: number;
  block: string;
} | null {
  const namedPatterns: Array<{ name: string; re: RegExp }> = [
    {
      name: "const-handleSubmit-arrow",
      re: /\b(const|let|var)\s+handleSubmit\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/i,
    },
    {
      name: "function-handleSubmit",
      re: /\bfunction\s+handleSubmit\s*\([^)]*\)\s*\{/i,
    },
    {
      name: "const-onSubmit-arrow",
      re: /\b(const|let|var)\s+onSubmit\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/i,
    },
    {
      name: "function-onSubmit",
      re: /\bfunction\s+onSubmit\s*\([^)]*\)\s*\{/i,
    },
    {
      name: "const-submitLike-arrow",
      re: /\b(const|let|var)\s+[A-Za-z0-9_]*submit[A-Za-z0-9_]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/i,
    },
    {
      name: "function-submitLike",
      re: /\bfunction\s+[A-Za-z0-9_]*submit[A-Za-z0-9_]*\s*\([^)]*\)\s*\{/i,
    },
  ];

  const extractBlockFromMatch = (
    match: RegExpExecArray,
    patternName: string
  ): { start: number; endExclusive: number; block: string } | null => {
    const matchText = match[0] ?? "";
    const openBraceIndex = fileContent.indexOf(
      "{",
      match.index + Math.max(0, matchText.length - 1)
    );
    if (openBraceIndex < 0) return null;
    const balanced = findBalancedBraceBlock({ content: fileContent, openBraceIndex });
    if (!balanced) return null;
    const start = match.index;
    const endExclusive = balanced.endExclusive;
    const block = fileContent.slice(start, endExclusive);
    debugLog("[zone-fallback-detect] handler matched via pattern:", patternName);
    return { start, endExclusive, block };
  };

  // First pass: explicit named patterns (handleSubmit/onSubmit/etc)
  for (const { name, re } of namedPatterns) {
    const m = re.exec(fileContent);
    if (!m) continue;
    const extracted = extractBlockFromMatch(m, name);
    if (extracted) return extracted;
  }

  // Second pass: heuristic — any function-like block with preventDefault() AND submit/create/save call.
  const genericFunctionStarts: Array<{ name: string; re: RegExp }> = [
    {
      name: "generic-const-arrow",
      re: /\b(const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/gi,
    },
    {
      name: "generic-function",
      re: /\bfunction\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/gi,
    },
  ];
  const submitLikeCall = /\b(submit|create|save)\w*\s*\(/i;
  const preventDefaultCall = /\bpreventDefault\s*\(\s*\)/i;

  let bestHeuristic:
    | { score: number; start: number; endExclusive: number; block: string }
    | null = null;

  for (const { re } of genericFunctionStarts) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(fileContent)) !== null) {
      const matchText = m[0] ?? "";
      const openBraceIndex = fileContent.indexOf(
        "{",
        m.index + Math.max(0, matchText.length - 1)
      );
      if (openBraceIndex < 0) continue;
      const balanced = findBalancedBraceBlock({ content: fileContent, openBraceIndex });
      if (!balanced) continue;

      const start = m.index;
      const endExclusive = balanced.endExclusive;
      const block = fileContent.slice(start, endExclusive);
      const hasPreventDefault = preventDefaultCall.test(block);
      const hasSubmitLike = submitLikeCall.test(block);
      if (!hasPreventDefault || !hasSubmitLike) continue;

      const name = (m[2] ?? m[1] ?? "").toString();
      const nameSuggestsSubmit = /submit|save|create/i.test(name);
      const score =
        (hasPreventDefault ? 10 : 0) +
        (hasSubmitLike ? 6 : 0) +
        (nameSuggestsSubmit ? 2 : 0) +
        Math.max(0, Math.min(2, 2 - Math.floor(block.length / 400)));

      if (!bestHeuristic || score > bestHeuristic.score) {
        bestHeuristic = { score, start, endExclusive, block };
      }
    }
  }

  if (bestHeuristic) {
    debugLog("[zone-fallback-detect] fallback heuristic used");
    return {
      start: bestHeuristic.start,
      endExclusive: bestHeuristic.endExclusive,
      block: bestHeuristic.block,
    };
  }

  debugLog("[zone-fallback-detect] handler NOT found");
  return null;
}

function injectDeterministicValidationIntoSubmitHandler(
  handlerBlock: string
): { replacedBlock: string; insertedAt: "before_submit_call" | "handler_top" } | null {
  const lines = handlerBlock.replace(/\r\n/g, "\n").split("\n");
  const submitLineIndex = lines.findIndex((line) =>
    /\bsubmit[A-Za-z0-9_]*\s*\(/i.test(line)
  );
  const indentFromLine = (line: string): string => {
    const m = line.match(/^\s*/);
    return m ? m[0] : "";
  };

  const validationIndent =
    submitLineIndex >= 0
      ? indentFromLine(lines[submitLineIndex] ?? "")
      : (() => {
          // Prefer indentation of the first non-empty line inside the block.
          const firstInner =
            lines.slice(1).find((l) => l.trim().length > 0) ?? "";
          if (firstInner) return indentFromLine(firstInner);
          // Fallback: base indentation + two spaces.
          return `${indentFromLine(lines[0] ?? "")}  `;
        })();

  const insert = [
    `${validationIndent}if (!fullName || fullName.trim() === "") {`,
    `${validationIndent}  setError("Full name is required");`,
    `${validationIndent}  return;`,
    `${validationIndent}}`,
    "",
    `${validationIndent}if (email && !email.includes("@")) {`,
    `${validationIndent}  setError("Invalid email");`,
    `${validationIndent}  return;`,
    `${validationIndent}}`,
    "",
  ];

  const insertedAt =
    submitLineIndex >= 0 ? ("before_submit_call" as const) : ("handler_top" as const);

  const nextLines =
    submitLineIndex >= 0
      ? [
          ...lines.slice(0, submitLineIndex),
          ...insert,
          ...lines.slice(submitLineIndex),
        ]
      : [lines[0] ?? "", ...insert, ...lines.slice(1)];

  return { replacedBlock: nextLines.join("\n"), insertedAt };
}

function buildDeterministicFallbackPatch(input: {
  filePath: string;
  fileContent: string;
}): { insertIndex: number; validationBlock: string } | null {
  // Normalize at the boundary. All offset math below operates on \n-only content.
  const normalizedContent = input.fileContent.replace(/\r\n/g, "\n");

  const handler = findSubmitHandlerBlock(normalizedContent);
  if (!handler) return null;

  const openBraceIndex = normalizedContent.indexOf("{", handler.start);
  if (openBraceIndex < 0 || openBraceIndex >= handler.endExclusive) {
    return null;
  }

  // Prefer inserting after common reset lines inside the handler.
  // Specifically: after e.preventDefault(); and optional setFormError(""); setSuccess("");
  const handlerBlock = handler.block;
  const handlerLines = handlerBlock.split("\n");
  const findLineIndex = (re: RegExp): number =>
    handlerLines.findIndex((l) => re.test(l));

  const preventIdx = findLineIndex(/\bpreventDefault\s*\(\s*\)\s*;/);
  let insertAfterLineIdx = -1;
  if (preventIdx >= 0) {
    insertAfterLineIdx = preventIdx;
    const formErrorIdx = handlerLines
      .slice(preventIdx + 1, preventIdx + 6)
      .findIndex((l) => /\bsetFormError\s*\(\s*["'`]\s*["'`]\s*\)\s*;/.test(l));
    if (formErrorIdx >= 0) {
      insertAfterLineIdx = preventIdx + 1 + formErrorIdx;
    }
    const successIdx = handlerLines
      .slice(insertAfterLineIdx + 1, insertAfterLineIdx + 6)
      .findIndex((l) => /\bsetSuccess\s*\(\s*["'`]\s*["'`]\s*\)\s*;/.test(l));
    if (successIdx >= 0) {
      insertAfterLineIdx = insertAfterLineIdx + 1 + successIdx;
    }
  }

  // Compute absolute insert position in file content.
  // Default to just after opening brace.
  let insertIndex = openBraceIndex + 1;
  if (insertAfterLineIdx >= 0) {
    const relativeOffset =
      handlerLines
        .slice(0, insertAfterLineIdx + 1)
        .join("\n").length + 1; // newline after the line
    insertIndex = handler.start + relativeOffset;
  }

  const afterInsert = normalizedContent.slice(insertIndex);
  const nextLine = afterInsert.split("\n")[0] ?? "";
  const nextIndent = (nextLine.match(/^\s*/) ?? [""])[0] ?? "";

  const openLineStart = normalizedContent.lastIndexOf("\n", openBraceIndex) + 1;
  const openLine = normalizedContent.slice(openLineStart, openBraceIndex + 1);
  const baseIndent = (openLine.match(/^\s*/) ?? [""])[0] ?? "";
  const indent = nextIndent || `${baseIndent}  `;

  const validationBlock = [
    `${indent}if (!fullName || fullName.trim() === "") {`,
    `${indent}  setError("Full name is required");`,
    `${indent}  return;`,
    `${indent}}`,
    "",
    `${indent}if (email && !email.includes("@")) {`,
    `${indent}  setError("Invalid email");`,
    `${indent}  return;`,
    `${indent}}`,
  ].join("\n");

  return { insertIndex, validationBlock };
}

// Exposed only for deterministic unit tests (no I/O, pure).
export const __testOnly_buildDeterministicFallbackPatch =
  buildDeterministicFallbackPatch;

function detectSuspiciousUiOverwrite(input: {
  task: string;
  filePath: string;
  currentContent: string;
  nextContent: string;
}): string | null {
  if (!isUiFilePath(input.filePath)) return null;
  if (!input.currentContent.trim()) return null;
  if (!isSmallUiPolishTask(input.task)) return null;

  const currentContentNormalized = normalizeUiContent(input.currentContent);
  const nextContentLower = normalizeUiContent(input.nextContent);
  const hasGenericScaffold = GENERIC_UI_SCAFFOLD_PATTERNS.some((pattern) =>
    nextContentLower.includes(pattern)
  );
  const hasGenericDocumentScaffold = GENERIC_DOCUMENT_SCAFFOLD_PATTERNS.some(
    (pattern) => nextContentLower.includes(pattern)
  );
  const introducesFullDocumentSkeleton =
    nextContentLower.includes("<!doctype html") ||
    (nextContentLower.includes("<html") &&
      nextContentLower.includes("<head") &&
      nextContentLower.includes("<body"));
  const currentHasFullDocumentSkeleton =
    currentContentNormalized.includes("<!doctype html") ||
    (currentContentNormalized.includes("<html") &&
      currentContentNormalized.includes("<head") &&
      currentContentNormalized.includes("<body"));

  const currentTokens = extractStructureTokens(input.currentContent);
  const nextTokens = extractStructureTokens(input.nextContent);
  const preservedTokenCount = countPreservedTokens(currentTokens, nextTokens);
  const preservedRatio =
    currentTokens.length > 0 ? preservedTokenCount / currentTokens.length : 1;
  const currentAnchors = extractCriticalAnchors(input.currentContent);
  const preservedAnchorCount = currentAnchors.filter((anchor) =>
    nextContentLower.includes(anchor)
  ).length;
  const preservedAnchorRatio =
    currentAnchors.length > 0 ? preservedAnchorCount / currentAnchors.length : 1;
  const replacementRatio =
    input.currentContent.length > 0
      ? input.nextContent.length / input.currentContent.length
      : 1;
  const broadMarkupRewrite =
    currentContentNormalized.includes("<") &&
    nextContentLower.includes("<") &&
    (replacementRatio > 1.6 || replacementRatio < 0.6);

  if (hasGenericScaffold && preservedRatio < 0.35) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic UI scaffold overwrite instead of a small in-place update.`;
  }

  if (
    hasGenericDocumentScaffold &&
    (!currentHasFullDocumentSkeleton || preservedAnchorRatio < 0.75)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic document skeleton instead of a small in-place UI update.`;
  }

  if (
    introducesFullDocumentSkeleton &&
    !currentHasFullDocumentSkeleton &&
    (preservedRatio < 0.75 || preservedAnchorRatio < 1)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} introduces a new full-document UI skeleton for a small UI task.`;
  }

  if (currentAnchors.length >= 3 && preservedAnchorRatio < 0.5) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes critical existing UI anchors for a small UI task.`;
  }

  if (
    broadMarkupRewrite &&
    (preservedRatio < 0.55 || preservedAnchorRatio < 0.75)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a broad markup replacement for a small UI task instead of a localized polish edit.`;
  }

  if (currentTokens.length >= 5 && preservedRatio < 0.2) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes most existing UI structure identifiers/classes for a small UI task.`;
  }

  return null;
}

function parsePatchFailureWarning(
  warning: string
): {
  reason: string;
  score?: number;
  bestMatch?: string;
  normalizedFailureReason?: string;
} {
  if (warning.startsWith("[PATCH_NO_MATCH_ABORT] ")) {
    return { reason: "no_match_abort", normalizedFailureReason: "no_match_abort" };
  }
  if (warning.startsWith("[PATCH_FIND_NOT_FOUND] ")) {
    try {
      const payload = JSON.parse(
        warning.slice("[PATCH_FIND_NOT_FOUND] ".length)
      ) as {
        reason?: string;
        score?: number;
        bestMatch?: string;
      };

      return {
        reason: "patch_find_not_found",
        score: payload.score,
        bestMatch: payload.bestMatch,
        normalizedFailureReason:
          normalizePatchOutcomeReason(payload.reason) ?? undefined,
      };
    } catch {
      return { reason: "patch_find_not_found" };
    }
  }

  if (warning.startsWith("[invalid_patch_format]")) {
    return { reason: "invalid_patch_format" };
  }

  if (warning.startsWith("[DEVELOPER_PATCH_FORMAT]")) {
    return { reason: "invalid_patch_format" };
  }

  if (warning.startsWith("[PATCH_PROTOCOL_LEAK]")) {
    return { reason: "patch_protocol_leak", normalizedFailureReason: "patch_protocol_leak" };
  }

  if (warning.startsWith("[ANCHOR_TOO_SMALL_FOR_LARGE_REPLACE] ")) {
    try {
      const payload = JSON.parse(
        warning.slice("[ANCHOR_TOO_SMALL_FOR_LARGE_REPLACE] ".length)
      ) as { reason?: string };
      return {
        reason: "anchor_too_small_for_large_replace",
        normalizedFailureReason: payload.reason ?? "anchor_too_small_for_large_replace",
      };
    } catch {
      return {
        reason: "anchor_too_small_for_large_replace",
        normalizedFailureReason: "anchor_too_small_for_large_replace",
      };
    }
  }

  return { reason: "warning" };
}

function buildPatchConflictWarning(input: {
  filePath: string;
  reason: string;
  score?: number;
  bestMatch?: string;
}): string {
  return `[PATCH_CONFLICT] ${JSON.stringify({
    filePath: input.filePath,
    status: "failed",
    reason: input.reason,
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    ...(typeof input.bestMatch === "string" ? { bestMatch: input.bestMatch } : {}),
  })}`;
}

function logPatchConversionDebug(input: {
  filePath: string;
  chosenOutputMode: "full_content" | "find_replace_patch";
  responseMode:
    | "full_content"
    | "patch"
    | "invalid_patch_format"
    | "empty_model_response"
    | "openai_call_error";
  status: "applied" | "failed" | "no_match";
  failureReason?: string;
  normalizedFailureReason?: string;
}): void {
  if (input.status === "applied" && input.responseMode === "full_content") {
    return;
  }

  debugLog(
    "[zone-patch-conversion]",
    JSON.stringify({
      filePath: input.filePath,
      chosenOutputMode: input.chosenOutputMode,
      responseMode: input.responseMode,
      status: input.status,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      ...(input.normalizedFailureReason
        ? { normalizedFailureReason: input.normalizedFailureReason }
        : {}),
    })
  );
}

function normalizePatchOutcomeReason(reason: string | undefined): string | null {
  const normalized = String(reason ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

function deriveNoCodeChangeReason(patchResults: PatchResult[]): string {
  const noEligible = patchResults.find(
    (result) =>
      result.status === "failed" && result.reason === "no_eligible_target_found"
  )?.reason;
  if (noEligible) {
    return noEligible;
  }
  const failedReason = patchResults.find(
    (result) => result.status === "failed" && result.reason
  )?.reason;
  const skippedReason = patchResults.find(
    (result) => result.status === "skipped" && result.reason
  )?.reason;
  const normalizedFailedReason = normalizePatchOutcomeReason(failedReason);

  return (
    (normalizedFailedReason === "warning"
      ? "patch_conversion_failed"
      : normalizedFailedReason) ??
    normalizePatchOutcomeReason(skippedReason) ??
    "no_code_change_produced"
  );
}

function renderPatchResultLine(result: PatchResult, warnings: string[]): string {
  if (result.status === "applied") {
    return `✓ ${result.filePath}        applied`;
  }

  if (result.status === "skipped") {
    return `~ ${result.filePath}        skipped (${result.reason ?? "skipped"})`;
  }

  const conflictWarning = warnings.find(
    (warning) =>
      warning.startsWith("[PATCH_CONFLICT] ") &&
      warning.includes(`"filePath":"${result.filePath}"`)
  );

  let details = result.reason ?? "failed";
  if (conflictWarning) {
    try {
      const payload = JSON.parse(
        conflictWarning.slice("[PATCH_CONFLICT] ".length)
      ) as { reason?: string; score?: number };
      details = payload.reason ?? details;
      if (typeof payload.score === "number") {
        details += `, score: ${payload.score}`;
      }
    } catch {
      // keep best-effort summary rendering stable
    }
  }

  return `✗ ${result.filePath}        failed (${details})`;
}

/** Max file contexts kept when trimming to satisfy the patch-flow token budget. */
const HOSTED_CONTEXT_BUDGET_TRIM_CAP = 12;

/**
 * Orders paths by `rankRelevantFiles` ranking (plus original tail fill), capped at
 * `maxFiles`. Always prefers the #1 ranked path that appears in `resolvedFileContexts`
 * (the primary targeting / preview anchor).
 */
function selectRankedContextPathsWithinCap(
  resolvedFileContexts: Array<{ path: string; content: string }>,
  fullRankedFiles: Array<{ path: string }>,
  maxFiles: number,
  pinnedPaths?: string[]
): string[] {
  const byPath = new Map(resolvedFileContexts.map((file) => [file.path, true]));
  const ordered: string[] = [];
  for (const p of pinnedPaths ?? []) {
    if (typeof p === "string" && byPath.has(p) && !ordered.includes(p)) {
      ordered.push(p);
    }
  }
  const rankedInContext = fullRankedFiles
    .map((file) => file.path)
    .filter((path) => byPath.has(path));
  const previewTargetPath =
    rankedInContext.find((path) => !ordered.includes(path)) ?? rankedInContext[0];
  if (typeof previewTargetPath === "string" && !ordered.includes(previewTargetPath)) {
    ordered.push(previewTargetPath);
  }
  for (const path of rankedInContext) {
    if (ordered.length >= maxFiles) {
      break;
    }
    if (!ordered.includes(path)) {
      ordered.push(path);
    }
  }
  for (const file of resolvedFileContexts) {
    if (ordered.length >= maxFiles) {
      break;
    }
    if (!ordered.includes(file.path)) {
      ordered.push(file.path);
    }
  }
  return ordered;
}

export async function runLlmPatchFlow(input: {
  task: string;
  repoPath: string;
  atomicPatch?: boolean;
  dryRun?: boolean;
  conversationId?: string;
  /** Durable resume: stable per-session ID for envelope checkpointing. */
  sessionId?: string;
  userId?: string;
  lastChangedFiles?: unknown;
  lastAddedFunctions?: unknown;
  billingMode?: ConversationBillingMode;
  hostedContext?: HostedDeveloperContextInput;
  runId?: string;
  onProgress?: (update: LlmPatchProgressUpdate) => void | Promise<void>;
  perfLabel?: string;
  /** When aborted (POST /api/cancel), progress hooks throw AbortError to unwind the flow. */
  abortSignal?: AbortSignal;
  /**
   * BYOK: user-supplied OpenAI API key forwarded from the browser header.
   * Passed through to runAgentLoop → createOpenAIClient so it is used instead of the env var.
   */
  userApiKey?: string;
  provider?: LLMProvider;
  // "plan" kept as backward-compat alias; normalizes to "patch" internally
  mode?: "patch" | "plan";
  /** Pre-generated (and pre-approved) plan; skips both generateExecutionPlan call sites. */
  preGeneratedPlan?: ExecutionPlan;
  /** L.4.1: per-request tier override forwarded from API body. Beats ZONE_FORCE_TIER env. */
  forceTier?: TaskTier;
  /** Phase AS: pre-computed classification from server.ts audit gate. Skips re-classification. */
  preClassifiedTask?: TaskClassification;
  /** dispatch.ts's plan-mode gate decision — forwarded to agentLoopBaseInput so
   *  [zone-archetype] can carry both sides of the gate-vs-archetype comparison
   *  in one marker. Undefined when the gate wasn't computed (strict/checkpoint
   *  path, durable resume). */
  gateLeadVerb?: string | null;
  gateMode?: string;
  /** Phase X.0.1: distilled findings from the pre-execution scope audit.
   *  Forwarded to agentLoopBaseInput so the execute agent sees the AUDIT CONTEXT block. */
  auditFindings?: {
    summary: string;
    citationCount: number;
    toolCallCount: number;
    costUsd: number;
  };
  summaryFormat?: "compact" | "detailed";
  /** Phase 1 session memory: prior task's FINAL SUMMARY loaded by TUI before dispatch. */
  priorSessionSummary?: string;
  webSearchEnabled?: boolean;
  /** ALLOWLIST for ask_user — see AgentLoopInput.interactiveChannel. */
  interactiveChannel?: "tui";
  /** Stage 3A: per-edit approval mode for plan-mode [2] "manually approve changes". */
  editApprovalMode?: "auto" | "manual";
  /** R3: when true, shows staged diffs for approval before flushing to disk. */
  stagedCheckpoint?: boolean;
  /** R3: discarded staging from a prior rejected run; seeded into the first user message. */
  restageSeed?: Map<string, string>;
  /** R3: when true, auto-resolves the staged-diff checkpoint without showing a modal. */
  autoApprove?: boolean;
  /** Plan-first: when true, emits a non-blocking post_execute_diffs event after successful flush. */
  showPostFlushDiffs?: boolean;
  /** Local image attachments forwarded to the agent loop's initial user message. */
  images?: import("../api/imageUpload.js").ImageAttachment[];
  /** User-facing hooks from .zone/hooks.json — trust-checked in-memory snapshot. */
  userHooks?: import("../api/diskHooks.js").UserHooksConfig | null;
  /** MCP client manager — proxies mcp__<server>__<tool> calls. */
  mcpManager?: import("../mcp/mcpClientManager.js").McpClientManager | null;
  /** Durable resume: pre-reconciled staging + context to inject on restart. */
  resume?: {
    stagingFiles: Map<string, string>;
    todos: import("../core/todoLifecycle.js").RunTodo[];
    failureHistory: Array<{ path: string; records: import("../api/diskRunEnvelope.js").FailureRecordLite[] }>;
    contextBlock: string;
    messages?: unknown[];
    /** True when the envelope recorded the conversation as dropped for size.
     *  Surfaced to the user — a silent cold start is the failure mode. */
    messagesOmitted?: boolean;
    /** Key of the envelope being resumed — adopted so the run continues that
     *  file instead of forking a second one under its own runId. */
    envelopeKey?: string;
    /** The question the resumed run stopped on, for the TUI to re-render. */
    pendingQuestion?: { toolCallId: string; question: string; iter: number };
    /** What the user typed in reply to it. Absent when they did not answer. */
    answer?: string | null;
  };
}): Promise<LlmPatchFlowResult> {
  attachRunIdentity({ userId: input.userId, runId: input.runId });
  // Phase H.7: outer-scope flag survives past the inner block where `loop`
  // is declared, so the final return can include it for the UI pill.
  let tokenBudgetExceededAtExit = false;
  // Phase Q.2: same pattern for loop detection exit.
  let loopDetectedAtExit: { toolName: string; count: number } | undefined;
  logger.info(
    "[zone-flow-entry] runId=%s, ts=%s, lockHeld=%s",
    typeof input.runId === "string" ? input.runId.trim() : "",
    new Date().toISOString(),
    "false"
  );
  debugLog("[zone-flow-trigger] runLlmPatchFlow invoked", {
    runId: typeof input.runId === "string" ? input.runId : null,
    conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
    dryRun: !!input.dryRun,
    atomicPatch: !!input.atomicPatch,
    hasHostedContext: !!input.hostedContext,
    hasUserApiKey: !!input.userApiKey,
    timestamp: new Date().toISOString(),
  });
  const lifecycleEvents: AgentLifecycleEvent[] = [];
  let executionPlan: ExecutionPlan | null = null;
  let runTodos: RunTodo[] = [];

  const getMaxContextFiles = (): number => {
    const raw = (process.env.MAX_CONTEXT_FILES ?? "").trim();
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n));
    return getDynamicContextLimit(input.task, framework);
  };

  const throwIfAborted = (): void => {
    if (input.abortSignal?.aborted) {
      throw new DOMException("Run aborted", "AbortError");
    }
  };

  const emitStructuredProgress = (
    event: Omit<ZoneStructuredProgressEvent, "runId" | "ts">
  ): void => {
    throwIfAborted();
    const runId = typeof input.runId === "string" ? input.runId.trim() : "";
    if (!runId) return;
    const progress: ZoneStructuredProgressEvent = {
      runId,
      ts: Date.now(),
      ...event,
    };
    try {
      input.onProgress?.({ stage: event.title, progress });
    } catch {
      // best-effort
    }
  };

  let latestIterCostUpdate: IterCostUpdatePayload | null = null;
  let _costLogPath: string | null = null;

 const emitTodos = (type: "todos_initialized" | "todo_revised"): void => {
  if (runTodos.length === 0) return;
    emitStructuredProgress({
      type,
      title: type === "todo_revised" ? "Plan revised" : "Plan initialized",
      status: "success",
      todos: runTodos,
    });
  };

  const emitTodoStatus = (todoId: string, todoStatus: TodoStatus): void => {
    if (!todoId) return;
    emitStructuredProgress({
      type: "todo_status_changed",
      title: "Plan item updated",
      status: todoStatus === "completed" ? "success" : todoStatus === "skipped" ? "warning" : "active",
      todoId,
      todoStatus,
    });
  };

  const setTodoStatus = (todoId: string, todoStatus: TodoStatus): void => {
    if (runTodos.length === 0) return;
    if (
      todoStatus !== "pending" &&
      todoStatus !== "in_progress" &&
      todoStatus !== "completed" &&
      todoStatus !== "skipped"
    ) {
      return;
    }
    const before = runTodos.find((todo) => todo.id === todoId)?.status;
    if (!before || before === todoStatus) return;
    if (todoStatus === "in_progress") runTodos = startTodo(runTodos, todoId);
    else if (todoStatus === "completed") runTodos = completeTodo(runTodos, todoId);
    else runTodos = runTodos.map((todo) => todo.id === todoId ? { ...todo, status: todoStatus } : todo);
    emitTodoStatus(todoId, todoStatus);
  };

const initializeTodosFromPlan = (): void => {
  if (!executionPlan || executionPlan.steps.length === 0) return;
  runTodos = executionPlanToTodos(executionPlan);
  emitTodos("todos_initialized");
};

  const startTodoForFile = (filePath: string | null | undefined): void => {
    const todoId = findTodoIdForFile(runTodos, filePath);
    if (todoId) setTodoStatus(todoId, "in_progress");
  };

  const finalizeRunTodos = (outcome: "completed" | "skipped"): void => {
    if (runTodos.length === 0) return;
    const previous = runTodos;
    runTodos = finalizeTodos(runTodos, outcome);
    for (const todo of runTodos) {
      if (previous.find((prev) => prev.id === todo.id)?.status !== todo.status) {
        emitTodoStatus(todo.id, todo.status);
      }
    }
  };

  const notifyProgress = (
    legacyStage: string,
    lifecycleInput?: Omit<AgentLifecycleEvent, "timestamp">
  ): void => {
    throwIfAborted();
    if (lifecycleInput) {
      const ev = createAgentLifecycleEvent(lifecycleInput);
      lifecycleEvents.push(ev);
      try {
        const out = input.onProgress?.({ stage: legacyStage, lifecycle: ev });
        void out;
      } catch {
        // keep progress reporting best-effort
      }

      return;
    }
    try {
      input.onProgress?.(legacyStage);
    } catch {
      // keep progress reporting best-effort
    }
  };

  const reportProgress = (stage: string): void => {
    notifyProgress(stage);
  };

  const perf = startZoneApiPerfRun(input.perfLabel ?? "runLlmPatchFlow");

  debugLog("[zone-flow-entry]", JSON.stringify({
    task: (input.task ?? "").slice(0, 150),
    repoPath: input.repoPath,
    hasLastChangedFiles: Array.isArray(input.lastChangedFiles),
    hasHostedContext: !!input.hostedContext,
    runId: typeof input.runId === "string" ? input.runId.slice(0, 20) : null,
  }));

  const taskIntent =
    typeof input.task === "string" ? parseTaskIntent(input.task) : UNKNOWN_INTENT;
  let explicitTargetPath: string | null = null;
  let explicitTargetRepoFile: RepoFile | null = null;
  let explicitTargetCanonicalPath: string | null = null;

  notifyProgress("Scanning repo...", {
    type: "run_started",
    message: "Developer patch run started.",
    stage: "init",
  });
  notifyProgress("Scanning repo...", {
    type: "intent_understood",
    message: `Task intent: ${taskIntent.normalizedTask || taskIntent.action || "developer task"}.`,
    stage: "intent",
  });

  const zoneInternalTask = detectZoneInternalTask(input.task);

  if (zoneInternalTask) {
    debugLog("[zone-flow-early-return]", JSON.stringify({ reason: "zone_internal_task", task: (input.task ?? "").slice(0, 150) }));
    notifyProgress("Ready", {
      type: "run_completed",
      message: "Run finished (Zone internal task — no patch).",
      stage: "finalize",
      status: "zone_internal",
    });
    reportProgress("Ready");
    perf.finish("zone internal task blocked");
    const zoneInternalReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: [],
      planObjective: null,
      planScopeSummary: null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "blocked",
      finalState: "blocked",
      warnings: [ZONE_INTERNAL_TASK_WARNING],
      correctness: {
        status: "skipped",
        summary: "No patches were generated (Zone internal task).",
      },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "completed_with_issues",
      developerConfidence: 0,
    });
    return {
      ok: true,
      reason: "zone_internal_task_target",
      patchPreview: ZONE_INTERNAL_TASK_WARNING,
      warnings: [ZONE_INTERNAL_TASK_WARNING],
      developerConfidence: 0,
      decisionMode: "blocked",
      finalState: "blocked",
      finalExecutionOutcome: "completed_with_issues",
      validationBlocked: true,
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
      lifecycleEvents: [...lifecycleEvents],
      finalRunReport: zoneInternalReport,
    };
  }
  const hostedAvailableFiles: RepoFile[] | undefined =
    input.hostedContext?.availableFiles.map((file) => ({
      path: file.path,
      absolutePath: file.path,
      extension: file.extension,
      category: file.category as RepoFile["category"],
    }));

  // 1. Scan repo
  reportProgress("Scanning repo...");
  let allFiles: RepoFile[] = [];
  let fileSource: "scanRepo" | "hosted" | "empty" = "empty";

  debugLog(
    "[zone-diag-repoPath-input]",
    JSON.stringify({
      repoPath: input.repoPath,
      cwd: process.cwd(),
      repoPathType: typeof input.repoPath,
      repoPathLen: typeof input.repoPath === "string" ? input.repoPath.length : null,
    })
  );

  // Determine whether repoPath points to an actually readable local directory.
  // In true hosted cloud mode the repoPath is absent, a tmp/hosted path, or
  // simply not readable — scanRepo will then throw and we fall through to the
  // hosted context list.
  const repoPathLooksLocal =
    typeof input.repoPath === "string" &&
    input.repoPath.length > 0 &&
    !input.repoPath.startsWith("/hosted") &&
    !input.repoPath.startsWith("/tmp/zone-hosted");

  let scanRepoThrew = false;
  if (repoPathLooksLocal) {
    try {
      const scanned = await scanRepo(input.repoPath);
      if (scanned.length > 0) {
        allFiles = scanned;
        fileSource = "scanRepo";
      }
      // scanned.length === 0 is valid — accessible but empty dir; proceed without context
    } catch {
      scanRepoThrew = true;
      // Fall through — hostedAvailableFiles may still provide a usable list.
    }
  }

  if (allFiles.length === 0 && hostedAvailableFiles) {
    allFiles = hostedAvailableFiles;
    fileSource = "hosted";
  }

  debugLog(
    "[zone-diag-scan]",
    JSON.stringify({
      repoPath: input.repoPath,
      hostedFilesCount: hostedAvailableFiles?.length ?? 0,
      finalCount: allFiles.length,
      source: fileSource,
      isHostedEnv: isHostedEnvironment(),
      scanRepoThrew,
    })
  );

  perf.mark("repo scan ready");

  // Phase 3: fail-closed for genuinely inaccessible repo roots.
  // With suppressErrors in scanRepo, fast-glob returns [] for both an empty-but-valid dir
  // and a missing/unreadable dir — the 0-length result is ambiguous. Distinguish them with
  // an explicit fs check, but ONLY when all file sources returned nothing AND the path is an
  // absolute Unix path (gates out Windows-style test paths like "C:/repo" on Linux).
  if (allFiles.length === 0 && repoPathLooksLocal && path.isAbsolute(input.repoPath)) {
    let repoAccessible = false;
    try {
      const st = statSync(input.repoPath);
      if (st.isDirectory()) {
        accessSync(input.repoPath, constants.R_OK);
        repoAccessible = true;
      }
    } catch { /* non-existent, EACCES, not-a-dir — repoAccessible stays false */ }

    if (!repoAccessible) {
      debugLog("[zone-flow-early-return]", JSON.stringify({ reason: "repo_not_accessible", repoPath: input.repoPath }));
      perf.finish("repo access blocked");
      input.onProgress?.({
        progress: {
          type: "narration",
          runId: typeof input.runId === "string" ? input.runId.trim() : "",
          ts: Date.now(),
          title: "Could not read this folder — check permissions.",
          text: "Could not read this folder — check permissions.",
          status: "complete",
        } as unknown as ZoneStructuredProgressEvent,
      } as unknown as LlmPatchProgressUpdate);
      return { ok: false as const, reason: "repo_not_accessible" };
    }
  }


  explicitTargetPath = extractExplicitTarget(input.task);
  if (explicitTargetPath) {
    explicitTargetRepoFile = resolveExplicitTarget(allFiles, explicitTargetPath);
    if (!explicitTargetRepoFile) {
      debugLog("[zone-flow-early-return]", JSON.stringify({ reason: "explicit_target_not_found_pre_agent", path: explicitTargetPath }));
      notifyProgress("Ready", {
        type: "patch_generation_failed",
        message: `Explicit target file is not in the raw repository file list: ${explicitTargetPath}`,
        stage: "repo",
        status: "explicit_target_not_found",
        filePath: explicitTargetPath,
      });
      notifyProgress("Ready", {
        type: "run_completed",
        message: "Run finished (preview-only, explicit target not in repo).",
        stage: "finalize",
        status: "preview_only",
      });
      reportProgress("Ready");
      perf.mark("decision evaluation complete");
      perf.finish("explicit target not in raw repo");
      const explicitEarlyReport = await generateFinalRunReport({
        task: input.task,
        contextFilesMeta: [],
        planObjective: null,
        planScopeSummary: null,
        patchSource: "no_patch",
        fileDiffs: [],
        patchScope: {
          changedFileCount: 0,
          totalAddedLines: 0,
          totalRemovedLines: 0,
          totalChangedLines: 0,
        },
        decisionMode: "safe_to_apply",
        finalState: "safe_to_apply",
        warnings: [EXPLICIT_TARGET_NOT_FOUND_WARNING],
        correctness: {
          status: "skipped",
          summary: "Patch generation was not started (explicit_target_not_found).",
        },
        verificationCommandsLabel: null,
        runtimeVerificationSummary: null,
        finalExecutionOutcome: "completed_with_issues",
        developerConfidence: 60,
        terminalAbort: {
          code: "explicit_target_not_found",
          missingPath: explicitTargetPath,
        },
      });
      return {
        ok: true,
        reason: "explicit_target_not_found",
        patchPreview: EXPLICIT_TARGET_NOT_FOUND_WARNING,
        warnings: [EXPLICIT_TARGET_NOT_FOUND_WARNING],
        developerConfidence: 60,
        decisionMode: "safe_to_apply",
        finalState: "safe_to_apply",
        patchSource: "no_patch",
        applyPatches: [],
        patchResults: [],
        fileDiffs: [],
        contextFiles: [],
        lifecycleEvents: [...lifecycleEvents],
        finalRunReport: explicitEarlyReport,
      };
    }
    debugLog("[zone-explicit-target-found]", explicitTargetRepoFile.path);
    emitStructuredProgress({
      type: "reading_file",
      title: "Reading target file",
      filePath: explicitTargetRepoFile.path,
      status: "active",
    });
    explicitTargetCanonicalPath = explicitTargetRepoFile.path;
  }

  const developerContextFiles = allFiles.filter(
    (file) => !isIrrelevantDeveloperContextPath(file.path)
  );

  // 2. Detect structure
  reportProgress("Detecting project structure...");
  const structure = detectProjectStructure(developerContextFiles);
  perf.mark("project structure detected");
  notifyProgress("Detecting project structure...", {
    type: "repo_explored",
    message: `Repository scanned (${allFiles.length} files, structure hints loaded).`,
    stage: "repo",
    status: fileSource,
  });
  const projectSummary =
    input.hostedContext?.repoSummary ||
    structure.notes.join(" ") ||
    "No project summary available.";
  const projectNotes = input.hostedContext?.projectNotes ?? structure.notes;

  const shouldUseAgentLoop = (task: string): boolean => {
    const forceFlow = String(process.env["ZONE_FORCE_FLOW"] || "").trim().toLowerCase();
    if (forceFlow === "agent_loop") return true;
    if (forceFlow === "plan_full_patch") return false;

    // An approved pre-generated plan signals explicit user intent — always execute via agent-loop.
    if (input.preGeneratedPlan) return true;

    // Vague tasks have their own early-return downstream; skip agent_loop so they reach it
    if (isVagueDeveloperTask(task)) return false;

    // Default: use the interactive tool loop for all local-repo patch tasks
    return true;
  };

  let framework: ProjectFramework = {
    language: "unknown",
    framework: "Unknown",
    testCommand: "",
    buildCommand: "",
    devCommand: "",
    packageManager: "unknown",
    hasTests: false,
    testFilesDetected: false,
    testFramework: "unknown",
    configFiles: [],
    subProjects: [],
  };
  if (repoPathLooksLocal && fileSource === "scanRepo") {
    try {
      framework = await detectFramework(input.repoPath);
    } catch {
      // best-effort
    }
  }

  debugLog(
    "[zone-framework]",
    JSON.stringify({
      framework: framework.framework,
      language: framework.language,
      testCommand: framework.testCommand,
      hasTests: framework.hasTests,
      testFilesDetected: framework.testFilesDetected,
      subProjects: framework.subProjects.length,
    })
  );

  emitStructuredProgress({
    type: "context_ready",
    title: `${framework.framework} project detected`,
    detail: `${framework.language} · ${framework.testCommand || "no test command"}`,
    status: "success",
  });

  // Agentic tool loop execution mode (tool calling + direct writes).
  const _useAgentLoop = shouldUseAgentLoop(input.task);
  const _forceFlowEnv = String(process.env["ZONE_FORCE_FLOW"] || "").trim().toLowerCase() || null;
  log("[zone-flow-branch]", JSON.stringify({
    branch: _useAgentLoop ? "agent_loop" : "plan_full_patch",
    task: input.task.slice(0, 200),
    reason: _forceFlowEnv
      ? "env_override"
      : input.preGeneratedPlan
        ? "preGeneratedPlan"
        : isVagueDeveloperTask(input.task)
          ? "fallback_vague_task"
          : "default_for_patch_tasks",
    overrideEnv: _forceFlowEnv,
    repoPathLooksLocal,
    fileSource,
  }));

  // Chitchat short-circuit: guard-less — reached by BOTH agent_loop and plan_full_patch
  // inputs before any branch divergence. Previously buried inside !_useAgentLoop so
  // "hello" (isVague=false → _useAgentLoop=true) hit the full agent_loop. Now caught here.
  if (isChitchat(input.task)) {
    const chitchatType = classifyChitchat(input.task);
    const replyText =
      chitchatType === "farewell" ? "Take care — come back anytime." :
      chitchatType === "gratitude" ? "Happy to help! Anything else I can do?" :
      "Hi! What would you like to work on?";
    emitStructuredProgress({
      type: "agent_loop_complete",
      title: "agent_loop_complete",
      status: "success",
      detail: replyText,
      iter: 0,
      cumulativeCost: 0,
    });
    emitStructuredProgress({
      type: "run_summary",
      title: "Run summary",
      status: "success",
      cost: { totalUsd: 0, iterCount: 0, cacheHitPct: 0, avgIterUsd: 0 },
    });
    const shortReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: [],
      planObjective: null,
      planScopeSummary: null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: { changedFileCount: 0, totalAddedLines: 0, totalRemovedLines: 0, totalChangedLines: 0 },
      decisionMode: "safe_to_apply",
      finalState: "safe_to_apply",
      warnings: [],
      correctness: { status: "skipped", summary: "No patch attempted (chitchat input)." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "completed_with_issues",
      developerConfidence: 60,
    });
    return {
      ok: true,
      patchPreview: replyText,
      warnings: [],
      decisionMode: "chat",
      chatResponse: replyText,
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
      lifecycleEvents: [],
      finalRunReport: shortReport,
    };
  }

  // Vague short-circuit: fire BEFORE the planning pipeline (plannerStep /
  // generateExecutionPlan / planPatchPreviewWithLlm) so zero LLM calls are made.
  // Intentionally does NOT guard on _forceFlowEnv — ZONE_FORCE_FLOW=plan_full_patch
  // is for substantive tasks; vague inputs short-circuit regardless.
  // Chitchat is caught above; only the clarification branch remains here.
  if (!_useAgentLoop && isVagueDeveloperTask(input.task)) {
    const replyText = "That's a bit vague — what would you like me to change?";
    // agent_loop_complete → handleAgentLoopComplete → ASSISTANT_FINAL (prominent) + RUN_DONE.
    // iter:0 suppresses STATUS_UPDATE so the status bar keeps the session default.
    emitStructuredProgress({
      type: "agent_loop_complete",
      title: "agent_loop_complete",
      status: "success",
      detail: replyText,
      iter: 0,
      cumulativeCost: 0,
    });
    // run_summary → handleRunSummary → STATUS_UPDATE{costUsd:0} + second RUN_DONE (idempotent).
    emitStructuredProgress({
      type: "run_summary",
      title: "Run summary",
      status: "success",
      cost: { totalUsd: 0, iterCount: 0, cacheHitPct: 0, avgIterUsd: 0 },
    });
    const shortReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: [],
      planObjective: null,
      planScopeSummary: null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: { changedFileCount: 0, totalAddedLines: 0, totalRemovedLines: 0, totalChangedLines: 0 },
      decisionMode: "safe_to_apply",
      finalState: "safe_to_apply",
      warnings: [],
      correctness: { status: "skipped", summary: "No patch attempted (vague input)." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "completed_with_issues",
      developerConfidence: 60,
    });
    return {
      ok: true,
      patchPreview: replyText,
      warnings: [],
      decisionMode: "chat",
      chatResponse: replyText,
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
      lifecycleEvents: [],
      finalRunReport: shortReport,
    };
  }

  // J.5: load prior-run rollback summary BEFORE we split into the agent_loop
  // vs planner+agent branches, so both paths can thread it into
  // runAgentLoop. J.5.1: try Supabase first (faster when available),
  // fall back to the project-local filesystem store at
  //   <repoPath>/.zone/conversations/<threadId>.jsonl
  // which the rolled-back-run logRun wrote unconditionally. Both layers
  // are graceful — any failure leaves priorRunSummary="".
  let conversationHistory: unknown[] = [];
  let priorRunSummary = "";
  let priorRunSummarySource: "supabase" | "filesystem" | "none" = "none";
  let priorRunHistoryEventCount = 0;
  const threadIdForLoad =
    typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  try {
    const userIdJ5 =
      typeof input.userId === "string" ? input.userId.trim() : "";
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (threadIdForLoad && userIdJ5 && url && key) {
      const supabase: SupabaseClient = createClient(url, key);
      const history = await getConversationByThreadId(supabase, {
        userId: userIdJ5,
        threadId: threadIdForLoad,
      });
      const allMessages = Array.isArray(history?.messages) ? history!.messages : [];
      if (allMessages.length > 0) {
        conversationHistory = allMessages.slice(-10);
        priorRunSummary = extractPriorRunSummary(allMessages);
        if (priorRunSummary) {
          priorRunSummarySource = "supabase";
          priorRunHistoryEventCount = allMessages.length;
        }
      }
    }
  } catch {
    conversationHistory = [];
    priorRunSummary = "";
  }
  // J.5.1: filesystem fallback — runs when Supabase didn't return a
  // summary (no env, empty thread row, or the prior run was self-host).
  // Skip when priorSessionSummary is supplied: the TUI already loaded the window
  // from the same store with neutral framing; the rollback-framed fallback would
  // double-inject if conversationId is ever threaded to sessionId in future.
  if (!priorRunSummary && !input.priorSessionSummary && threadIdForLoad && typeof input.repoPath === "string") {
    try {
      const fsEvents = readFsConversationEvents({
        repoPath: input.repoPath,
        threadId: threadIdForLoad,
      });
      if (fsEvents.length > 0) {
        // Hydrate conversationHistory if Supabase didn't already populate it,
        // so the planner sees recent user turns even on self-host.
        if (conversationHistory.length === 0) {
          conversationHistory = fsEvents.slice(-10);
        }
        const candidate = extractPriorRunSummary(fsEvents);
        if (candidate) {
          priorRunSummary = candidate;
          priorRunSummarySource = "filesystem";
          priorRunHistoryEventCount = fsEvents.length;
        }
      }
    } catch {
      // Filesystem failures are non-fatal — proceed with empty priorRunSummary.
    }
  }
  if (priorRunSummary) {
    log("[zone-prior-run-summary-loaded]", JSON.stringify({
      threadId: threadIdForLoad,
      summaryBytes: priorRunSummary.length,
      hasMarker: priorRunSummary.includes("APPLY_ROLLED_BACK\n"),
      persistenceSource: priorRunSummarySource,
      historyEventCount: priorRunHistoryEventCount,
      runId: typeof input.runId === "string" ? input.runId : null,
    }));
  }

  // L5.1b-1: dispatcher config — null until classifier runs inside _useAgentLoop.
  // Path 2 (legacy) always sees null → no behavioral change.
  let pipelineCfg: PipelineConfig | null = null;
  let _dispatcherCapabilityFilter: CapabilityFilter | undefined = undefined;

  if (_useAgentLoop) {
    const runId = typeof input.runId === "string" ? input.runId.trim() : "";
    if (runId) {
      emitStructuredProgress({
        type: "agent_loop_start",
        title: "Starting agent tool loop",
        status: "active",
      });
    }

    // ── Tur P1.5: lightweight plan generation for agent_loop branch ──
    // agent_loop doesn't go through plannerStep narrowing, so we use top-N
    // developerContextFiles ranked quickly by rankRelevantFiles for the plan.
    // This is COARSER than plan_full_patch's narrowed plan but provides
    // enough step structure for todo display and the scope guard.
    let agentLoopPlanFiles: string[] = [];
    try {
      const ranker = await rankRelevantFiles({
        task: input.task,
        files: developerContextFiles,
        readContent: async (relPath: string): Promise<string | null> => {
          try {
            return await readFile(path.join(input.repoPath ?? "", relPath), "utf-8");
          } catch {
            return null;
          }
        },
      });
      agentLoopPlanFiles = ranker.slice(0, 5).map((f) => f.path);
    } catch (err) {
      debugLog(
        `[zone-plan] ranker skipped (agent_loop): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (input.preGeneratedPlan) {
      executionPlan = input.preGeneratedPlan;
      debugLog(`[zone-plan] using preGeneratedPlan steps=${executionPlan.steps.length} (agent_loop)`);
    } else if (!(pipelineCfg as PipelineConfig | null)?.skipPlan && agentLoopPlanFiles.length > 0) {
      try {
        executionPlan = await generateExecutionPlan({
          task: input.task,
          repoSummary: projectSummary,
          relevantFiles: agentLoopPlanFiles,
          userApiKey: input.userApiKey,
          provider: input.provider,
          archetype: (input.preClassifiedTask?.archetype as string | undefined),
        });
        debugLog(`[zone-plan] generated steps=${executionPlan.steps.length} (agent_loop)`);
        debugLog(`[zone-plan] scope=${executionPlan.scopeSummary}`);
        // Sidebar is seeded by the in-loop TodoWrite tool now; pre-planner only
        // feeds scopeGuard / evaluatePlanAlignment / orchestrator / finalRunReport.
      } catch (err) {
        debugLog(
          `[zone-plan] skipped (agent_loop): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    {
      const planStepCount = executionPlan?.steps.length ?? 0;
      const isComplexTask = executionPlan != null && planStepCount >= 2;
      debugLog("[zone-plan-debug]", {
        planStepCount,
        isComplexTask,
        branch: "agent_loop",
      });
      void isComplexTask;
    }

    const beforeByFile = new Map<string, string>();
    const filesTouched: string[] = [];

    // ── Import-context injection (Phase 3B-2, fixed in bug-fix pass) ──────────
    // Import-context injection is OFF by default as of Phase 3B-3.
    // Live A/B testing on refactor tasks showed the current summary format
    // (which under-reports transitive symbol consumers) misleads the agent into
    // premature single-pass rewrites with placeholder REPLACE blocks that break
    // syntax. Infrastructure is preserved for future improvement.
    // Opt in by setting ZONE_ENABLE_IMPORT_CONTEXT=1.
    const _importContextFlag =
      String(process.env["ZONE_ENABLE_IMPORT_CONTEXT"] || "").trim().toLowerCase();
    const _importContextEnabled =
      _importContextFlag === "1" || _importContextFlag === "true";

    // Heuristic: extract a primary symbol name from the task string.
    // Matches camelCase (at least one interior uppercase) and PascalCase identifiers.
    // Stop-list is checked CASE-INSENSITIVELY so "Add" doesn't slip past lowercase "add".
    // Only camelCase/PascalCase words can match the regex — pure lowercase entries in the
    // stop-list serve as case-folded anchors (e.g. "add" blocks both "Add" and "addFoo"
    // when the word folds to "add", which it won't for "addFoo" but will for bare "Add").
    const _importContextStopWords = new Set([
      // English verb/adjective prefixes that are too generic to be symbols on their own
      "add", "the", "fix", "get", "set", "use", "run", "let", "var", "new",
      "try", "put", "map", "key", "api", "url", "uid", "id", "io", "js",
      "ts", "css", "html", "sql", "http", "https", "json", "xml", "csv",
      "return", "function", "const", "class", "type", "interface", "export",
      "import", "default", "async", "await", "this", "true", "false", "null",
      "undefined", "void", "string", "number", "boolean", "object", "array",
      "validate", "validation", "handle", "handler",
      "refactor", "update", "create", "delete", "remove", "rename", "move",
      "extract", "migrate", "implement", "replace", "modify", "convert",
      "render", "connect", "extend", "register", "enable", "disable",
      "inject", "wrap", "apply", "process", "write", "make", "ensure",
      "fetch", "load", "save", "send", "receive", "parse", "build",
      "init", "setup", "test", "tests", "spec", "mock", "stub", "check",
      "error", "warn", "warning", "info", "debug", "log", "logger",
      "config", "option", "param", "data", "result",
      "response", "request", "input", "output", "event", "context",
      "state", "store", "model", "schema", "query", "field", "value",
      "props", "ref", "node", "list", "item", "index", "page", "route",
      "path", "file", "repo", "project",
    ]);
    function _extractPrimarySymbol(task: string): string | null {
      // All candidates the regex extracts (for diagnostic logging)
      const all: string[] = [];
      const re = /\b([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*|[A-Z][a-zA-Z0-9_]+)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(task)) !== null) {
        const word = m[1]!;
        all.push(word);
      }
      // Return first match not in stop-list (case-insensitive lookup)
      for (const word of all) {
        if (!_importContextStopWords.has(word.toLowerCase())) return word;
      }
      return null;
    }
    function _extractAllSymbols(task: string): string[] {
      const re = /\b([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*|[A-Z][a-zA-Z0-9_]+)\b/g;
      const all: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(task)) !== null) all.push(m[1]!);
      return all;
    }

    let _importContextSummary: string | undefined;
    const _importContextSymbol = _importContextEnabled ? _extractPrimarySymbol(input.task) : null;
    const _allExtractedSymbols = _importContextEnabled ? _extractAllSymbols(input.task) : [];

    if (!_importContextEnabled) {
      debugLog("[zone-import-context]", JSON.stringify({
        enabled: false,
        reason: "default_off",
        primaryFile: null,
        primarySymbolName: null,
        summaryLength: 0,
        truncated: false,
        stats: { forwardCount: 0, reverseCount: 0, symbolReverseCount: 0 },
      }));
    } else {
      // Resolve primary file: explicit target takes priority; else scan for symbol declaration.
      let _importContextPrimaryFile: string | null = null;
      let _resolveReason = "not_attempted";
      let _candidateFiles: string[] = [];
      try {
        const _allPaths = developerContextFiles.map((f) => f.path);
        // _resolvePrimaryFile uses top-level fs/path — we avoid dynamic import here since
        // both are available in the surrounding scope via the existing Node imports.
        if (explicitTargetRepoFile?.path) {
          _importContextPrimaryFile = explicitTargetRepoFile.path;
          _candidateFiles = [explicitTargetRepoFile.path];
          _resolveReason = "explicit_target";
        } else if (_importContextSymbol) {
          // Lightweight grep over developer file list
          const _declPatterns = [
            new RegExp("\\bfunction\\s+" + _importContextSymbol + "\\b"),
            new RegExp("\\basync\\s+function\\s+" + _importContextSymbol + "\\b"),
            new RegExp("\\bconst\\s+" + _importContextSymbol + "\\s*="),
            new RegExp("\\bexport\\s+(?:async\\s+)?function\\s+" + _importContextSymbol + "\\b"),
            new RegExp("\\bexport\\s+const\\s+" + _importContextSymbol + "\\s*="),
            new RegExp("\\bclass\\s+" + _importContextSymbol + "\\b"),
            new RegExp("\\bexport\\s+class\\s+" + _importContextSymbol + "\\b"),
          ];
          for (const relPath of _allPaths) {
            const lower = relPath.toLowerCase();
            if (/\.(test|spec)\.|\/__tests__\/|\/__mocks__\//.test(lower)) continue;
            let _fc: string;
            try {
              _fc = existsSync(path.join(input.repoPath, relPath))
                ? readFileSync(path.join(input.repoPath, relPath), "utf8").slice(0, 50000)
                : "";
            } catch { continue; }
            if (_declPatterns.some((re) => re.test(_fc))) {
              _candidateFiles.push(relPath);
            }
          }
          if (_candidateFiles.length > 0) {
            // Score: prefer files whose name contains the noun portion of the symbol
            const _noun = _importContextSymbol
              .replace(/^(create|get|set|update|delete|find|list|add|remove|fetch|handle|build|make|run|init|load|save|send)/i, "")
              .toLowerCase();
            const _scored = _candidateFiles.map((c) => ({
              p: c,
              s: _noun.length > 2 && c.toLowerCase().includes(_noun) ? 1 : 0,
            }));
            _scored.sort((a, b) => b.s - a.s);
            _importContextPrimaryFile = _scored[0]!.p;
            _resolveReason = _scored[0]!.s > 0 ? "scored_filename_similarity" : "first_match";
          } else {
            _resolveReason = "no_candidates";
          }
        } else {
          _resolveReason = "no_symbol";
        }
      } catch (_resolveErr) {
        _resolveReason = "resolve_error:" + String(_resolveErr).slice(0, 100);
      }

      debugLog("[zone-import-context-resolve]", JSON.stringify({
        taskPreview: input.task.slice(0, 120),
        extractedSymbols: _allExtractedSymbols,
        chosenSymbol: _importContextSymbol,
        candidateFiles: _candidateFiles,
        chosenFile: _importContextPrimaryFile,
        reason: _resolveReason,
      }));

      if (!_importContextPrimaryFile) {
        debugLog("[zone-import-context]", JSON.stringify({
          enabled: true,
          reason: "opted_in_via_env",
          primaryFile: null,
          primarySymbolName: _importContextSymbol,
          summaryLength: 0,
          truncated: false,
          stats: { forwardCount: 0, reverseCount: 0, symbolReverseCount: 0 },
        }));
      } else {
        try {
          const { buildDependencyGraph: _bdg } = await import("../repo/buildDependencyGraph.js");
          const { buildImportContextSummary: _bics } = await import("../repo/buildImportContextSummary.js");
          const _allPaths = developerContextFiles.map((f) => f.path);
          const _graph = await _bdg(input.repoPath, _allPaths);
          const _ctxResult = _bics(_graph, _importContextPrimaryFile, _importContextSymbol, { maxChars: 3000 });
          _importContextSummary = _ctxResult.summary;
          const _primaryNodeKey = _importContextPrimaryFile.replace(/\\/g, "/");
          const _primaryNode = _graph.nodes.get(_primaryNodeKey);
          const _symbolReverse = _importContextSymbol
            ? (_primaryNode?.importedBy ?? []).filter((imp) => {
                const n = _graph.nodes.get(imp);
                return n ? (n.importedSymbolsBySource.get(_primaryNodeKey) ?? []).some(
                  (s) => s.name === _importContextSymbol || s.alias === _importContextSymbol
                ) : false;
              }).length
            : 0;
          debugLog("[zone-import-context]", JSON.stringify({
            enabled: true,
            reason: "opted_in_via_env",
            primaryFile: _importContextPrimaryFile,
            primarySymbolName: _importContextSymbol,
            summaryLength: _ctxResult.summary.length,
            truncated: _ctxResult.summary.endsWith("..."),
            stats: {
              forwardCount: _ctxResult.totalForward,
              reverseCount: _ctxResult.totalReverse,
              symbolReverseCount: _symbolReverse,
            },
          }));
        } catch (err) {
          debugLog("[zone-import-context]", JSON.stringify({
            enabled: true,
            reason: "opted_in_via_env",
            primaryFile: _importContextPrimaryFile,
            primarySymbolName: _importContextSymbol,
            summaryLength: 0,
            truncated: false,
            stats: { forwardCount: 0, reverseCount: 0, symbolReverseCount: 0 },
            error: String(err),
          }));
        }
      }
    }
    // ── End import-context injection ─────────────────────────────────────────

    // Tur P2.1: feature-flagged multi-step orchestration. Default OFF — same
    // single-pass agent_loop as before. When `ZONE_PLAN_ORCHESTRATION=1` AND
    // the run has a plan with ≥2 steps, runAgentLoop is invoked once per step
    // with a step-framed task. State transfer / cancellation parent / verdict
    // gating are deferred to P2.2 / P2.3 / P2.4. The same `executionPlan` is
    // forwarded into every step's call so the P2-scope guard sees the union
    // of `filesLikely` and the agent can combine work optimistically.
    const _planOrchestrationEnabled = isPlanOrchestrationEnabled(
      executionPlan,
      process.env["ZONE_PLAN_ORCHESTRATION"]
    );

    // Phase F1: live tool-input streaming state. Tracks accumulated JSON per
    // block so the filePath can be extracted from the partial payload.
    const toolStreamState = {
      accumByBlock: new Map<string, string>(),
      totalDeltas: 0,
      totalChars: 0,
      startTs: Date.now(),
    };
    const toolInputStream = (event: {
      blockId: string;
      toolName: string;
      delta: string;
      isFirstDelta: boolean;
      iter: number;
      subagentId?: string | null;
    }): void => {
      const prev = toolStreamState.accumByBlock.get(event.blockId) ?? "";
      const accum = prev + event.delta;
      toolStreamState.accumByBlock.set(event.blockId, accum);
      toolStreamState.totalDeltas += 1;
      toolStreamState.totalChars += event.delta.length;

      const fpMatch = accum.match(/"filePath"\s*:\s*"([^"\\]*)"/);
      const fp = fpMatch ? fpMatch[1] : "";
      // F1.4: subagent-emitted deltas carry the worker id; surface it both
      // as a discrete `subagentId` field and as a "↳ worker N" title
      // prefix so the UI slot reflects sub-agent origin.
      const subId = event.subagentId || "";
      const subIdShort = subId.slice(0, 6);
      const parentMark = subId ? `↳ worker ${subIdShort} ` : "";
      const baseLbl = `✎ Writing${fp ? ` ${fp}` : ""}...`;
      emitStructuredProgress({
        type: "tool_input_delta",
        title: parentMark + baseLbl,
        status: "active",
        toolName: event.toolName,
        blockId: event.blockId,
        isFirstDelta: event.isFirstDelta,
        delta: event.delta,
        iter: event.iter,
        ...(subId ? { subagentId: subId } : {}),
      });
    };

    const agentLoopCallbacks = {
      onStructuredEvent: (evt: unknown) => {
        if (!runId) return;
        const e = evt as any;

        // Side-effect branches stay inline; `return` after each prevents double-emit
        // if the event type is later added to mapStructuredEventToProgress.
        if (e?.type === "iter_cost_update") {
          latestIterCostUpdate = {
            type: "iter_cost_update",
            model: String((e as any).model ?? ""),
            runId: String((e as { runId?: unknown }).runId ?? input.runId ?? ""),
            iter: Number(e.iter ?? 0) || 0,
            totalIter: Number(e.totalIter ?? 0) || 0,
            iterCost: Number(e.iterCost ?? 0) || 0,
            cumulativeCost: Number(e.cumulativeCost ?? 0) || 0,
            cacheHitThisIter: Number(e.cacheHitThisIter ?? 0) || 0,
            cacheHitCumulative: Number(e.cacheHitCumulative ?? 0) || 0,
            input_uncached: Number(e.input_uncached ?? 0) || 0,
            cache_write: Number(e.cache_write ?? 0) || 0,
            cache_read: Number(e.cache_read ?? 0) || 0,
            output: Number(e.output ?? 0) || 0,
            output_reasoning: Number(e.output_reasoning ?? 0) || 0,
            output_nonreasoning: Number(e.output_nonreasoning ?? 0) || 0,
            total_input_uncached: Number(e.total_input_uncached ?? 0) || 0,
            total_cache_read: Number(e.total_cache_read ?? 0) || 0,
            total_cache_write: Number(e.total_cache_write ?? 0) || 0,
            total_output: Number(e.total_output ?? 0) || 0,
            total_output_reasoning: Number(e.total_output_reasoning ?? 0) || 0,
            total_output_nonreasoning: Number(e.total_output_nonreasoning ?? 0) || 0,
            iter_count: Number(e.iter_count ?? 0) || 0,
            tier: String((e as any).tier ?? ""),
            archetype: String((e as any).archetype ?? ""),
            pipelineApplied: Boolean((e as any).pipelineApplied ?? false),
            mode: String((e as any).mode ?? ""),
            estimatedIterations: Number((e as any).estimatedIterations ?? -1) || -1,
            taskBlockedByBudget: Boolean((e as any).taskBlockedByBudget ?? false),
            estimatedFiles: Number((e as any).estimatedFiles ?? -1) || -1,
          };
          if (_costLogPath === null) {
            _costLogPath = costLogPath(latestIterCostUpdate.runId || runId || "anon");
          }
          appendIterCostRecord(_costLogPath, latestIterCostUpdate);
          emitStructuredProgress({
            type: "iter_cost_update" as any,
            title: "Cost updated",
            status: "active",
            iter: latestIterCostUpdate.iter,
            totalIter: latestIterCostUpdate.totalIter,
            iterCost: latestIterCostUpdate.iterCost,
            cumulativeCost: latestIterCostUpdate.cumulativeCost,
            cacheHitThisIter: latestIterCostUpdate.cacheHitThisIter,
            cacheHitCumulative: latestIterCostUpdate.cacheHitCumulative,
            input_uncached: latestIterCostUpdate.input_uncached,
            cache_write: latestIterCostUpdate.cache_write,
            cache_read: latestIterCostUpdate.cache_read,
            output: latestIterCostUpdate.output,
            total_input_uncached: latestIterCostUpdate.total_input_uncached,
            total_cache_read: latestIterCostUpdate.total_cache_read,
            total_cache_write: latestIterCostUpdate.total_cache_write,
            total_output: latestIterCostUpdate.total_output,
            iter_count: latestIterCostUpdate.iter_count,
          } as any);
          return;
        }
        if (e?.type === "todos_initialized") {
          if (Array.isArray(e.todos)) runTodos = e.todos as RunTodo[];
          emitStructuredProgress({
            type: "todos_initialized" as any,
            title: String(e.title || "Plan initialized"),
            status: "success",
            todos: e.todos,
          } as any);
          return;
        }
        if (e?.type === "todo_revised") {
          if (Array.isArray(e.todos)) runTodos = e.todos as RunTodo[];
          emitStructuredProgress({
            type: "todo_revised" as any,
            title: String(e.title || "Plan revised"),
            status: "success",
            todos: e.todos,
          } as any);
          return;
        }
        if (e?.type === "todo_status_changed") {
          setTodoStatus(
            String(e.todoId || ""),
            String(e.todoStatus || "") as TodoStatus
          );
          return;
        }

        // Pure mapping — no state mutations:
        const progress = mapStructuredEventToProgress(evt);
        if (progress) emitStructuredProgress(progress);
      },
      onProgress: (msg: string) => {
        if (!runId) return;
        // [tool] lines are handled by onToolCall (structured). Skip raw duplicates.
        if (String(msg || "").startsWith("[tool]")) return;
        // F1.4 C3: zone-internal telemetry stays a side-channel.
        if (isZoneInternalTelemetryProgress(msg)) return;
        emitStructuredProgress({
          type: "tool_call",
          title: String(msg || "").slice(0, 200),
          status: "active",
        });
      },
      onToolCall: (name: string, args: Record<string, unknown>) => {
        // Snapshot "before" content unconditionally — must precede the !runId
        // early-return so beforeByFile is always populated even when the
        // agentLoop fails to add the path to filesModified (Y.2.2 defensive).
        const snapPath =
          (name === "write_file" || name === "apply_patch") && typeof args.filePath === "string"
            ? args.filePath
            : "";
        if (snapPath && !beforeByFile.has(snapPath)) {
          try {
            const abs = path.join(input.repoPath, snapPath);
            const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
            beforeByFile.set(snapPath, before);
          } catch {
            beforeByFile.set(snapPath, "");
          }
        }
        // Part B: snapshot multi_edit "before" content so diff cards render a real before/after.
        // Key with resolveAgentPath — the identical resolver the executor uses (toolExecutor.ts:3139)
        // — so beforeByFile keys match filesModified/fileDiffs keys by construction.
        // Snapshot ALL args.files (we don't know which will stage until after execution);
        // 0-replacement files are harmlessly snapshotted but absent from fileDiffs.
        if (name === "multi_edit") {
          const meFiles = Array.isArray(args.files) ? (args.files as string[]) : [];
          for (const rel of meFiles) {
            const normRel = resolveAgentPath(String(rel), input.repoPath, "multi_edit");
            if (!normRel || beforeByFile.has(normRel)) continue;
            try {
              const abs = path.join(input.repoPath, normRel);
              beforeByFile.set(normRel, existsSync(abs) ? readFileSync(abs, "utf8") : "");
            } catch {
              beforeByFile.set(normRel, "");
            }
          }
        }

        if (!runId) {
          if (snapPath && !_planOrchestrationEnabled) startTodoForFile(snapPath);
          return;
        }
        const cmd = toolCallIdentifyingArg(name, args);
        const patchForEvent = buildToolCallPatch(name, args, beforeByFile.get(snapPath));
        emitStructuredProgress({
          type: "tool_call",
          title: `[tool] ${name}${cmd ? `: ${cmd}` : ""}`.slice(0, 240),
          status: "active",
          ...(patchForEvent ? { patch: patchForEvent } : {}),
        });

        // Agent loop write_file: emit a fallback streaming patch preview so the chat livecode block shows content.
        if (name === "write_file" && typeof args.filePath === "string" && typeof args.content === "string") {
          const rel = String(args.filePath);
          const newContent = String(args.content);
          const capLines = (text: string, max: number): string => {
            const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
            if (lines.length <= max) return lines.join("\n");
            return [...lines.slice(0, max), "… (truncated)"].join("\n");
          };
          const patchBlob = [
            `--- FILE: ${rel} ---`,
            "--- FIND ---",
            "",
            "--- REPLACE ---",
            capLines(newContent, 80),
          ].join("\n");
          emitStructuredProgress({
            type: "patch_stream_delta",
            title: "Streaming patch",
            status: "active",
            filePath: rel,
            delta: patchBlob,
            fallback: true,
          });
          setTimeout(() => {
            emitStructuredProgress({
              type: "patch_converted",
              title: "Patch converted",
              status: "success",
              filePath: rel,
            });
          }, 50);
        }

        if (snapPath && !_planOrchestrationEnabled) startTodoForFile(snapPath);
      },
      onToolResult: (
        name: string,
        result: { output?: string; success?: boolean; metadata?: Record<string, unknown> }
      ) => {
        if (!runId) return;
        emitStructuredProgress({
          type: "tool_result",
          toolName: name,
          title: String(result.output || "").slice(0, 100) || "tool result",
          detail: String(result.output || "").slice(0, 4000),
          status: result.success ? "success" : "error",
          // Phase I.5: forward metadata for tools whose UI render needs
          // structured fields (verify_visual screenshotPath/pageTitle/etc).
          // Stripped at the SSE boundary if the tool didn't supply any.
          ...(result.metadata && Object.keys(result.metadata).length > 0
            ? { metadata: result.metadata }
            : {}),
        });
      },
      onToolInputStream: runId
        ? toolInputStream
        : undefined,
    } as const;

    // Phase H.6: plan-aware iter budget. Single-step (no plan or trivial
    // plan) → WORKER_ITER_FLOOR=6. 4-step plan → 16. Capped at 24. (K.2 tightened)
    // Passed via `maxIterations` (not `maxIterationsOverride`) so the
    // ESCALATION_BONUS_ITERATIONS logic for repeat apply_patch failures
    // remains active.
    //
    // MEASURED CAVEAT (2026-07-31): for a tier-classified main loop `maxIterations`
    // does NOT bound the run at all. agentLoop.ts:2292-2296 overwrites
    // maxIterationsForRun with softIterWarn*3 unconditionally, and the restore at
    // :2364-2367 re-applies only `maxIterationsOverride`. Probed directly:
    // maxIterations:1 ran 75 iterations (medium tier), maxIterationsOverride:1 ran 1.
    // Every non-answer-only budget below is therefore nominal, not effective —
    // [zone-iter-budget-discarded] (agentLoop.ts) records the gap per run so the
    // general fix can be driven by data instead of a second guess. Deliberately NOT
    // fixed here: making it bind would move every plan-mode run from ~75 to 6-24
    // with no measurement of real iteration distributions behind it.
    const iterBudgetPlanSteps = executionPlan?.steps?.length ?? 1;
    const isAnswerOnlyRun = !!executionPlan && isAnswerOnlyPlan(executionPlan);
    const iterBudgetComputed = isAnswerOnlyRun
      ? ANSWER_ONLY_ITER_BUDGET
      : computeWorkerMaxIterations(iterBudgetPlanSteps);
    debugLog("[zone-iter-budget]", JSON.stringify({
      mode: "patch",
      planStepsCount: iterBudgetPlanSteps,
      computedMax: iterBudgetComputed,
      // Which field carries it — only one of the two actually binds (see above).
      field: isAnswerOnlyRun ? "maxIterationsOverride" : "maxIterations",
    }));

    // Phase L.1: pre-dispatch task classification. Informational only — L.2
    // will use the result to gate Task tool exposure and L.3 to scale the
    // token budget. Failure is graceful: a fallback (medium tier) is always
    // returned so dispatch is never blocked.
    // Phase AS: skip re-classification when the audit gate already ran it.
    let taskClassification: TaskClassification | null = input.preClassifiedTask ?? null;
    if (!taskClassification) {
      try {
        taskClassification = await classifyTask(input.task, {
          userApiKey: input.userApiKey,
          provider: input.provider,
          repoRoot: path.resolve(__dirname, "../.."),
        });
      } catch (err) {
        // classifyTask already swallows internal errors and returns a fallback,
        // but defensive against future changes to that contract.
        debugLog("[zone-task-classifier-unexpected-throw]", String(err));
      }
    }
    if (taskClassification) {
      emitStructuredProgress({
        type: "task_classified",
        title: "Task classified",
        status: "active",
        tier: taskClassification.tier,
        estimatedFiles: taskClassification.estimatedFiles,
        estimatedIterations: taskClassification.estimatedIterations,
        confidence: taskClassification.confidence,
        classifierModel: taskClassification.classifierModel,
        classifierCostUsd: taskClassification.classifierCostUsd,
        classifierLatencyMs: taskClassification.classifierLatencyMs,
        ...(taskClassification.fallbackUsed ? { fallbackUsed: true } : {}),
      });
    }

    const _archetypeFlags = readArchetypeFlagsFromEnv();
    pipelineCfg = taskClassification
      ? buildPipelineConfig(taskClassification.archetype, _archetypeFlags)
      : null;
    _dispatcherCapabilityFilter = buildDispatcherCapabilityFilter(pipelineCfg);

    // A user-approved plan with real steps means this run is not what the classifier
    // just called it — investigation/question's read-only cage would block the very
    // edits the plan was approved to make (diagnosed on run d31ead23). Guard on
    // input.preGeneratedPlan specifically, not the local `executionPlan` a few lines
    // above: that variable is ALSO set by this function's own generateExecutionPlan
    // fallback when no plan was supplied, which was never reviewed or approved.
    // steps.length > 0, not mere presence — a stepless approved plan (noChangeReason /
    // cannotVerifyReason) is genuinely read-only and must stay that way. Only the
    // capability filter is suppressed; pipelineCfg itself (iterCap, coachingBudget,
    // skipPlan, ...) is untouched and still flows through below unchanged.
    const hasApprovedSteps = !!input.preGeneratedPlan && input.preGeneratedPlan.steps.length > 0;
    // Telemetry for this decision moved to agentLoop.ts's runAgentLoopScoped, which
    // emits [zone-readonly-pipeline-suppressed] once the prompt actually exists — this
    // site only decides; it no longer reports, since a report built before the prompt
    // is assembled can only record what was intended, not what was actually built.
    const readOnlyPipelineSuppressed = !!(pipelineCfg?.readOnlyPipeline && hasApprovedSteps);
    if (readOnlyPipelineSuppressed) {
      _dispatcherCapabilityFilter = undefined;
    }

    // R4: the approved plan's shape is authoritative over a re-classification that
    // never saw it. classifyTask above (:5889-5902) is handed input.task ONLY, so an
    // approved answer-only plan gets its read-only posture from a fresh reading of the
    // task string — measured landing on archetype "debug", whose null pipeline config
    // yields no capability filter at all, leaving the medium-tier subset (9 tools,
    // write_file/apply_patch/multi_edit included) and scopeGuard as the single enforced
    // layer. Same defect class as the bug this shape exists to fix, one layer down:
    // classification running where it cannot see the artifact it is classifying for.
    //
    // The filter only — never pipelineCfg, and never the archetype. Overriding the
    // archetype would move 12+ downstream consumers in agentLoop.ts (telemetry, the
    // forced-tier mismatch detector, prompt assembly, chain-saturation, promotion);
    // overriding pipelineCfg would flip pipelineApplied:true and arm L5.1b-2 promotion,
    // plus move coachingBudgetOverride/originalArchetype/skipPlan. This changes exactly
    // the read-only posture.
    //
    // INVESTIGATION_PIPELINE, not a hand-rolled {allow: READ_ONLY_CAPABILITIES}: three
    // definitions of "read-only" already coexist unreconciled in this tree and a fourth
    // would be worse than reusing the builder. Investigation over QUESTION because
    // allowExploration:true keeps list_files/search_in_files/find_references — an
    // answer-only run still explores to compose its answer. Only the FILTER is taken, so
    // QUESTION-vs-INVESTIGATION iterCap is irrelevant here and C6's clamp below still
    // reads the real pipelineCfg?.iterCap (null for debug ⇒ budget stays 8).
    //
    // Ordered after the suppression block above rather than before it: suppression
    // cannot fire for this shape today (it needs hasApprovedSteps, false when steps:[]),
    // but depending on that distant invariant is exactly how a guard goes quietly inert.
    if (isAnswerOnlyRun) {
      _dispatcherCapabilityFilter = buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE);
    }

    const agentLoopBaseInput = {
      task: input.task,
      repoPath: input.repoPath,
      runId,
      framework,
      importContextSummary: _importContextSummary,
      abortSignal: input.abortSignal,
      userApiKey: input.userApiKey,
      provider: input.provider,
      // Usage-tracker Tur: attribute spend to the requesting user so the
      // Settings → Usage tab can show per-user totals. Falls back to
      // "local-dev" inside agentLoop when missing.
      userId: input.userId,
      mode: input.mode === "plan" ? "patch" : input.mode,
      // Tur P2-scope: forward the plan so the tool layer can hard-block
      // writes that fall outside `plan.steps[*].filesLikely`.
      executionPlan,
      // hasApprovedSteps (above) — not mere executionPlan presence — distinguishes a
      // user-reviewed plan from this function's own generateExecutionPlan fallback,
      // which was never reviewed. Gates whether the plan's full content reaches the
      // execution prompt at all.
      planApproved: hasApprovedSteps,
      readOnlyPipelineSuppressed,
      repoSummary: projectSummary,
      relevantFiles: agentLoopPlanFiles,
      // agent-persistence Tur: feed the full repo file list so
      // buildVerifyDiagnostic can surface candidate culprits when a
      // build/test failure points to a framework-generated path.
      repoFilePaths: developerContextFiles.map((f) => f.path),
      // Answer-only runs deliberately omit maxIterations entirely — it would be
      // discarded by the tier block anyway, and setting it would fire
      // [zone-iter-budget-discarded] for a budget that was never meant to travel on
      // this field. Their bound is applied below, after the pipeline spread.
      ...(isAnswerOnlyRun ? {} : { maxIterations: iterBudgetComputed }),
      taskClassification,
      gateLeadVerb: input.gateLeadVerb ?? null,
      gateMode: input.gateMode,
      forceTier: input.forceTier,
      // J.5: thread the prior run's rollback summary (if any) so the
      // agent reads APPLY_ROLLED_BACK markers from previous attempts
      // before re-investigating. Empty string is treated as no-op
      // inside agentLoop.
      priorRunSummary,
      // Phase X.0 C3: stable per-thread cache key for OpenAI so successive
      // runs in the same conversation share a cache hit instead of misses.
      conversationId: typeof input.conversationId === "string" ? input.conversationId : undefined,
      sessionId: input.sessionId,
      // Durable resume: seed prior-run state into the agent loop.
      ...(input.resume ? {
        resumeStagingFiles: input.resume.stagingFiles,
        resumeTodos: input.resume.todos,
        resumeFailureHistory: input.resume.failureHistory,
        resumeContextBlock: input.resume.contextBlock,
        resumeMessages: input.resume.messages,
        envelopeKey: input.resume.envelopeKey,
        resumeAnswer: input.resume.answer,
        resumePendingQuestion: input.resume.pendingQuestion,
      } : {}),
      // Phase X.0.1: forward audit findings so execute agent skips re-investigation.
      auditFindings: input.auditFindings,
      summaryFormat: input.summaryFormat,
      priorSessionSummary: input.priorSessionSummary,
      webSearchEnabled: input.webSearchEnabled,
      interactiveChannel: input.interactiveChannel,
      editApprovalMode: input.editApprovalMode,
      stagedCheckpoint: input.stagedCheckpoint,
      restageSeed: input.restageSeed,
      autoApprove: input.autoApprove,
      images: input.images,
      userHooks: input.userHooks,
      mcpManager: input.mcpManager,
      onPreFlushDiffs: input.showPostFlushDiffs
        ? (diffs: import("./fileDiff.js").StagedFile[]) => {
            if (diffs.length === 0) return;
            emitStructuredProgress({
              type: "post_execute_diffs",
              title: `${diffs.length} file${diffs.length === 1 ? "" : "s"} changed`,
              stagedFilesJson: JSON.stringify(diffs),
            });
          }
        : undefined,
      ...agentLoopCallbacks,
      ...(pipelineCfg && {
        maxIterationsOverride: pipelineCfg.iterCap,
        coachingBudgetOverride: pipelineCfg.coachingBudget,
        pipelineApplied: true,
        originalArchetype: taskClassification?.archetype,
        ...(_dispatcherCapabilityFilter && {
          capabilityFilter: _dispatcherCapabilityFilter,
        }),
      }),
      // The answer-only budget routes through maxIterationsOverride because that is the
      // only one of the two fields that survives the tier block (see MEASURED CAVEAT
      // above). Escalation is disabled as a side effect (agentLoop.ts:2137) — inert for
      // this shape, which is offered no write tool and so can never reach the
      // repeat-apply_patch-failure path escalation exists for.
      //
      // Placed AFTER the pipeline spread deliberately: that spread sets
      // maxIterationsOverride too and would otherwise win on key order. Clamped to the
      // tighter of the two rather than overwriting — QUESTION's iterCap is 3
      // (archetypeDispatcher.ts:58), below ANSWER_ONLY_ITER_BUDGET, and `question` is
      // exactly the archetype an answer-only plan is most likely to carry. Letting 8
      // win there would RELAX a deliberately tighter cap, not bound an unbounded run.
      ...(isAnswerOnlyRun && {
        maxIterationsOverride: Math.min(
          iterBudgetComputed,
          (pipelineCfg as PipelineConfig | null)?.iterCap ?? Number.POSITIVE_INFINITY,
        ),
        // R4: MUST be spread here, outside the `pipelineCfg &&` block above — that
        // block's capabilityFilter is gated on pipelineCfg FIRST and the filter's own
        // truthiness only second, so for a null pipelineCfg (archetype "debug", the
        // measured case) it is skipped entirely and the filter never reaches agentLoop
        // no matter what the variable holds. Setting _dispatcherCapabilityFilter alone
        // would be an inert field, the same shape ANSWER_ONLY_ITER_BUDGET had before it
        // was routed onto a field that actually binds.
        ...(_dispatcherCapabilityFilter && { capabilityFilter: _dispatcherCapabilityFilter }),
      }),
    };

    let loop: AgentLoopResult;
    if (_planOrchestrationEnabled && executionPlan && executionPlan.steps.length >= 2) {
      debugLog("[zone-orchestrator] activated", JSON.stringify({
        runId: runId || null,
        stepCount: executionPlan.steps.length,
      }));
      // Orchestrator owns the sidebar deterministically: seed from the pre-planner's
      // step list once, then drive transitions via setTodoStatus per step. The
      // default (non-orchestrator) flow leaves the sidebar empty until the agent
      // calls TodoWrite in-loop.
      initializeTodosFromPlan();
      const stepResults: AgentLoopResult[] = [];
      for (let stepIdx = 0; stepIdx < executionPlan.steps.length; stepIdx += 1) {
        if (input.abortSignal?.aborted) {
          debugLog("[zone-orchestrator] aborted before step", JSON.stringify({ stepIdx }));
          break;
        }
        const step = executionPlan.steps[stepIdx]!;
        debugLog("[zone-orchestrator] step start", JSON.stringify({
          stepIdx,
          total: executionPlan.steps.length,
          title: String(step.title || "").slice(0, 120),
        }));
        setTodoStatus(todoIdForStepIndex(stepIdx), "in_progress");
        const stepTask = buildStepTask(input.task, stepIdx, executionPlan);
        const stepResult = await runAgentLoop({
          ...agentLoopBaseInput,
          task: stepTask,
        });
        stepResults.push(stepResult);
        setTodoStatus(todoIdForStepIndex(stepIdx), "completed");
        debugLog("[zone-orchestrator] step done", JSON.stringify({
          stepIdx,
          success: stepResult.success,
          filesModified: (stepResult.filesModified || []).length,
        }));
      }
      debugLog("[zone-orchestrator] all steps done", JSON.stringify({
        totalSteps: stepResults.length,
        anyFailures: stepResults.some((r) => !r.success),
      }));
      loop = aggregateOrchestratorResults(stepResults);
    } else {
      loop = await runAgentLoop(agentLoopBaseInput);
      if (executionPlan && isAnswerOnlyPlan(executionPlan) && loop.terminationReason === "token_budget_exceeded") {
        log("[zone-answer-only-budget-exhausted]", JSON.stringify({
          runId: runId || null,
          // Nominal: what was requested. maxIterationsOverride applies only under the
          // > 0 AND < current guards (agentLoop.ts:2364-2367), so a tier whose
          // softIterWarn*3 falls below this value leaves the run bounded LOWER than
          // the nominal budget. Defaults are 45/75/120 (simple/medium/complex) so
          // that cannot happen today, but ~/.zone/tier-limits.json can override
          // softIterWarn (tierLimits.ts:78) and make it happen.
          iterBudget: ANSWER_ONLY_ITER_BUDGET,
          // Effective: what the loop actually ran. Telemetry reports outcome, not
          // intent — a retune driven by the nominal number would be a retune of a
          // number that never applied.
          observedIterCount: loop.iterCount ?? null,
        }));
      }
    }

    if (_costLogPath !== null && latestIterCostUpdate !== null) {
      try { appendRunSummary(_costLogPath, latestIterCostUpdate); } catch { /* best-effort */ }
    }

    // R3: staged-checkpoint outcomes — staging was discarded; exit before post-loop processing.
    if (loop.terminationReason === "staged_rejected") {
      return { ok: false, reason: "staged_rejected" };
    }
    if (loop.terminationReason === "staged_refine_requested") {
      return {
        ok: false,
        reason: "staged_refine_requested",
        ...(loop.refineFeedback !== undefined ? { refineFeedback: loop.refineFeedback } : {}),
        ...(loop.discardedStaging !== undefined ? { discardedStaging: loop.discardedStaging } : {}),
      };
    }

    // Phase H.7: capture token-budget exit at outer-scope lifetime so the
    // final return (way down the function) can flag it for the UI pill.
    if (
      loop.terminationReason === "token_budget_exceeded" ||
      loop.terminationReason === "compaction_exhausted"
    ) {
      tokenBudgetExceededAtExit = true;
    }
    if (loop.terminationReason === "loop_detected" && loop.loopDetected) {
      loopDetectedAtExit = loop.loopDetected;
    }

    filesTouched.push(...(loop.filesModified || []));

    if (toolStreamState.totalDeltas > 0) {
      log("[zone-tool-stream-summary]", JSON.stringify({
        event: "tool_stream_summary",
        runId: runId || null,
        totalDeltas: toolStreamState.totalDeltas,
        totalChars: toolStreamState.totalChars,
        durationMs: Date.now() - toolStreamState.startTs,
        ts: new Date().toISOString(),
      }));
    }

    const agentLoopHadRunCommandFailure = loop.toolCallLog.some((entry) => {
      if (entry.tool !== "run_command") return false;
      const r = String(entry.result || "");
      return (
        /\bexit code:\s*[1-9]\d*\b/i.test(r) ||
        /\bexited with code\s*[1-9]\d*\b/i.test(r) ||
        /\bcommand failed\b/i.test(r) ||
        /\berror\b/i.test(r)
      );
    });

    // Phase J.3.1: when staging was discarded by a regression rollback, the
    // disk is back to pre-apply state and reading "after" from disk would
    // yield an empty diff. Use the staging snapshot the agent forwarded as
    // "after" so the UI can show "what was attempted" cards under the
    // rolled-back banner.
    const stagingForRolledBack = loop.discardedStaging ?? null;
    const stagingByRel: Map<string, string> | null = stagingForRolledBack
      ? new Map(
          [...stagingForRolledBack.entries()].map(([abs, content]) => [
            path.relative(input.repoPath, abs).replace(/\\/g, "/"),
            content,
          ])
        )
      : null;

    const fileDiffs: FileDiff[] = filesTouched.map((rel) => {
      const abs = path.join(input.repoPath, rel);
      const before =
        beforeByFile.get(rel) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
      const after = stagingByRel?.has(rel)
        ? stagingByRel.get(rel)!
        : existsSync(abs) ? readFileSync(abs, "utf8") : "";
      const diff = computeFileDiff(before, after);
      const addedLines = diff.filter((l) => l.type === "added").length;
      const removedLines = diff.filter((l) => l.type === "removed").length;
      return { filePath: rel, diff, addedLines, removedLines };
    });

    // Phase J.3.1: also include any staged paths the agent touched but that
    // didn't get added to filesTouched (some flow combinations only push
    // filesModified post-flush). Without this, regression diffs go missing
    // when filesTouched is empty.
    if (stagingByRel) {
      for (const [rel, after] of stagingByRel) {
        if (filesTouched.includes(rel)) continue;
        const before = beforeByFile.get(rel) ?? "";
        if (before === after) continue;
        const diff = computeFileDiff(before, after);
        const addedLines = diff.filter((l) => l.type === "added").length;
        const removedLines = diff.filter((l) => l.type === "removed").length;
        fileDiffs.push({ filePath: rel, diff, addedLines, removedLines });
      }
    }

    // Y.2.2 defensive: recover diffs for any file snapshotted by onToolCall
    // but absent from filesTouched (i.e., agentLoop skipped filesModified.add).
    for (const [rel, before] of beforeByFile) {
      if (fileDiffs.some((d) => d.filePath === rel)) continue;
      const abs = path.join(input.repoPath, rel);
      const after = stagingByRel?.has(rel)
        ? stagingByRel.get(rel)!
        : existsSync(abs) ? readFileSync(abs, "utf8") : "";
      if (before === after) continue;
      const diff = computeFileDiff(before, after);
      const addedLines = diff.filter((l) => l.type === "added").length;
      const removedLines = diff.filter((l) => l.type === "removed").length;
      fileDiffs.push({ filePath: rel, diff, addedLines, removedLines });
    }

    // Use agent's self-reported verification reason to determine safety
    const vr = loop.verificationReason;
    // Phase J.3: when staging-verification regressed, the agentLoop discarded
    // staging (no permanent flush). Surface this as decisionMode=rolled_back
    // with the regression reason + error preview so the UI can render the
    // "Apply rolled back" amber banner. Take precedence over the normal
    // safe-to-apply / blocked routing.
    const isVerificationRegressed = vr === "verification_regressed";
    const rolledBackErrorPreview = isVerificationRegressed
      ? String(loop.summary || "")
          .split("```")
          .filter((part, idx) => idx % 2 === 1)
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n")
      : "";
    const rolledBackErrorLines = rolledBackErrorPreview
      ? rolledBackErrorPreview.split("\n").filter(Boolean).slice(0, 5)
      : [];
    const rolledBackReason = isVerificationRegressed
      ? (() => {
          const m = String(loop.summary || "").match(
            /Patch added (\d+) new error\(s\)[^.]*\((\d+) before → (\d+) after\)/
          );
          if (m) return `Patch added ${m[1]} new error${m[1] === "1" ? "" : "s"} (${m[2]} → ${m[3]} total)`;
          return "Verification regressed after apply";
        })()
      : "";

    const agentVerificationSummary = deriveAgentVerificationSummary({
      reason: vr,
      loopSuccess: loop.success,
      hadRunCommandFailure: agentLoopHadRunCommandFailure,
    });
    const agentDecisionMode = isVerificationRegressed
      ? "rolled_back"
      : agentVerificationSummary.decisionMode;
    const agentVerificationNote = isVerificationRegressed
      ? "Apply rolled back — verification regressed"
      : agentVerificationSummary.note;

    const warnings: string[] = loop.success ? [] : [`[AGENT_LOOP] ${loop.summary}`];
    if (vr === "tests_inconclusive") {
      warnings.push("[AGENT_LOOP] Tests could not run (environment issue) — manual review recommended.");
    } else if (vr === "tests_failed_by_patch") {
      warnings.push("[AGENT_LOOP] Tests failed because of this patch.");
    } else if (vr === "no_verification_attempted" && agentLoopHadRunCommandFailure) {
      warnings.push("[AGENT_LOOP] A run_command step failed; forcing preview-only.");
    }

    const finalRunReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: [],
      planObjective: "Agent tool loop execution",
      planScopeSummary: null,
      patchSource: fileDiffs.length > 0 ? "agent_loop" : "no_patch",
      fileDiffs,
      patchScope: {
        changedFileCount: fileDiffs.length,
        totalAddedLines: fileDiffs.reduce((s, d) => s + d.addedLines, 0),
        totalRemovedLines: fileDiffs.reduce((s, d) => s + d.removedLines, 0),
        totalChangedLines: fileDiffs.reduce(
          (s, d) => s + d.addedLines + d.removedLines,
          0
        ),
      },
      decisionMode: agentDecisionMode,
      finalState: agentDecisionMode,
      warnings,
      correctness: {
        status: agentDecisionMode === "safe_to_apply" ? "passed" : "skipped",
        summary: agentVerificationNote,
      },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: agentDecisionMode === "safe_to_apply" ? "completed" : "completed_with_issues",
      developerConfidence: 80,
      terminationReason: loop.terminationReason,
    });
    const agentVerificationCommands = collectVerificationCommands(loop.toolCallLog);

    // Phase H.7: surface token-budget exit in the patch flow log so the
    // [zone-token-budget] traces are easy to grep alongside the run.
    if (loop.terminationReason === "token_budget_exceeded") {
      debugLog("[zone-token-budget]", JSON.stringify({
        mode: "patch",
        runId: runId || null,
        outcome: "graceful_exit",
        summaryPreview: loop.summary.slice(0, 200),
      }));
    }
    if (loop.terminationReason === "compaction_exhausted") {
      debugLog("[zone-compaction-exhausted]", JSON.stringify({
        mode: "patch",
        runId: runId || null,
        outcome: "graceful_exit",
        summaryPreview: loop.summary.slice(0, 200),
      }));
    }
    if (loop.terminationReason === "loop_detected") {
      debugLog("[zone-loop-detected]", JSON.stringify({
        mode: "patch",
        runId: runId || null,
        outcome: "graceful_exit",
        toolName: loop.loopDetected?.toolName,
        count: loop.loopDetected?.count,
      }));
    }

    if (runId) {
      finalizeRunTodos(agentDecisionMode === "safe_to_apply" ? "completed" : "skipped");
      emitStructuredProgress({
        type: "agent_loop_complete",
        title: loop.success
          ? "Agent tool loop complete"
          : loop.terminationReason === "token_budget_exceeded"
            ? "Agent stopped at token budget"
            : "Agent tool loop ended with issues",
        detail: loop.summary.slice(0, MAX_FINAL_ANSWER_CHARS),
        status: loop.success ? "success" : "warning",
      });

      // Phase A.7e-fix: chat_response bubble removed.
      // Narration events (A.7a/b) already rendered the agent's final text inline
      // during the last iteration. Emitting chat_response here duplicated that
      // content as a second bubble AFTER "Agent finished". The agent_loop_complete
      // event above (with detail + status) provides failure signal for error cases.
    }

    // Zone Undo Tur 2a: capture a snapshot for safe_to_apply runs so the user
    // can revert via POST /api/runs/:runId/undo. Pre-flush content comes from
    // beforeByFile (orchestrator-tracked); post-flush content is read fresh
    // from disk. A path absent from beforeByFile but present in filesTouched
    // is treated as kind="created" (undo deletes it).
    if (agentDecisionMode === "safe_to_apply" && filesTouched.length > 0) {
      try {
        const { createSnapshot } = await import("../snapshots/snapshotStore.js");
        const snapshotFiles = await Promise.all(
          filesTouched.map(async (relPath) => {
            const abs = path.resolve(input.repoPath, relPath);
            const preFlushText = beforeByFile.get(relPath);
            const preFlushContent =
              preFlushText !== undefined
                ? Buffer.from(preFlushText, "utf8")
                : null;
            const postFlushContent = await readFile(abs);
            return { path: relPath, preFlushContent, postFlushContent };
          })
        );
        const manifest = await createSnapshot({
          runId,
          repoPath: input.repoPath,
          files: snapshotFiles,
        });
        debugLog(
          "[zone-snapshot-created]",
          JSON.stringify({
            runId,
            fileCount: manifest.files.length,
            created: manifest.files.filter((f) => f.kind === "created").length,
            modified: manifest.files.filter((f) => f.kind === "modified").length,
          })
        );
      } catch (err) {
        errorLog(
          "[zone-snapshot-error]",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Background process cleanup: every run kills its own bg processes.
    // Idempotent — safe even if no processes were started this run.
    if (runId) {
      try {
        const { killAllForRun } = await import(
          "../tools/backgroundProcessRegistry.js"
        );
        const result = await killAllForRun(runId);
        if (result.killed > 0) {
          debugLog(
            "[zone-bg-cleanup]",
            JSON.stringify({ runId, killed: result.killed })
          );
        }
      } catch (err) {
        errorLog(
          "[zone-bg-cleanup-error]",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Snapshot retention: run once per run (throttled to at most once per
    // 24h via a marker file mtime) rather than per patch flush, since
    // createSnapshot fires many times per run.
    if (runId) {
      try {
        const { maybeCleanupOldSnapshots } = await import(
          "../snapshots/snapshotStore.js"
        );
        const result = await maybeCleanupOldSnapshots();
        if (result.ran && result.removed > 0) {
          log(
            "[zone-snapshot-cleanup]",
            JSON.stringify({ removed: result.removed })
          );
        }
      } catch (err) {
        errorLog(
          "[zone-snapshot-cleanup-error]",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Envelope retention: same once-per-run, marker-file-throttled pattern as
    // snapshot cleanup above (not CLI-startup — that would run every invocation).
    // Every non-natural-completion exit leaves an envelope behind forever
    // otherwise, since deleteRunEnvelope is only ever called on graceful success.
    if (runId) {
      try {
        const { maybeCleanupOldEnvelopes } = await import(
          "../api/diskRunEnvelope.js"
        );
        const result = await maybeCleanupOldEnvelopes();
        if (result.ran && result.removed > 0) {
          log(
            "[zone-envelope-cleanup]",
            JSON.stringify({ removed: result.removed })
          );
        }
      } catch (err) {
        errorLog(
          "[zone-envelope-cleanup-error]",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (runId) {
      const summary = assembleRunSummary({
        fileDiffs,
        toolCallLog: loop.toolCallLog,
        verificationReason: vr,
        verificationNote: agentVerificationNote,
        verificationCommands: agentVerificationCommands,
        decisionMode: agentDecisionMode,
        totalUsd: getRunCost(input.userId ?? "local-dev", runId),
        iterCost: latestIterCostUpdate,
      });
      emitStructuredProgress({
        type: "run_summary",
        title: "Run summary",
        status: "success",
        ...summary,
      });
    }

    if (isVerificationRegressed) {
      console.warn("[zone-rollback]", JSON.stringify({
        runId: runId || null,
        reason: rolledBackReason,
        errorCount: rolledBackErrorLines.length,
      }));
    }

    return {
      ok: true,
      patchPreview: `=== AGENT LOOP SUMMARY ===\n${loop.summary}`,
      warnings,
      developerConfidence: 80,
      reason: "agent_loop",
      patchSource: fileDiffs.length > 0 ? "agent_loop" : "no_patch",
      patchesAlreadyApplied: fileDiffs.length > 0 && agentDecisionMode === "safe_to_apply",
      verificationReason: vr,
      verificationNote: agentVerificationNote,
      verificationCommands: agentVerificationCommands,
      decisionMode: agentDecisionMode,
      finalState: agentDecisionMode,
      ...(isVerificationRegressed
        ? {
            rolledBackReason,
            rolledBackErrors: rolledBackErrorLines,
          }
        : {}),
      finalExecutionOutcome: agentDecisionMode === "safe_to_apply" ? "completed" : "completed_with_issues",
      applyPatches: [],
      patchResults: [],
      fileDiffs,
      contextFiles: [],
      lifecycleEvents,
      finalRunReport,
      ...(taskClassification ? { taskClassification } : {}),
      promotedFromArchetype: loop.promotedFromArchetype ?? null,
    };
  }

  // 3. Rank relevant files — top 8 (full ranking reused for diagnostics + budget trim)
  reportProgress("Ranking relevant files...");
  debugLog("[debug-mem] runLlmPatchFlow lastChangedFiles:", input.lastChangedFiles);
  const lastAddedFunctions =
    Array.isArray(input.lastAddedFunctions)
      ? (input.lastAddedFunctions as unknown[])
          .filter((x) => typeof x === "string" && x.trim())
          .map((x) => String(x).trim())
          .slice(0, 8)
      : [];
  const rankingTask =
    lastAddedFunctions.length > 0
      ? `${input.task}\n\nRecent function names: ${lastAddedFunctions.join(", ")}`
      : input.task;
  let semanticScores: Map<string, number> | undefined;
  const canUseSemanticRanking =
    repoPathLooksLocal &&
    typeof input.repoPath === "string" &&
    input.repoPath.length > 0 &&
    developerContextFiles.length > 0 &&
    developerContextFiles.every(
      (file) => typeof file.absolutePath === "string" && file.absolutePath.length > 0
    ) &&
    isEmbeddingBackendAvailable();

  debugLog("[zone-embed-block-entry] entering embedding section", {
    canUseSemanticRanking,
    repoPathLooksLocal,
    developerContextFileCount: developerContextFiles.length,
  });

  if (canUseSemanticRanking) {
    try {
      const embeddableFiles = (
        await Promise.all(
          developerContextFiles.map(async (file) => ({
            path: file.path,
            content: await readFile(String(file.absolutePath), "utf8").catch(() => ""),
          }))
        )
      ).filter((file) => file.content.length > 0);

      const existingEmbeddingCount = await getEmbeddingCountForRepo(input.repoPath);
      if (existingEmbeddingCount === 0) {
        await indexRepoFiles({
          repoPath: input.repoPath,
          files: embeddableFiles,
        });
      } else {
        void indexRepoFiles({
          repoPath: input.repoPath,
          files: embeddableFiles,
        }).catch((error) => {
          console.warn(
            "[zone-embed-bg-error]",
            error instanceof Error ? error.message : String(error)
          );
        });
      }

      const queryEmbedding = await embedText(input.task);
      const matches =
        queryEmbedding === null
          ? []
          : await matchSimilarFiles({
              repoPath: input.repoPath,
              queryEmbedding,
              matchCount: 30,
            });
      if (queryEmbedding === null) {
        debugLog("[zone-embed-pre-rank]", {
          hasEmbeddings: false,
          queryEmbeddingDims: 0,
          topMatchCount: 0,
          semanticScoresSize: 0,
          skipped: true,
          reason: "no_query_embedding",
        });
      }
      semanticScores = new Map(
        matches
          .filter(
            (match) =>
              typeof match.filePath === "string" &&
              match.filePath.trim().length > 0 &&
              Number.isFinite(match.similarity)
          )
          .map((match) => [match.filePath, match.similarity])
      );
      debugLog("[zone-embed-pre-rank]", {
        hasEmbeddings: existingEmbeddingCount > 0 || matches.length > 0,
        queryEmbeddingDims: Array.isArray(queryEmbedding) ? queryEmbedding.length : 0,
        topMatchCount: matches.length,
        semanticScoresSize: semanticScores.size,
      });
      debugLog("[zone-embed-query-debug]", {
        task: input.task,
        topMatches: matches.slice(0, 5),
      });
    } catch (error) {
      console.warn(
        "[zone-embed-bg-error]",
        error instanceof Error ? error.message : String(error)
      );
      semanticScores = undefined;
    }
  } else {
    debugLog("[zone-embed-pre-rank]", {
      hasEmbeddings: false,
      queryEmbeddingDims: 0,
      topMatchCount: 0,
      semanticScoresSize: 0,
      skipped: true,
      repoPathLooksLocal,
      developerContextFileCount: developerContextFiles.length,
    });
  }
  const readContentForRanker = async (relPath: string): Promise<string | null> => {
    try {
      return await readFile(path.join(input.repoPath, relPath), "utf8");
    } catch {
      return null;
    }
  };
  let fullRankedFiles = await rankRelevantFiles({
    task: rankingTask,
    files: developerContextFiles,
    intent: taskIntent,
    semanticScores,
    lastChangedFiles: Array.isArray(input.lastChangedFiles)
      ? (input.lastChangedFiles as unknown[])
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined,
    readContent: readContentForRanker,
  });

  // Multi-turn memory: only boost lastChangedFiles when they are still semantically relevant
  // to the current task. This prevents unrelated previous edits from displacing better candidates.
  try {
    const lastChanged =
      Array.isArray(input.lastChangedFiles)
        ? (input.lastChangedFiles as unknown[])
            .filter((x) => typeof x === "string" && x.trim())
            .map((x) => String(x).trim())
            .slice(0, 10)
        : [];
    if (lastChanged.length > 0 && Array.isArray(fullRankedFiles)) {
      debugLog(
        "[debug-mem] before boost ranked:",
        fullRankedFiles.map((f) => f.path)
      );

      const maxKeep = fullRankedFiles.length; // N from rankRelevantFiles (default 5 unless env overrides)
      const rankedList = [...fullRankedFiles] as RankedRepoFile[];
      const currentTopPaths = new Set(rankedList.slice(0, 5).map((file) => file.path));

      const repoByPath = new Map<string, RepoFile>();
      for (const f of developerContextFiles) repoByPath.set(f.path, f);

      const MINIMUM_KEYWORD_SCORE = 5;
      for (const p of lastChanged) {
        const similarity = Number(semanticScores?.get(p) ?? 0);
        const rankedHit = rankedList.find((file) => file.path === p);
        const pathScore = Number(rankedHit?.score ?? 0);
        const semanticOk = Number.isFinite(similarity) && similarity >= 0.3;
        const keywordOk = pathScore >= MINIMUM_KEYWORD_SCORE;
        if (!semanticOk && !keywordOk) {
          debugLog("[debug-mem] boost decision:", {
            file: p,
            similarity,
            pathScore,
            boosted: false,
            reason: "low_semantic_and_low_path_score",
          });
          continue;
        }

        const existingIndex = rankedList.findIndex((file) => file.path === p);
        if (existingIndex >= 0 && existingIndex < 5) {
          debugLog("[debug-mem] boost decision:", {
            file: p,
            similarity,
            pathScore,
            boosted: false,
            reason: "already_in_top_5",
          });
          continue;
        }

        if (!semanticOk && !keywordOk) {
          // already filtered above; defensive
          continue;
        }
        if (!semanticScores?.has(p) && !keywordOk) {
          debugLog("[debug-mem] boost decision:", {
            file: p,
            similarity,
            pathScore,
            boosted: false,
            reason: "not_in_top_30_semantic_matches_and_low_path_score",
          });
          continue;
        }

        if (existingIndex >= 0) {
          const [existing] = rankedList.splice(existingIndex, 1);
          if (existing) {
            rankedList.splice(1, 0, {
              ...existing,
              score: Math.max(existing.score, rankedList[0]?.score ?? existing.score) + 1,
            });
            currentTopPaths.add(p);
            debugLog("[debug-mem] boost decision:", {
              file: p,
              similarity,
              boosted: true,
              reason: "semantic_match_inserted",
            });
          }
          continue;
        }

        const repoHit = repoByPath.get(p);
        if (!repoHit) {
          debugLog("[debug-mem] boost decision:", {
            file: p,
            similarity,
            boosted: false,
            reason: "file_not_found_in_repo",
          });
          continue;
        }

        const insertedScore = (rankedList[0]?.score ?? 0) + 1;
        rankedList.splice(1, 0, {
          ...(repoHit as RankedRepoFile),
          score: insertedScore,
        });
        currentTopPaths.add(p);
        debugLog("[debug-mem] boost decision:", {
          file: p,
          similarity,
          boosted: true,
          reason: "semantic_match_added",
        });
      }

      if (rankedList.length > 0) {
        fullRankedFiles = rankedList.slice(0, maxKeep);
        debugLog("[zone-ranker-boost-last-changed]", {
          boosted: lastChanged.filter((path) => fullRankedFiles.some((file) => file.path === path)),
          maxKeep,
        });
        debugLog(
          "[debug-mem] after boost ranked:",
          fullRankedFiles.map((f) => f.path)
        );
        debugLog(
          "[debug-mem] ranked files after boost:",
          fullRankedFiles.map((f) => ({ path: f.path, score: f.score }))
        );
      }
    }
  } catch {
    // best-effort only
  }
  if (explicitTargetRepoFile) {
    debugLog("[zone-explicit-target-forced-into-ranking]", explicitTargetRepoFile.path);
    fullRankedFiles = mergeExplicitRepoFileIntoRankedFiles(fullRankedFiles, explicitTargetRepoFile);
  }
  let relevantFiles = fullRankedFiles.slice(0, getMaxContextFiles());
  if (explicitTargetRepoFile) {
    const explicitRankedFile: RankedRepoFile = {
      ...explicitTargetRepoFile,
      score: Math.max(...fullRankedFiles.map((file) => file.score), 0) + 10_000,
    };
    // Explicit target mode: keep planning context ultra-minimal to avoid token overflow and
    // ensure the model focuses on the requested file.
    debugLog("[zone-context-mode] explicit_single_file_mode");
    relevantFiles = [explicitRankedFile];
  }
  perf.mark("relevant files ranked");
  notifyProgress("Ranking relevant files...", {
    type: "relevant_files_ranked",
    message: `Ranked ${fullRankedFiles.length} paths; using top ${relevantFiles.length} for planning.`,
    stage: "rank",
    status: "ok",
  });
  emitStructuredProgress({
    type: "ranking_context",
    title: "Finding relevant files",
    status: "active",
  });

  // Multi-turn memory: conversationHistory + priorRunSummary loaded earlier
  // (before the agent_loop branch) so both paths share the same data.
  // Nothing to do here — variables are already in scope.

  const lastChangedFiles =
    Array.isArray(input.lastChangedFiles)
      ? (input.lastChangedFiles as unknown[])
          .filter((x) => typeof x === "string" && x.trim())
          .map((x) => String(x).trim())
          .slice(0, 20)
      : [];

  const skipPlanner = (process.env.SKIP_PLANNER ?? "").trim().toLowerCase() === "true";
  let plannerSelection: PlannerStepOutput | null = null;
  const hasRealHostedContext = hostedDeveloperContextHasHostedFiles(
    input.hostedContext
  );
  if (!skipPlanner && !hasRealHostedContext && !explicitTargetRepoFile) {
    try {
      plannerSelection = await plannerStep({
        task: input.task,
        rankedFilePaths: relevantFiles.map((f) => f.path),
        repoSummary: projectSummary,
        framework,
        repoPath: input.repoPath,
        allRepoFilePaths: developerContextFiles.map((f) => f.path),
        conversationHistory,
        lastChangedFiles,
        lastAddedFunctions,
      });
    } catch {
      plannerSelection = null;
    }
    if (plannerSelection?.filesToEdit?.length) {
      emitStructuredProgress({
        type: "planner_result",
        title: "Planner result",
        status: "success",
        planner: {
          changeDescription: plannerSelection.changeDescription,
          strategy: plannerSelection.strategy,
          filesToEdit: plannerSelection.filesToEdit,
          relatedFiles: plannerSelection.relatedFiles ?? [],
          warnings:
            plannerSelection.dependencyWarnings?.length > 0
              ? plannerSelection.dependencyWarnings
              : undefined,
        },
      });
    }
    if (plannerSelection?.filesToEdit?.length) {
      const allowed = new Set(plannerSelection.filesToEdit);
      relevantFiles = relevantFiles.filter((f) => allowed.has(f.path));
    }
  }

  // Even with explicit target, build dep graph for context
  if (explicitTargetRepoFile && !hasRealHostedContext) {
    try {
      const { buildDependencyGraph } = await import("../repo/buildDependencyGraph.js");
      const { getRelatedFiles } = await import("../repo/getRelatedFiles.js");
      const allPaths = developerContextFiles.map((f) => f.path);
      const graph = await buildDependencyGraph(input.repoPath, allPaths);
      const related = getRelatedFiles([explicitTargetRepoFile.path], graph, 5);
      debugLog("[zone-dep-graph-explicit]", {
        target: explicitTargetRepoFile.path,
        relatedCount: related.length,
        related: related.map((f) => f.filePath + ":" + f.relationship),
      });
    } catch (err) {
      debugLog(
        "[zone-dep-graph-explicit-error]",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  if ((process.env.DEBUG_PLANNER ?? "").trim().toLowerCase() === "true") {
    debugLog("[planner]", {
      rankedCount: fullRankedFiles.length,
      selectedCount: plannerSelection?.filesToEdit?.length ?? 0,
      selectedPaths: plannerSelection?.filesToEdit ?? [],
      changeDescription: plannerSelection?.changeDescription ?? "",
      strategy: plannerSelection?.strategy ?? "",
      relatedFiles: plannerSelection?.relatedFiles ?? [],
    });
  }

  // TEMP DIAGNOSTIC: surface top 20 ranker scores to verify PatientsPage presence
  debugLog(
    "[zone-diag-ranker]",
    JSON.stringify({
      totalFiles: developerContextFiles.length,
      totalRanked: fullRankedFiles.length,
      top20: fullRankedFiles.slice(0, 20).map((f) => ({
        path: f.path,
        score: f.score,
      })),
      patientsMatches: fullRankedFiles
        .filter((f) => f.path.toLowerCase().includes("patient"))
        .map((f) => ({ path: f.path, score: f.score })),
    })
  );

  const existingFilesSummary =
    input.hostedContext?.existingFilesSummary ??
    (() => {
      const topRelevantPaths = relevantFiles
        .slice(0, 4)
        .map((file) => file.path);
      return topRelevantPaths.length > 0
        ? "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n" +
            topRelevantPaths.map((filePath) => `- ${filePath}`).join("\n")
        : "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n(none)";
    })();

  if (input.preGeneratedPlan) {
    executionPlan = input.preGeneratedPlan;
    debugLog(`[zone-plan] using preGeneratedPlan steps=${executionPlan.steps.length}`);
  } else if (!(pipelineCfg as PipelineConfig | null)?.skipPlan) {
    try {
      executionPlan = await generateExecutionPlan({
        task: input.task,
        repoSummary: projectSummary,
        relevantFiles: relevantFiles.map((file) => file.path),
        userApiKey: input.userApiKey,
        provider: input.provider,
        archetype: (input.preClassifiedTask?.archetype as string | undefined),
      });
      debugLog(`[zone-plan] generated steps=${executionPlan.steps.length}`);
      debugLog(`[zone-plan] scope=${executionPlan.scopeSummary}`);
      // Sidebar is seeded by the in-loop TodoWrite tool now; pre-planner only
      // feeds scopeGuard / evaluatePlanAlignment / orchestrator / finalRunReport.
    } catch (err) {
      debugLog(
        `[zone-plan] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const planStepCount = executionPlan?.steps.length ?? 0;
  const isComplexTaskPreview =
    executionPlan != null && planStepCount >= 2;
  debugLog("[zone-plan-debug]", {
    planStepCount,
    isComplexTask: isComplexTaskPreview,
  });
  /** Tur P1: lowered threshold from "≥4 steps + ≥2 files" to "≥2 steps" so multi-task prompts surface the plan checklist. P2 will remove the gate entirely (always emit, UI decides). */
  const isComplexTask = isComplexTaskPreview;
  void isComplexTask;

  const planSummaryParts: string[] = [];
  if (executionPlan) {
    planSummaryParts.push(
      `${executionPlan.steps.length} execution step(s); scope: ${executionPlan.scopeSummary}`
    );
  }

  if (!(pipelineCfg as PipelineConfig | null)?.skipPlanSSE) {
    notifyProgress("Planning feature...", {
      type: "plan_created",
      message:
        planSummaryParts.length > 0
          ? `Planning complete (${planSummaryParts.join(" · ")}).`
          : "Planning complete (execution + feature context ready).",
      stage: "plan",
      status: executionPlan ? "execution_plan" : "feature_skipped",
    });
  }

  const explicitTargetForceContentByPath = new Map<string, string>();

  // 5. Read top suggested files
  const relevantFileScores = new Map(
    relevantFiles.map((file) => [file.path, file.score])
  );
  const plannerSuggestedPaths = plannerSelection?.filesToEdit?.slice(0, getMaxContextFiles()) ?? [];
  const plannerSuggestedPathSet = new Set(plannerSuggestedPaths);
  let preliminaryContextFiles =
    input.hostedContext?.contextFiles.map((file) => ({
      path: file.path,
      action: file.action,
      reason: file.reason,
    })) ??
    [
      ...plannerSuggestedPaths.map((filePath) => ({
        path: filePath,
        action: "inspect",
        reason: "Planner identified this file as the most relevant patch target",
      })),
      ...relevantFiles.map((file) => ({
        path: file.path,
        action: "inspect",
        reason: "High repo relevance for the requested developer task",
      })),
    ]
      .filter((file) => !isIrrelevantDeveloperContextPath(file.path))
      .filter(
        (file, index, files) =>
          files.findIndex((candidate) => candidate.path === file.path) === index
      )
      .slice(0, 6);

  if (!skipPlanner && plannerSelection?.filesToEdit?.length) {
    const allowed = new Set(plannerSelection.filesToEdit);
    preliminaryContextFiles = preliminaryContextFiles.filter((f) => allowed.has(f.path));
  }

  reportProgress("Loading file context...");
  let selectedContextFiles = preliminaryContextFiles;
  let resolvedFileContexts: Array<{ path: string; content: string }>;
  if (input.hostedContext) {
    resolvedFileContexts = input.hostedContext.contextFiles.map((file) => ({
      path: file.path,
      content: file.content,
    }));
  } else {
    const filePaths = preliminaryContextFiles
      .map((f) => developerContextFiles.find((rf) => rf.path === f.path)?.absolutePath)
      .filter((p): p is string => typeof p === "string");

    // Primary file: first in planner's filesToEdit list — gets expanded context budget
    const _primaryRelPath = plannerSelection?.filesToEdit?.[0] ?? null;
    const _primaryAbsPath = _primaryRelPath
      ? (developerContextFiles.find((rf) => rf.path === _primaryRelPath)?.absolutePath ?? null)
      : (filePaths[0] ?? null);

    const fileContentsMap = await readProjectFiles(filePaths, {
      primaryFile: _primaryAbsPath ?? undefined,
      primaryMaxChars: 50_000,
    });
    resolvedFileContexts = preliminaryContextFiles
      .map((file) => {
        const absolutePath = developerContextFiles.find((rf) => rf.path === file.path)?.absolutePath;
        if (!absolutePath) {
          return null;
        }

        return {
          path: file.path,
          content: fileContentsMap[absolutePath] ?? "",
        };
      })
      .filter((file): file is { path: string; content: string } => file !== null);

    const constraintAwareScores = new Map(
      resolvedFileContexts.map((file) => [
        file.path,
        scoreConstraintAwareContextFile({
          task: input.task,
          content: file.content,
        }),
      ])
    );

    selectedContextFiles = [...preliminaryContextFiles]
      .sort((a, b) => {
        const constraintDifference =
          (constraintAwareScores.get(b.path) ?? 0) - (constraintAwareScores.get(a.path) ?? 0);
        if (constraintDifference !== 0) {
          return constraintDifference;
        }

        const scoreDifference =
          (relevantFileScores.get(b.path) ?? -1) - (relevantFileScores.get(a.path) ?? -1);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return a.path.localeCompare(b.path);
      })
      .slice(0, Math.max(4, getMaxContextFiles()));

    if (plannerSuggestedPaths.length > 0) {
      const selectedByPath = new Map(
        selectedContextFiles.map((file) => [file.path, file] as const)
      );
      const preliminaryByPath = new Map(
        preliminaryContextFiles.map((file) => [file.path, file] as const)
      );
      const prioritized = plannerSuggestedPaths
        .map((filePath) => selectedByPath.get(filePath) ?? preliminaryByPath.get(filePath))
        .filter((file): file is { path: string; action: string; reason: string } => file != null);
      const remainder = selectedContextFiles.filter(
        (file) => !plannerSuggestedPathSet.has(file.path)
      );
      selectedContextFiles = [...prioritized, ...remainder].slice(0, getMaxContextFiles());
    } else {
      selectedContextFiles = selectedContextFiles.slice(0, getMaxContextFiles());
    }

    const fileContextByPath = new Map(
      resolvedFileContexts.map((file) => [file.path, file] as const)
    );
    resolvedFileContexts = selectedContextFiles
      .map((file) => fileContextByPath.get(file.path))
      .filter((file): file is { path: string; content: string } => file !== undefined);

    if (plannerSelection?.relatedFiles?.length) {
      const primaryPaths = new Set(resolvedFileContexts.map((f) => f.path));
      const relatedSorted = [...plannerSelection.relatedFiles]
        .filter((r) => !primaryPaths.has(r.filePath))
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
        .slice(0, 6);
      const relAbsPaths: string[] = [];
      const labelByAbs = new Map<string, string>();
      for (const r of relatedSorted) {
        const abs = developerContextFiles.find((df) => df.path === r.filePath)?.absolutePath;
        if (!abs) continue;
        relAbsPaths.push(abs);
        labelByAbs.set(
          abs,
          `// [RELATED - ${r.relationship}] ${r.filePath}`
        );
      }
      if (relAbsPaths.length > 0) {
        const relMap = await readProjectFiles(relAbsPaths, {
          maxFiles: relAbsPaths.length,
          maxCharsPerFile: 5000,
        });
        for (const abs of relAbsPaths) {
          const relPath = developerContextFiles.find((df) => df.absolutePath === abs)?.path;
          if (!relPath || primaryPaths.has(relPath)) continue;
          const raw = relMap[abs] ?? "";
          const label = labelByAbs.get(abs) ?? `// [RELATED] ${relPath}`;
          resolvedFileContexts.push({
            path: relPath,
            content: `${label}\n${raw}`,
          });
          primaryPaths.add(relPath);
        }
      }
    }

    debugLog("[zone-context-priority]", {
      plannerSuggested: plannerSuggestedPaths,
      rankerTop5: relevantFiles.slice(0, getMaxContextFiles()).map((file) => file.path),
      finalContext: selectedContextFiles.map((file) => file.path),
    });
  }

  if (explicitTargetRepoFile) {
    if (
      !isIrrelevantDeveloperContextPath(explicitTargetRepoFile.path) &&
      !isProtectedDeveloperUiPath(explicitTargetRepoFile.path)
    ) {
      const canon = explicitTargetRepoFile.path;
      explicitTargetCanonicalPath = canon;
      let targetContent: string | null = null;
      const existing = resolvedFileContexts.find((f) => f.path === canon);
      if (existing && typeof existing.content === "string") {
        targetContent = existing.content;
      }
      if (!targetContent) {
        const loadedContent = await loadExplicitTargetFileContentForPatchContext({
          canonPath: canon,
          hostedContext: input.hostedContext,
          allFiles,
        });
        explicitTargetForceContentByPath.set(canon, loadedContent);
        debugLog("[zone-explicit-target-forced-into-context]", canon);
        debugLog("[zone-explicit-target-force-included]", canon);
        targetContent = loadedContent;
      }

      // Explicit target mode: override any ranked/hosted context and send only the target file.
      resolvedFileContexts = [
        {
          path: canon,
          content: targetContent,
        },
      ];
      selectedContextFiles = [
        {
          path: canon,
          action: "inspect",
          reason: "Explicit target file from user prompt",
        },
      ];
    }
  }

  debugLog("[zone-context-files-count]", resolvedFileContexts.length);
  perf.mark("file context loaded");
  notifyProgress("Loading file context...", {
    type: "file_context_loaded",
    message: `Loaded ${resolvedFileContexts.length} file context(s) for patch generation.`,
    stage: "context",
    status: "ok",
  });
  emitStructuredProgress({
    type: "context_ready",
    title: "Loaded focused context",
    detail: `${resolvedFileContexts.length} files`,
    status: "success",
  });
  // ── TOKEN BUDGET GUARD ──────────────────────────────────────────
  const SIMPLE_BUDGET_CHARS = 320_000; // ~80K tokens (4o-mini)
  const COMPLEX_BUDGET_CHARS = 320_000; // ~80K tokens (4.1-mini)
  const MAX_BUDGET_CHARS = 200_000;     // ZONE_CONTEXT_BUDGET=max override
  const taskCharBudget = input.task?.length ?? 0;
  const sumContextChars = (files: Array<{ path: string; content: string }>) =>
    files.reduce((sum, file) => sum + (file.content?.length ?? 0), 0) + taskCharBudget;

  // ZONE_CONTEXT_BUDGET env override
  const _budgetEnv = String(process.env["ZONE_CONTEXT_BUDGET"] || "").trim().toLowerCase();
  let contextBudgetWarnings: string[] = [];
  let contextBudget = _budgetEnv === "max"
    ? MAX_BUDGET_CHARS
    : _budgetEnv === "simple"
      ? SIMPLE_BUDGET_CHARS
      : _budgetEnv === "complex"
        ? COMPLEX_BUDGET_CHARS
        : resolvedFileContexts.length <= 6 ? SIMPLE_BUDGET_CHARS : COMPLEX_BUDGET_CHARS;
  let totalContextChars = sumContextChars(resolvedFileContexts);

  // Diagnostic: context budget usage
  const _primaryCtxFile = (resolvedFileContexts[0]?.path) ?? null;
  const _primaryCtxChars = (resolvedFileContexts[0]?.content?.length) ?? 0;
  const _secondaryChars = resolvedFileContexts.slice(1).reduce(
    (s, f) => s + (f.content?.length ?? 0), 0
  );
  debugLog("[zone-context-budget]", JSON.stringify({
    totalFiles: resolvedFileContexts.length,
    primaryFile: _primaryCtxFile,
    primaryFileChars: _primaryCtxChars,
    secondaryFilesChars: _secondaryChars,
    totalContextChars,
    budget: contextBudget,
    withinBudget: totalContextChars <= contextBudget,
    budgetOverride: _budgetEnv || null,
  }));

  if (totalContextChars > contextBudget) {
    const originalFileCount = resolvedFileContexts.length;
    const trimPinned =
      explicitTargetCanonicalPath !== null &&
      resolvedFileContextsIncludePath(resolvedFileContexts, explicitTargetCanonicalPath)
        ? [explicitTargetCanonicalPath]
        : [];
    const trimmedPaths = selectRankedContextPathsWithinCap(
      resolvedFileContexts,
      fullRankedFiles,
      HOSTED_CONTEXT_BUDGET_TRIM_CAP,
      trimPinned
    );
    const pathToContent = new Map(
      resolvedFileContexts.map((file) => [file.path, file.content] as const)
    );
    const metaSources = input.hostedContext?.contextFiles ?? preliminaryContextFiles;
    const pathToMeta = new Map(
      metaSources.map((file) => [file.path, { action: file.action, reason: file.reason }] as const)
    );

    resolvedFileContexts = trimmedPaths.map((path) => ({
      path,
      content: pathToContent.get(path) ?? "",
    }));
    selectedContextFiles = trimmedPaths.map((path) => {
      if (
        explicitTargetCanonicalPath !== null &&
        path === explicitTargetCanonicalPath
      ) {
        return {
          path,
          action: "inspect" as const,
          reason: "Explicit target file from user prompt",
        };
      }
      const meta = pathToMeta.get(path);
      return {
        path,
        action: meta?.action ?? "inspect",
        reason: meta?.reason ?? "Retained for patch context after budget trim",
      };
    });

    contextBudget =
      resolvedFileContexts.length <= 6 ? SIMPLE_BUDGET_CHARS : COMPLEX_BUDGET_CHARS;
    totalContextChars = sumContextChars(resolvedFileContexts);

    const trimmedFileCount = resolvedFileContexts.length;
    const retainedPaths = resolvedFileContexts.map((file) => file.path);
    debugLog(
      "[zone-diag-context-trim]",
      JSON.stringify({
        originalFileCount,
        trimmedFileCount,
        retainedPaths,
      })
    );

    if (originalFileCount > trimmedFileCount) {
      contextBudgetWarnings.push(
        `[hosted_context_trimmed_to_budget] Trimmed developer context from ${originalFileCount} to ${trimmedFileCount} files to fit the token budget.`
      );
    }
  }

  if (explicitTargetRepoFile) {
    if (
      !isIrrelevantDeveloperContextPath(explicitTargetRepoFile.path) &&
      !isProtectedDeveloperUiPath(explicitTargetRepoFile.path)
    ) {
      const canonAfterTrim = explicitTargetRepoFile.path;
      if (!resolvedFileContextsIncludePath(resolvedFileContexts, canonAfterTrim)) {
        const reinjectedContent = await loadExplicitTargetFileContentForPatchContext({
          canonPath: canonAfterTrim,
          hostedContext: input.hostedContext,
          allFiles,
        });
        explicitTargetForceContentByPath.set(canonAfterTrim, reinjectedContent);
        debugLog("[zone-explicit-target-forced-into-context]", canonAfterTrim);
        debugLog("[zone-explicit-target-force-included]", canonAfterTrim);
        resolvedFileContexts.unshift({
          path: canonAfterTrim,
          content: reinjectedContent,
        });
        selectedContextFiles.unshift({
          path: canonAfterTrim,
          action: "inspect",
          reason: "Explicit target file from user prompt",
        });
        if (explicitTargetCanonicalPath === null) {
          explicitTargetCanonicalPath = canonAfterTrim;
        }
        totalContextChars = sumContextChars(resolvedFileContexts);
        contextBudget =
          resolvedFileContexts.length <= 6 ? SIMPLE_BUDGET_CHARS : COMPLEX_BUDGET_CHARS;
      }
    }
  }

  if (totalContextChars > contextBudget) {
    debugLog("[zone-flow-early-return]", JSON.stringify({ step: "context_budget_exceeded", totalContextChars: typeof totalContextChars !== "undefined" ? totalContextChars : null }));
    perf.finish("context budget exceeded");
    notifyProgress("Ready", {
      type: "tooling_issue",
      message: "Developer context exceeds the token budget for this run.",
      stage: "context",
      status: "context_budget_exceeded",
    });
    notifyProgress("Ready", {
      type: "run_completed",
      message: "Run finished with errors.",
      stage: "finalize",
      status: "failed",
    });
    const contextBudgetReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: selectedContextFiles.map((f) => ({
        path: f.path,
        reason: f.reason,
      })),
      planObjective: executionPlan?.objective ?? null,
      planScopeSummary: executionPlan?.scopeSummary ?? null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "safe_to_apply",
      warnings: [
        `Context too large (${Math.round(totalContextChars / 4000)}K tokens). Limit ${Math.round(contextBudget / 4000)}K tokens.`,
      ],
      correctness: { status: "skipped", summary: "Run stopped before patch preview (context budget)." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "failed",
    });
    return {
      ok: false,
      reason: `Context too large (${Math.round(totalContextChars / 4000)}K tokens). ` +
        `Limit is ${Math.round(contextBudget / 4000)}K tokens. ` +
        `Select a smaller folder or specify exact files to change.`,
      lifecycleEvents: [...lifecycleEvents],
      finalRunReport: contextBudgetReport,
    };
  }
  perf.mark("token budget checked");
  // 6. Plan patch preview with LLM
  reportProgress("Planning patch preview...");
  const projectNotesForPatchPreview =
    plannerSelection?.dependencyContextForPrompt?.trim()
      ? [...projectNotes, plannerSelection.dependencyContextForPrompt]
      : projectNotes;
  let patchPlan: Awaited<ReturnType<typeof planPatchPreviewWithLlm>>;
  try {
    perf.mark("patch preview model call start");
    patchPlan = await planPatchPreviewWithLlm({
      task: input.task,
      intent: taskIntent,
      projectSummary,
      projectNotes: projectNotesForPatchPreview,
      suggestedFiles: selectedContextFiles,
      fileContexts: resolvedFileContexts,
      schemaAwareSummary: [],
      executionPlan,
    });
    perf.mark("patch preview model response received");
  } catch (err) {
    debugLog("[zone-flow-early-return]", JSON.stringify({ step: "patch_preview_failed", reason: "patch_preview_failed" }));
    perf.finish("patch preview failed");
    const reason = err instanceof Error ? err.message : String(err);
    notifyProgress("Ready", {
      type: "patch_generation_failed",
      message: `Patch preview planning failed: ${reason}`,
      stage: "patch_preview",
      status: "patch_preview_error",
    });
    notifyProgress("Ready", {
      type: "run_completed",
      message: "Run finished with errors.",
      stage: "finalize",
      status: "failed",
    });
    const previewFailReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: selectedContextFiles.map((f) => ({
        path: f.path,
        reason: f.reason,
      })),
      planObjective: executionPlan?.objective ?? null,
      planScopeSummary: executionPlan?.scopeSummary ?? null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "safe_to_apply",
      warnings: [`Patch preview planning failed: ${reason}`],
      correctness: { status: "skipped", summary: "Run stopped during patch preview planning." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "failed",
    });
    return {
      ok: false,
      reason,
      lifecycleEvents: [...lifecycleEvents],
      finalRunReport: previewFailReport,
    };
  }
  debugLog("[zone-preview] received (ignored for patch application)");
  if (input.hostedContext) {
    patchPlan = {
      ...patchPlan,
      patches: patchPlan.patches.filter((p) => {
        if (
          Object.prototype.hasOwnProperty.call(
            input.hostedContext!.originalContents,
            p.path
          )
        ) {
          return true;
        }
        if (input.hostedContext!.contextFiles.some((cf) => cf.path === p.path)) {
          return true;
        }
        return explicitTargetForceContentByPath.has(p.path);
      }),
    };
    debugLog("[hosted] filtered patches count:", patchPlan.patches.length);
  }

  const vagueTask = isVagueDeveloperTask(input.task);
  let selectedTargetFile = patchPlan.patches[0]?.path ?? null;
  // Task-level risk scoring for developer
  const taskRiskResult = computeRiskScore({ task: input.task, role: "developer", codeIntent: taskIntent.codeIntent });
  logRiskDebug("runLlmPatchFlow taskRiskResult", {
    task: input.task,
    taskRiskResult,
  });
  const taskRiskPreviewOnlyThreshold =
    process.env.NODE_ENV !== "production" ? 95 : 71;
  if (taskRiskResult.score >= taskRiskPreviewOnlyThreshold) {
    notifyProgress("Ready", {
      type: "patch_generation_failed",
      message: `Patch generation was not started: task risk score ${taskRiskResult.score} (preview-only).`,
      stage: "patch_gen",
      status: "high_risk_preview_only",
      ...(selectedTargetFile ? { filePath: selectedTargetFile } : {}),
    });
    notifyProgress("Ready", {
      type: "run_completed",
      message: "Run finished (preview-only, high task risk).",
      stage: "finalize",
      status: "preview_only",
    });
    reportProgress("Ready");
    const highRiskReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: selectedContextFiles.map((f) => ({
        path: f.path,
        reason: f.reason,
      })),
      planObjective: executionPlan?.objective ?? null,
      planScopeSummary: executionPlan?.scopeSummary ?? null,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "safe_to_apply",
      finalState: "safe_to_apply",
      warnings: [
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — blocked before patch generation.`,
      ],
      correctness: { status: "skipped", summary: "Patch generation was not started (high task risk)." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "completed_with_issues",
      developerConfidence: 0,
    });
    return {
      ok: true,
      patchPreview: `[BLOCKED] Risk score ${taskRiskResult.score} — task was blocked before patch generation. Detected signals: ${taskRiskResult.signals.join(", ")}.`,
      warnings: [`[HIGH_RISK] Task risk score ${taskRiskResult.score} — blocked before patch generation.`],
      developerConfidence: 0,
      decisionMode: "safe_to_apply",
      ...(selectedTargetFile ? { targetFile: selectedTargetFile } : {}),
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
      ...(executionPlan ? { plan: executionPlan } : {}),
      lifecycleEvents: [...lifecycleEvents],
      finalRunReport: highRiskReport,
    };
  }
  const patchPreviewHadNoStructuredPatchesFromLlm = patchPlan.patches.length === 0;
  if (patchPlan.patches.length === 0) {
    const previewEmptyPick = resolvePreviewEmptyFallbackPath({
      task: input.task,
      explicitTargetParsed: explicitTargetPath,
      fullRankedFiles,
      hostedContext: input.hostedContext,
      allFiles,
    });
    if (previewEmptyPick.kind === "explicit_target_not_grounded") {
      notifyProgress("Ready", {
        type: "patch_generation_failed",
        message: `Explicit target file is not in the selected repository or hosted context: ${previewEmptyPick.explicitPath}`,
        stage: "patch_preview",
        status: "explicit_target_not_found",
        filePath: previewEmptyPick.explicitPath,
      });
      notifyProgress("Ready", {
        type: "run_completed",
        message: "Run finished (preview-only, explicit target not found).",
        stage: "finalize",
        status: "preview_only",
      });
      reportProgress("Ready");
      perf.mark("decision evaluation complete");
      debugLog("[zone-flow-early-return]", JSON.stringify({ step: "explicit_target_not_found_planning", reason: "explicit_target_not_found_in_planning" }));
      perf.finish("explicit target not found");
      const explicitMissingReport = await generateFinalRunReport({
        task: input.task,
        contextFilesMeta: selectedContextFiles.map((f) => ({
          path: f.path,
          reason: f.reason,
        })),
        planObjective: executionPlan?.objective ?? null,
        planScopeSummary: executionPlan?.scopeSummary ?? null,
        patchSource: "no_patch",
        fileDiffs: [],
        patchScope: {
          changedFileCount: 0,
          totalAddedLines: 0,
          totalRemovedLines: 0,
          totalChangedLines: 0,
        },
        decisionMode: "safe_to_apply",
        finalState: "safe_to_apply",
        warnings: [EXPLICIT_TARGET_NOT_FOUND_WARNING],
        correctness: {
          status: "skipped",
          summary: "Patch generation was not started (explicit_target_not_found).",
        },
        verificationCommandsLabel: null,
        runtimeVerificationSummary: null,
        finalExecutionOutcome: "completed_with_issues",
        developerConfidence: 60,
        terminalAbort: {
          code: "explicit_target_not_found",
          missingPath: previewEmptyPick.explicitPath,
        },
      });
      return {
        ok: true,
        reason: "explicit_target_not_found",
        patchPreview: EXPLICIT_TARGET_NOT_FOUND_WARNING,
        warnings: [EXPLICIT_TARGET_NOT_FOUND_WARNING],
        developerConfidence: 60,
        decisionMode: "safe_to_apply",
        finalState: "safe_to_apply",
        patchSource: "no_patch",
        applyPatches: [],
        patchResults: [],
        fileDiffs: [],
        contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
        ...(executionPlan ? { plan: executionPlan } : {}),
        lifecycleEvents: [...lifecycleEvents],
        finalRunReport: explicitMissingReport,
      };
    }
    if (previewEmptyPick.kind === "path") {
      const fallbackPath = previewEmptyPick.path;
      debugLog("[zone-patch-preview-fallback-target]", fallbackPath);
      notifyProgress("Generating file patches...", {
        type: "patch_preview_empty_fallback_target_selected",
        message: `Patch preview returned no structured patches; selected ${fallbackPath} for full patch generation.`,
        stage: "patch_preview",
        status: "selected",
        filePath: fallbackPath,
      });
      const synthetic: PatchPreviewItem = {
        path: fallbackPath,
        operation: "modify",
        summary:
          "Fallback target selected because patch preview returned no structured patches.",
        targetHint: "preview_empty_fallback_target",
        contentPreview: "",
      };
      patchPlan = {
        ...patchPlan,
        patches: [synthetic],
        warnings: [
          ...patchPlan.warnings,
          `[preview_empty_fallback] Using ${fallbackPath} because patch preview returned zero patches.`,
        ],
      };
    }
  }
  selectedTargetFile = patchPlan.patches[0]?.path ?? selectedTargetFile;

  // 6b. Generate full file content for modify/create patches
  reportProgress("Generating file patches...");
  notifyProgress("Generating file patches...", {
    type: "patch_generation_started",
    message: "Generating full-file patches from the preview plan.",
    stage: "patch_gen",
    status: "started",
  });
  let applyPatches: Array<{ filePath: string; fullContent: string }> = [];
  let fallbackForcePreviewOnly = false;
  let deterministicFallbackTooLarge = false;
  let usedLlmPatchRecovered = false;
  let patchSource: PatchSource = "no_patch";
  const originalContents: Record<string, string> = {
    ...(input.hostedContext?.originalContents ?? {}),
  };
  const internalWarnings = [...contextBudgetWarnings, ...patchPlan.warnings];
  const visibleWarnings = filterVisibleDeveloperWarnings([
    ...contextBudgetWarnings,
    ...patchPlan.warnings,
  ]);
  const patchResults: PatchResult[] = [];
  const rawPatchTextByFile: Record<string, string> = {};
  let hostedPatchAvailability: Array<{
  path: string;
  hasOriginalContent: boolean;
  hasContextFile: boolean;
  reason: string;
}> = [];
  try {
    hostedPatchAvailability = input.hostedContext
      ? patchPlan.patches.map((patch) => {
          const hasOriginalContent = Object.prototype.hasOwnProperty.call(
            input.hostedContext!.originalContents,
            patch.path
          );
          const hasContextFile = input.hostedContext!.contextFiles.some(
            (file) => file.path === patch.path
          );
          return {
            path: patch.path,
            hasOriginalContent,
            hasContextFile,
            reason: !hasOriginalContent
              ? "missing from originalContents"
              : !hasContextFile
                ? "missing from contextFiles"
                : "available in hosted context",
          };
        })
      : [];
    const applyTargets = patchPlan.patches.filter(
      (p) => p.operation === "modify" || p.operation === "create"
    );
    const applyResults: Array<{ filePath: string; fullContent: string }> = [];
    let loopApplyTargets: PatchPreviewItem[] = applyTargets;
    let constrainedApplyEligibilityPrefiltered = false;

    if (isConstrainedLocalizedPatchTask(input.task) && applyTargets.length > 0) {
      constrainedApplyEligibilityPrefiltered = true;
      const prefilteredTargets: PatchPreviewItem[] = [];
      const constraintRejections: Array<{ filePath: string; reason: string }> =
        [];

      for (const previewPatch of applyTargets) {
        if (isProtectedDeveloperUiPath(previewPatch.path)) {
          prefilteredTargets.push(previewPatch);
          continue;
        }
        const hostedOriginalPre =
          input.hostedContext &&
          Object.prototype.hasOwnProperty.call(
            input.hostedContext.originalContents,
            previewPatch.path
          )
            ? input.hostedContext.originalContents[previewPatch.path] ?? ""
            : undefined;
        const hostedCtxPre = input.hostedContext?.contextFiles.find(
          (file) => file.path === previewPatch.path
        )?.content;
        const hostedForcePre = explicitTargetForceContentByPath.get(previewPatch.path);
        if (
          input.hostedContext &&
          typeof hostedOriginalPre === "undefined" &&
          typeof hostedCtxPre === "undefined" &&
          typeof hostedForcePre === "undefined"
        ) {
          patchResults.push({
            filePath: previewPatch.path,
            status: "skipped",
            reason: "missing hosted context",
          });
          continue;
        }
        const loaded = await loadDeveloperModifyPatchSourceContent({
          patchPath: previewPatch.path,
          hostedContext: input.hostedContext,
          allFiles,
          hostedForceLoadedContent: explicitTargetForceContentByPath,
        });
        if (!loaded.ok) {
          patchResults.push({
            filePath: previewPatch.path,
            status: "skipped",
            reason: "missing hosted context",
          });
          continue;
        }
        const preflightEligibility = assessConstrainedTargetEligibility({
          task: input.task,
          filePath: previewPatch.path,
          fileContent: loaded.content,
          topRankedRelevantPath: fullRankedFiles[0]?.path ?? null,
        });
        debugLog(
          "[zone-target-eligibility]",
          JSON.stringify({
            filePath: previewPatch.path,
            structureScore: preflightEligibility.structureScore,
            entityMatch: preflightEligibility.entityMatch,
            entitySource: preflightEligibility.entitySource,
            eligible: preflightEligibility.eligible,
            reason: preflightEligibility.reason,
            decision: preflightEligibility.eligible ? "accepted" : "rejected",
            topRankedEntityMatch: preflightEligibility.topRankedEntityMatch,
            overrideReason: preflightEligibility.overrideReason,
            pathTokens: preflightEligibility.pathTokens,
            entityAnchors: preflightEligibility.entityAnchors,
          })
        );
        if (!preflightEligibility.eligible) {
          const mismatchWarning = buildPatchConflictWarning({
            filePath: previewPatch.path,
            reason: preflightEligibility.reason,
            score: preflightEligibility.score,
          });
          internalWarnings.push(mismatchWarning);
          visibleWarnings.push(mismatchWarning);
          patchResults.push({
            filePath: previewPatch.path,
            status: "failed",
            reason: preflightEligibility.reason,
          });
          if (
            CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS.has(
              preflightEligibility.reason
            )
          ) {
            constraintRejections.push({
              filePath: previewPatch.path,
              reason: preflightEligibility.reason,
            });
          }
          continue;
        }
        if (preflightEligibility.reason === "top_ranked_entity_target_preview") {
          fallbackForcePreviewOnly = true;
          internalWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
          visibleWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
        }
        prefilteredTargets.push(previewPatch);
      }

      loopApplyTargets = prefilteredTargets;
      const hasNonProtectedApplyTarget = loopApplyTargets.some(
        (p) => !isProtectedDeveloperUiPath(p.path)
      );
      if (
        !hasNonProtectedApplyTarget &&
        constraintRejections.length > 0 &&
        constraintRejections.every((rejection) =>
          CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS.has(rejection.reason)
        )
      ) {
        const rejectedPaths = new Set(
          constraintRejections.map((rejection) => rejection.filePath)
        );
        const rejectedPreviewPaths = constraintRejections.map(
          (rejection) => rejection.filePath
        );
        const fallbackFullRanked = await rankRelevantFiles({
          task: input.task,
          files: developerContextFiles,
          intent: taskIntent,
          semanticScores,
          readContent: readContentForRanker,
        });
        const fallbackEntityAnchors = extractConstrainedTaskEntityAnchors(
          normalizeConstrainedTaskText(input.task)
        );
        const entityPathCandidates = collectConstrainedFallbackEntityPathCandidates({
          developerContextFiles,
          entityAnchors: fallbackEntityAnchors,
          rejectedPaths,
        });
        const entityPathSet = new Set(
          entityPathCandidates.map((candidate) => candidate.path)
        );
        const rankedSlice = fallbackFullRanked
          .filter((file) => !entityPathSet.has(file.path))
          .slice(0, CONSTRAINED_FALLBACK_RANKED_READ_LIMIT);
        const rankedCandidatePaths = rankedSlice.map((file) => file.path);
        const entityPathCandidatePaths = entityPathCandidates.map(
          (candidate) => candidate.path
        );
        const mergedReadOrder: Array<{ path: string; score: number }> = [];
        const mergeSeen = new Set<string>();
        for (const item of [
          ...entityPathCandidates,
          ...rankedSlice.map((file) => ({ path: file.path, score: file.score })),
        ]) {
          if (mergeSeen.has(item.path) || rejectedPaths.has(item.path)) {
            continue;
          }
          mergeSeen.add(item.path);
          mergedReadOrder.push(item);
          if (mergedReadOrder.length >= CONSTRAINED_FALLBACK_MAX_READ_PATHS) {
            break;
          }
        }
        const fallbackRelevantScores = new Map(relevantFileScores);
        for (const file of fallbackFullRanked) {
          fallbackRelevantScores.set(file.path, file.score);
        }
        for (const candidate of entityPathCandidates) {
          const current = fallbackRelevantScores.get(candidate.path) ?? 0;
          fallbackRelevantScores.set(
            candidate.path,
            Math.max(current, 100_000)
          );
        }
        const fallbackContentByPath = await buildConstrainedFallbackContentByPath({
          resolvedFileContexts,
          selectedContextFiles,
          rankedCandidates: mergedReadOrder,
          hostedContext: input.hostedContext,
          allFiles,
        });
        const pathTokensDebug = buildConstrainedFallbackPathTokensDebug(
          mergedReadOrder.map((item) => item.path)
        );

        // Grounded candidate list. mergedReadOrder already places
        // entity-path candidates (tiers 1/2) before ranked-only candidates.
        // We do NOT rescan the repo or call any LLM to build this list.
        const orderedFallbackCandidates: Array<{
          path: string;
          content: string;
          rankScore: number;
        }> = [];
        const orderedFallbackSeen = new Set<string>();
        for (const item of mergedReadOrder) {
          if (orderedFallbackSeen.has(item.path)) continue;
          if (rejectedPaths.has(item.path)) continue;
          if (
            isIrrelevantDeveloperContextPath(item.path) ||
            isProtectedDeveloperUiPath(item.path)
          ) {
            continue;
          }
          const content = fallbackContentByPath.get(item.path);
          if (typeof content !== "string") continue;
          orderedFallbackSeen.add(item.path);
          orderedFallbackCandidates.push({
            path: item.path,
            content,
            rankScore: fallbackRelevantScores.get(item.path) ?? 0,
          });
        }

        const MAX_FALLBACK_ATTEMPTS = 3;
        const retryLogEntries: Array<{
          attempt: number;
          filePath: string;
          eligible: boolean;
          reason: string;
        }> = [];
        const retryRejectedCandidates: Array<{
          path: string;
          reason: string;
          score: number;
        }> = [];
        let attemptsMade = 0;
        let fallbackPick:
          | { path: string; content: string; rankScore: number }
          | null = null;
        let tier3Pick:
          | {
              path: string;
              content: string;
              rankScore: number;
              structureScore: number;
            }
          | null = null;
        let fallbackTier:
          | "tier12_eligible"
          | "tier3_structure_only_preview"
          | null = null;

        for (const candidate of orderedFallbackCandidates) {
          if (attemptsMade >= MAX_FALLBACK_ATTEMPTS) break;
          attemptsMade += 1;

          const eligibility = assessConstrainedTargetEligibility({
            task: input.task,
            filePath: candidate.path,
            fileContent: candidate.content,
          });

          const retryEntry = {
            attempt: attemptsMade,
            filePath: candidate.path,
            eligible: eligibility.eligible,
            reason: eligibility.reason,
          };
          retryLogEntries.push(retryEntry);
          debugLog("[zone-target-retry]", JSON.stringify(retryEntry));

          if (eligibility.eligible) {
            fallbackPick = {
              path: candidate.path,
              content: candidate.content,
              rankScore: candidate.rankScore,
            };
            fallbackTier = "tier12_eligible";
            break;
          }

          retryRejectedCandidates.push({
            path: candidate.path,
            reason: eligibility.reason,
            score: eligibility.structureScore,
          });
        }

        // Tier 3: if tier 1/2 found nothing, do a second pass over ALL
        // grounded candidates (not bounded by MAX_FALLBACK_ATTEMPTS). This
        // pass makes no LLM calls — only cheap eligibility checks — and
        // picks the best structure-only match. If used, it will be forced
        // to preview_only downstream.
        if (fallbackPick === null) {
          for (const candidate of orderedFallbackCandidates) {
            const eligibility = assessConstrainedTargetEligibility({
              task: input.task,
              filePath: candidate.path,
              fileContent: candidate.content,
            });
            if (
              eligibility.reason === "target_entity_mismatch" &&
              eligibility.structureScore >= 20 &&
              (tier3Pick === null ||
                candidate.rankScore > tier3Pick.rankScore ||
                (candidate.rankScore === tier3Pick.rankScore &&
                  eligibility.structureScore > tier3Pick.structureScore))
            ) {
              tier3Pick = {
                path: candidate.path,
                content: candidate.content,
                rankScore: candidate.rankScore,
                structureScore: eligibility.structureScore,
              };
            }
          }
        }

        if (fallbackPick === null && tier3Pick !== null) {
          const tier3Entry = {
            attempt: attemptsMade + 1,
            filePath: tier3Pick.path,
            eligible: true,
            reason: "tier3_structure_only_preview",
          };
          retryLogEntries.push(tier3Entry);
          debugLog("[zone-target-retry]", JSON.stringify(tier3Entry));
          fallbackPick = {
            path: tier3Pick.path,
            content: tier3Pick.content,
            rankScore: tier3Pick.rankScore,
          };
          fallbackTier = "tier3_structure_only_preview";
          fallbackForcePreviewOnly = true;
        }

        if (fallbackPick !== null) {
          debugLog(
            "[zone-target-fallback]",
            JSON.stringify({
              rejectedPreviewPaths,
              entityAnchors: fallbackEntityAnchors,
              entityPathCandidates: entityPathCandidatePaths,
              rankedCandidates: rankedCandidatePaths,
              pathTokensDebug,
              candidatesChecked: attemptsMade,
              candidatesAvailable: orderedFallbackCandidates.length,
              rejectedCandidates: retryRejectedCandidates,
              fallback: fallbackPick.path,
              fallbackTier,
              reason:
                fallbackTier === "tier3_structure_only_preview"
                  ? "selected_fallback_tier3_preview_only"
                  : "selected_fallback",
              retryLog: retryLogEntries,
            })
          );
          originalContents[fallbackPick.path] = fallbackPick.content;
          loopApplyTargets = [
            buildConstrainedSyntheticModifyPatch(fallbackPick.path),
            ...loopApplyTargets,
          ];
        } else {
          debugLog(
            "[zone-target-fallback]",
            JSON.stringify({
              rejectedPreviewPaths,
              entityAnchors: fallbackEntityAnchors,
              entityPathCandidates: entityPathCandidatePaths,
              rankedCandidates: rankedCandidatePaths,
              pathTokensDebug,
              candidatesChecked: attemptsMade,
              candidatesAvailable: orderedFallbackCandidates.length,
              rejectedCandidates: retryRejectedCandidates,
              fallback: null,
              fallbackTier: null,
              reason: "no_eligible_fallback",
              retryLog: retryLogEntries,
            })
          );
          patchResults.push({
            filePath:
              constraintRejections[0]?.filePath ??
              applyTargets[0]?.path ??
              "constrained_task",
            status: "failed",
            reason: "no_eligible_target_found",
          });
        }
      }
    }

    for (const patch of loopApplyTargets) {
      if (patch.path.startsWith("src/ui/") || patch.path === "src/ui/index.html") {
        internalWarnings.push(
          "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
        );
        visibleWarnings.push(
          "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
        );
        patchResults.push({
          filePath: patch.path,
          status: "skipped",
          reason: "protected file",
        });
        continue;
      }

      const hostedOriginalContent =
        input.hostedContext &&
        Object.prototype.hasOwnProperty.call(
          input.hostedContext.originalContents,
          patch.path
        )
          ? input.hostedContext.originalContents[patch.path] ?? ""
          : undefined;
      const hostedContextFileContent =
        input.hostedContext?.contextFiles.find((file) => file.path === patch.path)
          ?.content;
      const hostedForceMain = explicitTargetForceContentByPath.get(patch.path);

      if (
        input.hostedContext &&
        typeof hostedOriginalContent === "undefined" &&
        typeof hostedContextFileContent === "undefined" &&
        typeof hostedForceMain === "undefined"
      ) {
        patchResults.push({
          filePath: patch.path,
          status: "skipped",
          reason: "missing hosted context",
        });
        continue;
      }

      const repoFile = allFiles.find((f) => f.path === patch.path);
      const absolutePath = repoFile?.absolutePath;

      const fileContent = input.hostedContext
        ? hostedOriginalContent ?? hostedContextFileContent ?? hostedForceMain ?? ""
        : absolutePath !== undefined
          ? (
              (
                await readProjectFiles([absolutePath], {
                  maxFiles: 1,
                  // Large files (e.g. controllers) must not be truncated or FIND/REPLACE will fail.
                  maxCharsPerFile: 200_000,
                })
              )[absolutePath] ?? ""
            )
          : "";
      originalContents[patch.path] = fileContent;

      const astScan = extractFunctionRanges(fileContent, patch.path);
      if (astScan.ok && astScan.functions.length > 0) {
        debugLog("[zone-ast-scan]", {
          file: patch.path,
          functionsFound: astScan.functions.length,
          names: astScan.functions.map((r) => r.name),
        });
      }

      if (isTaskAlreadyDone(input.task, fileContent)) {
        const msg = "This change appears to already be implemented.";
        const runIdTrim = typeof input.runId === "string" ? input.runId.trim() : "";
        if (runIdTrim) {
          input.onProgress?.({
            stage: "Ready",
            progress: {
              runId: runIdTrim,
              ts: Date.now(),
              type: "chat_response",
              title: msg,
              status: "success",
            },
          });
        }
        notifyProgress("Ready", {
          type: "run_completed",
          message: msg,
          stage: "finalize",
          status: "completed",
        });
        reportProgress("Ready");
        const alreadyDoneReport = await generateFinalRunReport({
          task: input.task,
          contextFilesMeta: [{ path: patch.path, reason: "already_implemented_precheck" }],
          planObjective: executionPlan?.objective ?? null,
          planScopeSummary: executionPlan?.scopeSummary ?? null,
          patchSource: "no_patch",
          fileDiffs: [],
          patchScope: {
            changedFileCount: 0,
            totalAddedLines: 0,
            totalRemovedLines: 0,
            totalChangedLines: 0,
          },
          decisionMode: "safe_to_apply",
          finalState: "safe_to_apply",
          warnings: [],
          correctness: {
            status: "skipped",
            summary: "Precheck: requested comment/JSDoc already appears present near the target function.",
          },
          verificationCommandsLabel: null,
          runtimeVerificationSummary: null,
          finalExecutionOutcome: "completed",
          developerConfidence: 100,
        });
        return {
          ok: true,
          patchPreview: msg,
          warnings: [],
          developerConfidence: 100,
          decisionMode: "chat",
          finalState: "safe_to_apply",
          chatResponse: msg,
          reason: "already_implemented",
          patchSource: "no_patch",
          finalExecutionOutcome: "completed",
          applyPatches: [],
          patchResults: [
            {
              filePath: patch.path,
              status: "skipped",
              reason: "already_implemented",
            },
          ],
          fileDiffs: [],
          contextFiles: [],
          lifecycleEvents: [...lifecycleEvents],
          finalRunReport: alreadyDoneReport,
        };
      }

      // Include a few page-like files as extra context for UI/test-heavy repos.
      let resolvedPageObjectContext = "";
      if (input.hostedContext) {
        resolvedPageObjectContext = resolvedFileContexts
          .filter(
            (file) =>
              file.path !== patch.path &&
              (file.path.endsWith(".java") || file.path.includes("page"))
          )
          .slice(0, 5)
          .map((file) => `FILE: ${file.path}\n${file.content}`)
          .join("\n\n");
      } else {
        const pageObjectFiles = allFiles
          .filter(
            (f) =>
              !isIrrelevantDeveloperContextPath(f.path) &&
              (f.path.endsWith(".java") || f.path.includes("page"))
          )
          .slice(0, 5);

        const pageObjectPaths = pageObjectFiles
          .map((f) => f.absolutePath)
          .filter((p): p is string => typeof p === "string");

        const pageObjectContentsMap =
          pageObjectPaths.length > 0 ? await readProjectFiles(pageObjectPaths) : {};

        resolvedPageObjectContext = Object.entries(pageObjectContentsMap)
          .map(([absPath, content]) => {
            const relPath =
              allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath;
            return `FILE: ${relPath}\n${content}`;
          })
          .join("\n\n");
      }
      const microEditMode =
        isUiFilePath(patch.path) && isMicroEditUiTask(input.task);
      const contextWindow =
        fileContent.length > 8000
          ? smartContextWindow({
              fileContent,
              task: input.task,
            })
          : null;
      const preferConstrainedFullContent =
        loopApplyTargets.length === 1 &&
        contextWindow !== null &&
        isConstrainedLocalizedPatchTask(input.task);
      const fullPatchMode =
        fileContent.length > 8000 && !preferConstrainedFullContent
          ? "find_replace_patch"
          : "full_content";
      const llmFileContent = contextWindow?.snippet ?? fileContent;
      const explicitFromTaskMatch = input.task.match(/Target file:\s*([^\r\n]+)/i);
      const explicitFromTask =
        explicitFromTaskMatch?.[1] ? String(explicitFromTaskMatch[1]).trim().replace(/\\/g, "/") : "";
      const isExplicitPrimaryTarget =
        (explicitTargetCanonicalPath !== null && patch.path === explicitTargetCanonicalPath) ||
        (explicitFromTask.length > 0 && patch.path === explicitFromTask);
      const fullContextForExplicitTarget = isExplicitPrimaryTarget ? fileContent : llmFileContent;

      // Deterministic fallback for explicit "replace this exact line" tasks.
      // This avoids LLM no-op/no_patch when we have an unambiguous single-line replacement.
      if (isExplicitPrimaryTarget) {
        const exact = parseExactLineReplaceTask(input.task);
        if (exact) {
          debugLog("[zone-exact-line-fallback]", {
            filePath: patch.path,
            findLine: exact.findLine,
            replaceLine: exact.replaceLine,
          });
          const applied = tryApplyExactLineReplacement({
            fileContent,
            findLine: exact.findLine,
            replaceLine: exact.replaceLine,
          });
          if (applied.ok) {
            if (!applyResults.some((p) => p.filePath === patch.path)) {
              applyResults.push({ filePath: patch.path, fullContent: applied.fullContent });
            }
            patchResults.push({ filePath: patch.path, status: "applied" });
            emitStructuredProgress({
              type: "patch_converted",
              title: "Applied exact line replacement",
              status: "success",
              filePath: patch.path,
            });
            continue;
          } else if (applied.reason.startsWith("ambiguous_")) {
            const w = `[exact_line_replace_ambiguous] Found multiple matching lines; skipping deterministic replacement (${applied.reason}).`;
            internalWarnings.push(w);
            visibleWarnings.push(w);
          }
        }
      }
      const shouldRunInlineConstrainedEligibility =
        isConstrainedLocalizedPatchTask(input.task) &&
        !constrainedApplyEligibilityPrefiltered;
      if (shouldRunInlineConstrainedEligibility) {
        const targetEligibility = assessConstrainedTargetEligibility({
          task: input.task,
          filePath: patch.path,
          fileContent,
          topRankedRelevantPath: fullRankedFiles[0]?.path ?? null,
        });
        debugLog(
          "[zone-target-eligibility]",
          JSON.stringify({
            filePath: patch.path,
            structureScore: targetEligibility.structureScore,
            entityMatch: targetEligibility.entityMatch,
            entitySource: targetEligibility.entitySource,
            eligible: targetEligibility.eligible,
            reason: targetEligibility.reason,
            decision: targetEligibility.eligible ? "accepted" : "rejected",
            topRankedEntityMatch: targetEligibility.topRankedEntityMatch,
            overrideReason: targetEligibility.overrideReason,
            pathTokens: targetEligibility.pathTokens,
            entityAnchors: targetEligibility.entityAnchors,
          })
        );
        if (!targetEligibility.eligible) {
          const mismatchWarning = buildPatchConflictWarning({
            filePath: patch.path,
            reason: targetEligibility.reason,
            score: targetEligibility.score,
          });
          internalWarnings.push(mismatchWarning);
          visibleWarnings.push(mismatchWarning);
          patchResults.push({
            filePath: patch.path,
            status: "failed",
            reason: targetEligibility.reason,
          });
          continue;
        }
        if (targetEligibility.reason === "top_ranked_entity_target_preview") {
          fallbackForcePreviewOnly = true;
          internalWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
          visibleWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
        }
      }
      const targetedRelevantFiles = microEditMode
        ? [
            {
              path: patch.path,
              content: buildMicroEditSnippet(patch.path, fileContent, input.task),
            },
            ...resolvedFileContexts
              .filter((file) => file.path !== patch.path)
              .slice(0, 2)
              .map((file) => ({ path: file.path })),
          ]
        : resolvedFileContexts;
      const normalizedTaskIntentForPrompt = detectMicroEditIntent(input.task)
        ? "micro_edit"
        : "standard";
      debugLog("[zone-patch-source] using FULL PATCH ONLY");
      const nextContent = await (() => {
            perf.mark(`full patch model call start ${patch.path}`);
            emitStructuredProgress({
              type: "generating_patch",
              title: "Generating a localized patch",
              status: "active",
              filePath: patch.path,
            });
            return planFullPatchWithLlm({
              task: input.task,
              lastAddedFunctions,
              plannerSuggestedFile: plannerSelection?.filesToEdit?.[0],
              filePath: patch.path,
              // For explicit targets, the model MUST see the exact full file content that the patch
              // will be applied to; otherwise FIND anchors can be generated against a truncated snippet.
              fileContent: fullContextForExplicitTarget,
              fullOriginalFileContent: fileContent,
              repoSummary: projectSummary,
              repoPath: input.repoPath,
              taskIntent: taskIntent.normalizedTask || taskIntent.action,
              normalizedTaskIntent: normalizedTaskIntentForPrompt,
              outputMode: fullPatchMode,
              relevantFiles: targetedRelevantFiles,
              existingTargetFiles: allFiles.map((file) => file.path),
              executionPlan,
              onProgress: (
                e:
                  | { type: "patch_stream_delta"; filePath: string; delta: string; fallback?: boolean }
                  | { type: "patch_stream_target"; filePath: string; targetSymbol: string }
              ) => {
                if (e.type === "patch_stream_target") {
                  emitStructuredProgress({
                    type: "patch_stream_target",
                    title: "Patch target",
                    status: "active",
                    filePath: patch.path,
                    targetSymbol: e.targetSymbol ?? "",
                  });
                  return;
                }
                if (e.type === "patch_stream_delta") {
                  emitStructuredProgress({
                    type: "patch_stream_delta",
                    title: "Streaming patch",
                    status: "active",
                    filePath: patch.path,
                    delta: e.delta,
                    ...(e.fallback ? { fallback: true } : {}),
                  });
                }
              },
              relatedContext: [
                contextWindow
                  ? `// CONTEXT WINDOW: lines ${contextWindow.startLine}-${contextWindow.endLine} of ${contextWindow.totalLines} total`
                  : "",
                patch.summary,
                resolvedPageObjectContext,
                "IMPORTANT: Do NOT remove or rewrite existing functions, classes, or methods unless the task explicitly asks you to. Only add or modify what is necessary. Preserve all existing code structure, comments, and patterns.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            });
          })().then((fullPatch) => {
            perf.mark(`full patch model response received ${patch.path}`);
            if (fullPatch.mode === "openai_call_error") {
              fallbackForcePreviewOnly = true;
              debugLog(
                "[zone-patch-recovery-context]",
                JSON.stringify({
                  filePath: patch.path,
                  mode: "openai_call_error",
                  details: fullPatch.openAiCallDetails,
                })
              );
              for (const w of fullPatch.warnings) {
                internalWarnings.push(w);
                visibleWarnings.push(w);
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: "openai_call_error" as const,
                status: "failed",
                failureReason: "openai_call_error",
                normalizedFailureReason: "openai_call_error",
              });
              patchResults.push({
                filePath: patch.path,
                status: "failed",
                reason: "openai_call_error",
              });
              return null;
            }
            if (fullPatch.mode === "empty_model_response") {
              fallbackForcePreviewOnly = true;
              debugLog(
                "[zone-patch-recovery-context]",
                JSON.stringify({
                  filePath: patch.path,
                  mode: "empty_model_response",
                  details: fullPatch.emptyModelDetails,
                })
              );
              for (const w of fullPatch.warnings) {
                internalWarnings.push(w);
                visibleWarnings.push(w);
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: "empty_model_response" as const,
                status: "failed",
                failureReason: "empty_model_response",
                normalizedFailureReason: "empty_model_response",
              });
              patchResults.push({
                filePath: patch.path,
                status: "failed",
                reason: "empty_model_response",
              });
              return null;
            }
            if (fullPatch.mode === "invalid_patch_format") {
              fallbackForcePreviewOnly = true;
              debugLog(
                "[zone-patch-recovery-context]",
                JSON.stringify({
                  filePath: patch.path,
                  lastNonEmptyRawLength: fullPatch.lastNonEmptyRawLength ?? 0,
                })
              );
              for (const w of fullPatch.warnings) {
                internalWarnings.push(w);
                visibleWarnings.push(w);
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: "invalid_patch_format" as const,
                status: "failed",
                failureReason: "invalid_patch_format",
                normalizedFailureReason: "invalid_patch_format",
              });
              patchResults.push({
                filePath: patch.path,
                status: "failed",
                reason: "invalid_patch_format",
              });
              return null;
            }
            if (fullPatch.mode === "patch") {
              rawPatchTextByFile[patch.path] = fullPatch.patchText;
              debugLog(
                "[zone-raw-before-convert]",
                String(fullPatch.patchText || "").slice(0, 800)
              );
              const parsedForAnchor = parseDeveloperPatchText(fullPatch.patchText);
              const anchorLine =
                parsedForAnchor && !parsedForAnchor.noChangeNeeded && parsedForAnchor.edits.length > 0
                  ? (String(parsedForAnchor.edits[0]?.find ?? "")
                      .split(/\r?\n/)
                      .map((l) => l.trim())
                      .find((l) => l.length > 0) ?? "")
                  : "";
              debugLog("[zone-patch-anchor-debug]", {
                filePath: patch.path,
                llmFileContentHasAnchor: anchorLine ? llmFileContent.includes(anchorLine) : null,
                fileContentHasAnchor: anchorLine ? fileContent.includes(anchorLine) : null,
                patchPreview: String(fullPatch.patchText || "").slice(0, 200),
              });
              const funcNameMatch = input.task.match(
                /(?:in|the|fix|update|modify|refactor|change)\s+(?:the\s+)?(\w+)\s+(?:function|method)/i
              );
              const targetFuncName = funcNameMatch?.[1]
                ? String(funcNameMatch[1]).trim()
                : "";
              const symbolCtx =
                targetFuncName.length > 0
                  ? extractSymbolContext(fileContent, targetFuncName, patch.path, 5)
                  : null;

              let appliedPatch = (() => {
                if (!symbolCtx) {
                  return applyDeveloperPatchText(fileContent, fullPatch.patchText, {
                    filePath: patch.path,
                  });
                }

                // AST mode: apply patch against the function slice (more reliable FIND),
                // then splice into the full file to preserve complete content.
                const funcApply = applyDeveloperPatchText(
                  symbolCtx.targetFunction.content,
                  fullPatch.patchText,
                  { filePath: patch.path }
                );
                if (!funcApply.ok) {
                  return applyDeveloperPatchText(fileContent, fullPatch.patchText, {
                    filePath: patch.path,
                  });
                }
                const patchedFunctionContent = funcApply.fullContent;
                const fullFileContent =
                  fileContent.slice(0, symbolCtx.targetFunction.startChar) +
                  patchedFunctionContent +
                  fileContent.slice(symbolCtx.targetFunction.endChar);
                debugLog("[zone-ast-reconstruct]", {
                  file: patch.path,
                  targetFunc: targetFuncName,
                  lines: `${symbolCtx.targetFunction.startLine}-${symbolCtx.targetFunction.endLine}`,
                  patchedSize: patchedFunctionContent.length,
                });
                return { ok: true as const, fullContent: fullFileContent };
              })();
              let recoveredFromApply = false;
              if (!appliedPatch.ok) {
                const failurePreview = parsePatchFailureWarning(
                  appliedPatch.warning
                );
                if (failurePreview.reason === "invalid_patch_format") {
                  const recovered = tryRecoverDeveloperPatchFromModelOutput({
                    requestedFilePath: patch.path,
                    originalFileContent: fileContent,
                    rawModelText: fullPatch.patchText,
                    task: input.task,
                  });
                  if (recovered.ok) {
                    appliedPatch = applyDeveloperPatchText(
                      fileContent,
                      recovered.strictPatchText,
                      { filePath: patch.path }
                    );
                    recoveredFromApply = appliedPatch.ok;
                  }
                }
              }
              if (!appliedPatch.ok) {
                internalWarnings.push(appliedPatch.warning);
                if (!isHiddenDeveloperWarning(appliedPatch.warning)) {
                  visibleWarnings.push(appliedPatch.warning);
                }
                const failure = parsePatchFailureWarning(appliedPatch.warning);
                emitStructuredProgress({
                  type: "patch_rejected",
                  title: "Rejected unsafe patch output",
                  detail: failure.reason,
                  status: "warning",
                  filePath: patch.path,
                });
                if (failure.reason === "invalid_patch_format") {
                  fallbackForcePreviewOnly = true;
                }
                if (failure.reason === "anchor_too_small_for_large_replace") {
                  fallbackForcePreviewOnly = true;
                }
                if (failure.reason === "patch_protocol_leak") {
                  emitStructuredProgress({
                    type: "patch_rejected",
                    title: "Patch protocol leak rejected",
                    detail: "Instruction text inside FIND/REPLACE",
                    status: "warning",
                    filePath: patch.path,
                  });
                }
                if (failure.reason === "anchor_too_small_for_large_replace") {
                  emitStructuredProgress({
                    type: "patch_rejected",
                    title: "Patch anchor too small",
                    detail: "FIND was too thin for a large REPLACE",
                    status: "warning",
                    filePath: patch.path,
                  });
                }
                if (
                  (failure.reason === "patch_find_not_found" ||
                    failure.reason === "no_match_abort" ||
                    failure.reason === "patch_protocol_leak" ||
                    failure.reason === "anchor_too_small_for_large_replace") &&
                  loopApplyTargets.length === 1 &&
                  !isProtectedDeveloperUiPath(patch.path) &&
                  isUiFilePath(patch.path) &&
                  !/schema|database|db|migration/i.test(input.task)
                ) {
                  emitStructuredProgress({
                    type: "fallback",
                    title: "Trying deterministic fallback",
                    status: "active",
                    filePath: patch.path,
                  });
                  debugLog(
                    "[zone-ast-fallback-start]",
                    JSON.stringify({ filePath: patch.path, reason: failure.reason })
                  );
                  const astFallback = tryAstPatchFallback({
                    filePath: patch.path,
                    task: input.task,
                    originalContent: fileContent,
                    failedRawPatch: fullPatch.patchText,
                  });
                  if (astFallback.ok) {
                    debugLog(
                      "[zone-ast-fallback-success]",
                      JSON.stringify({
                        filePath: patch.path,
                        summary: astFallback.summary,
                        changedLinesEstimate: astFallback.changedLinesEstimate,
                      })
                    );
                    emitStructuredProgress({
                      type: "fallback_success",
                      title: "Generated a safer localized edit",
                      status: "success",
                      filePath: patch.path,
                    });
                    patchSource = "ast_fallback";
                    usedLlmPatchRecovered = false;
                    const appliedFromAst = applyDeveloperPatchText(
                      fileContent,
                      astFallback.patchText,
                      { filePath: patch.path }
                    );
                    if (appliedFromAst.ok) {
                      // Return minimally-edited full content (applied via FIND/REPLACE patch).
                      return appliedFromAst.fullContent;
                    }
                    debugLog(
                      "[zone-ast-fallback-failed]",
                      JSON.stringify({
                        filePath: patch.path,
                        reason: "patch_apply_failed",
                        warning: appliedFromAst.warning,
                      })
                    );
                    // fall through to treat original patch as failed
                  }
                  else {
                    debugLog(
                      "[zone-ast-fallback-failed]",
                      JSON.stringify({ filePath: patch.path, reason: astFallback.reason })
                    );
                  }
                }
                logPatchConversionDebug({
                  filePath: patch.path,
                  chosenOutputMode: fullPatchMode,
                  responseMode:
                    failure.reason === "invalid_patch_format"
                      ? "invalid_patch_format"
                      : fullPatch.mode,
                  status: failure.reason === "no_match_abort" ? "no_match" : "failed",
                  failureReason:
                    failure.reason === "invalid_patch_format"
                      ? "invalid_patch_format"
                      : failure.reason,
                  normalizedFailureReason: failure.normalizedFailureReason,
                });
                const patchConflictWarning = buildPatchConflictWarning({
                  filePath: patch.path,
                  reason: failure.reason,
                  score: failure.score,
                  bestMatch: failure.bestMatch,
                });
                internalWarnings.push(patchConflictWarning);
                visibleWarnings.push(patchConflictWarning);
                patchResults.push({
                  filePath: patch.path,
                  status: "failed",
                  reason: failure.reason,
                });
                return null;
              }
              if (fullPatch.patchRecovered || recoveredFromApply) {
                usedLlmPatchRecovered = true;
              }
              if (!applyResults.some((p) => p.filePath === patch.path)) {
                applyResults.push({
                  filePath: patch.path,
                  fullContent: appliedPatch.fullContent,
                });
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: fullPatch.mode,
                status: "applied",
              });
              emitStructuredProgress({
                type: "patch_converted",
                title: "Patch matched the original file",
                status: "success",
                filePath: patch.path,
              });
              return appliedPatch.fullContent;
            }
            logPatchConversionDebug({
              filePath: patch.path,
              chosenOutputMode: fullPatchMode,
              responseMode: fullPatch.mode,
              status: "applied",
            });
            debugLog(
              "[zone-full-content-apply-debug]",
              String(fullPatch.fullContent || "").slice(0, 500)
            );
            if (fullPatch.fullContent && String(fullPatch.fullContent).trim()) {
              // Ensure full-content output is staged as an apply patch (otherwise applyPatches stays empty).
              const fullContentFilePath = fullPatch.filePath || patch.path;
              if (!applyResults.some((p) => p.filePath === fullContentFilePath)) {
                applyResults.push({
                  filePath: fullContentFilePath,
                  fullContent: fullPatch.fullContent,
                });
              }
              patchResults.push({
                filePath: fullContentFilePath,
                status: "applied",
              });
              emitStructuredProgress({
                type: "patch_converted",
                title: "Patch matched the original file",
                status: "success",
                filePath: fullContentFilePath,
              });
            }
            // Track a hint of previous output for repair prompts.
            rawPatchTextByFile[patch.path] = `[full_content] ${fullPatch.summary ?? ""}`.trim();
            return fullPatch.fullContent;
          });

      if (nextContent === null) {
        continue;
      }

      if (
        nextContent.includes("--- FIND ---") ||
        nextContent.includes("--- REPLACE ---") ||
        nextContent.includes("--- FILE:") ||
        nextContent.includes("--- FILE ---")
      ) {
        const patchConflictWarning = buildPatchConflictWarning({
          filePath: patch.path,
          reason: "patch_protocol_leak",
        });
        internalWarnings.push(patchConflictWarning);
        visibleWarnings.push(patchConflictWarning);
        debugLog("[zone-patch-protocol-leak-blocked]");
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "patch_protocol_leak",
        });
        continue;
      }

      const suspiciousUiOverwrite = detectSuspiciousUiOverwrite({
        task: input.task,
        filePath: patch.path,
        currentContent: fileContent,
        nextContent,
      });

      if (suspiciousUiOverwrite) {
        internalWarnings.push(suspiciousUiOverwrite);
        visibleWarnings.push(suspiciousUiOverwrite);
        const patchConflictWarning = buildPatchConflictWarning({
          filePath: patch.path,
          reason: "ui_overwrite_guard",
        });
        internalWarnings.push(patchConflictWarning);
        visibleWarnings.push(patchConflictWarning);
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "ui_overwrite_guard",
        });
        continue;
      }

      const validation = validateDeveloperOutput({
        task: input.task,
        filePath: patch.path,
        fullContent: nextContent,
        originalContent: fileContent,
        diffLines: computeFileDiff(fileContent, nextContent).map((line) =>
          `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
        ),
      });

      if (validation.warnings.length > 0) {
        internalWarnings.push(...validation.warnings);
        visibleWarnings.push(
          ...filterVisibleDeveloperWarnings(validation.warnings)
        );
      }

      if (validation.blocked) {
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "developer_validation_blocked",
        });
        continue;
      }

        if (!applyResults.some((p) => p.filePath === patch.path)) {
          applyResults.push({
            filePath: patch.path,
            fullContent: nextContent,
          });
        }
        if (
          nextContent.includes("--- FIND ---") ||
          nextContent.includes("--- REPLACE ---") ||
          nextContent.includes("--- END ---")
        ) {
          applyResults.pop();
          patchResults.push({
            filePath: patch.path,
            status: "failed",
            reason: "patch_format_leaked",
          });
          continue;
        }
        patchResults.push({
          filePath: patch.path,
          status: "applied",
        });
    }

    applyPatches = applyResults;
    debugLog("[zone-convert-result]", {
      patchCount: applyPatches.length,
      firstPatch: applyPatches[0]
        ? JSON.stringify(applyPatches[0]).slice(0, 300)
        : null,
    });
    perf.mark("patch conversion complete");
  } catch (err) {
    // Auth failures must propagate — a missing/invalid key is not a recoverable
    // step-6b error and should surface to the user rather than silently complete.
    if (err instanceof ApiKeyError) {
      throw err;
    }
    // step 6b is best-effort — never block the preview result for non-auth errors
    errorLog(
      "[hosted] step 6b failed:",
      err instanceof Error ? err.message : String(err)
    );
    applyPatches = [];
    perf.mark("patch conversion fallback complete");
  }
  debugLog("[hosted] applyPatches count:", applyPatches.length);
  if (applyPatches.length > 0) {
    patchSource = usedLlmPatchRecovered ? "llm_patch_recovered" : "llm_patch";
  }

  const taskIsConstrained =
    isConstrainedLocalizedPatchTask(input.task) || isConstrainedTaskByText(input.task);
  if (
    taskIsConstrained &&
    (patchSource === "llm_patch" || patchSource === "llm_patch_recovered") &&
    applyPatches.length > 0
  ) {
    const scope = analyzePatchScope({ applyPatches, originalContents });
    if (scope.totalChangedLines > 30) {
      fallbackForcePreviewOnly = true;
      const w =
        "[patch_exceeds_minimal_scope] Constrained task produced a larger-than-minimal patch; forcing preview-only review.";
      internalWarnings.push(w);
      visibleWarnings.push(w);
    }
    if (scope.totalChangedLines > 50) {
      debugLog("[zone-scope-guard]", {
        taskIsConstrained,
        totalChangedLines: scope.totalChangedLines,
        action: "fallback_forced",
      });
      // Drop LLM patch so the existing deterministic fallback can run.
      applyPatches = [];
      patchSource = "no_patch";
    }
  }

  if (
    applyPatches.length === 0 &&
    selectedTargetFile &&
    patchPlan.patches.length > 0 &&
    patchPlan.patches[0]?.path === selectedTargetFile &&
    isConstrainedLocalizedPatchTask(input.task)
  ) {
    const targetContent = originalContents[selectedTargetFile] ?? "";
    if (targetContent.trim()) {
      debugLog(
        "[zone-fallback] generating deterministic patch",
        selectedTargetFile
      );
      const hasCrlf = /\r\n/.test(targetContent);
      const normalizedTarget = hasCrlf
        ? targetContent.replace(/\r\n/g, "\n")
        : targetContent;
      debugLog(
        "[zone-fallback-line-endings]",
        JSON.stringify({
          filePath: selectedTargetFile,
          hasCrlf,
          originalLength: targetContent.length,
          normalizedLength: normalizedTarget.length,
        })
      );

      const fallback = buildDeterministicFallbackPatch({
        filePath: selectedTargetFile,
        fileContent: normalizedTarget,
      });

      let updatedNormalized = normalizedTarget;
      if (fallback) {
        updatedNormalized =
          normalizedTarget.slice(0, fallback.insertIndex) +
          `\n${fallback.validationBlock}\n` +
          normalizedTarget.slice(fallback.insertIndex);
        debugLog("[zone-fallback] minimal insert applied");
        debugLog("[zone-fallback] inserted validation inside submit handler");
      }

      if (!fallback || updatedNormalized === normalizedTarget) {
        updatedNormalized = normalizedTarget.replace(
          "onSubmit={handleSubmit}",
          `onSubmit={(e) => {\n` +
            `    if (!fullName || fullName.trim() === "") {\n` +
            `      setError("Full name is required");\n` +
            `      return;\n` +
            `    }\n` +
            `    if (email && !email.includes("@")) {\n` +
            `      setError("Invalid email");\n` +
            `      return;\n` +
            `    }\n` +
            `    handleSubmit(e);\n` +
            `  }}`
        );
        if (updatedNormalized !== normalizedTarget) {
          debugLog("[zone-fallback] used inline onSubmit wrapper fallback");
        }
      }

      if (updatedNormalized === normalizedTarget) {
        debugLog("[zone-fallback-detect] handler NOT found");
        patchResults.push({
          filePath: selectedTargetFile,
          status: "failed",
          reason: "deterministic_fallback_no_safe_insertion",
        });
        // Do not create a fake/no-op patch.
      }

      if (updatedNormalized !== normalizedTarget) {
        const updatedContent = hasCrlf
          ? updatedNormalized.replace(/\n/g, "\r\n")
          : updatedNormalized;
        const fallbackDiff = computeFileDiff(targetContent, updatedContent);
        const fallbackChangedLines = fallbackDiff.filter(
          (l) => l.type === "added" || l.type === "removed"
        ).length;
        if (fallbackChangedLines > 20) {
          deterministicFallbackTooLarge = true;
          debugLog("[zone-fallback] rejected oversized fallback patch");
          patchResults.push({
            filePath: selectedTargetFile,
            status: "failed",
            reason: "deterministic_fallback_too_large",
          });
        } else {
          applyPatches = [
            { filePath: selectedTargetFile, fullContent: updatedContent },
          ];
          patchSource = "deterministic_fallback";
          fallbackForcePreviewOnly = true;
          internalWarnings.push(
            "[deterministic_fallback_used] LLM patch generation failed; Zone generated a deterministic fallback patch."
          );
          visibleWarnings.push(
            "[deterministic_fallback_used] LLM patch generation failed; Zone generated a deterministic fallback patch."
          );
          debugLog(
            "[zone-fallback-apply] deterministic fallback produced patch"
          );
          patchResults.push({
            filePath: selectedTargetFile,
            status: "applied",
            reason: "deterministic_fallback",
          });
          originalContents[selectedTargetFile] = targetContent;
        }
      }
    }
  }

  if (applyPatches.length === 0 && patchSource === "no_patch") {
    patchSource = "no_patch";
  }
  debugLog("[zone-patch-quality] source", patchSource);

  if (
    input.hostedContext &&
    applyPatches.length === 0 &&
    patchPlan.patches.length > 0
  ) {
    debugLog(
      "[hosted] patch paths filtered by hosted context:",
      hostedPatchAvailability
        .filter(
          (patch) => !patch.hasOriginalContent || !patch.hasContextFile
        )
        .map(({ path, reason }) => ({ path, reason }))
    );
    debugLog(
      "[hosted] patch paths still present after hosted filtering:",
      patchPlan.patches.map((patch) => patch.path)
    );
  }

  if (applyPatches.length > 0) {
    notifyProgress("Validating developer output...", {
      type: "patch_generated",
      message: `Generated ${applyPatches.length} patch(es) (${patchSource}).`,
      stage: "patch_gen",
      status: patchSource,
      filePath: applyPatches.map((p) => p.filePath).join(", "),
    });
  } else {
    notifyProgress("Validating developer output...", {
      type: "patch_generation_failed",
      message:
        patchPlan.patches.length > 0
          ? "No applyable file patches were produced after generation and fallbacks."
          : "No file patches were planned for apply.",
      stage: "patch_gen",
      status: "no_patch",
      ...(selectedTargetFile ? { filePath: selectedTargetFile } : {}),
    });
  }

  const patchCountBeforeCorrectness = applyPatches.length;

  let correctnessMustBlock = false;
  let validatorAllOk = true;
  const correctnessRepairAttempted = new Set<string>();
  const retryableCorrectnessCodes = new Set([
    "unbalanced_delimiters",
    "unterminated_template",
    "jsx_mismatch",
    "syntax_error",
    "broken_import_line",
  ]);
  // Patch correctness validator v2
  if (applyPatches.length > 0) {
    const kept: Array<{ filePath: string; fullContent: string }> = [];
    for (const patch of applyPatches) {
      const before = originalContents[patch.filePath] ?? "";
      const report = validatePatchCorrectness({
        filePath: patch.filePath,
        originalContent: before,
        updatedContent: patch.fullContent,
        task: input.task,
        isConstrained: isConstrainedLocalizedPatchTask(input.task),
        taskConstraints: detectExistingStructureTaskConstraints(input.task),
        strictMode: patchSource === "deterministic_fallback",
      });

      // Dev-mode bypass: warn but don't block on broken_call_at_eol.
      // This heuristic can false-positive with newline artifacts (CR/CRLF) or minified code.
      const isDevBypassMode = process.env.NODE_ENV !== "production";
      const devBypassUnbalancedDelimiters = isDevBypassMode;
      const bypassedBrokenCallAtEol = isDevBypassMode
        ? report.blocking.filter((i) => i.code === "broken_call_at_eol")
        : [];
      const bypassedUnbalancedDelimiters = devBypassUnbalancedDelimiters
        ? report.blocking.filter((i) => i.code === "unbalanced_delimiters")
        : [];
      const effectiveBlocking = isDevBypassMode
        ? report.blocking.filter(
            (i) =>
              i.code !== "broken_call_at_eol" &&
              (!devBypassUnbalancedDelimiters || i.code !== "unbalanced_delimiters")
          )
        : report.blocking;
      const effectiveWarnings = bypassedBrokenCallAtEol.length
        ? [
            ...report.warnings,
            ...bypassedBrokenCallAtEol.map((i) => ({
              ...i,
              severity: "warn" as const,
              message: `[DEV_BYPASS] ${i.message}`,
            })),
          ]
        : report.warnings;
      const effectiveWarningsWithDelimitersBypass = bypassedUnbalancedDelimiters.length
        ? [
            ...effectiveWarnings,
            ...bypassedUnbalancedDelimiters.map((i) => ({
              ...i,
              severity: "warn" as const,
              message: `[DEV_BYPASS] ${i.message}`,
            })),
          ]
        : effectiveWarnings;
      const effectiveOk = report.ok || (report.blocking.length > 0 && effectiveBlocking.length === 0);
      const effectiveForceBlocked = report.forceBlocked && effectiveBlocking.length > 0;
      const effectiveForcePreviewOnly = report.forcePreviewOnly;

      debugLog(
        "[zone-patch-correctness-v2]",
        JSON.stringify({
          filePath: patch.filePath,
          ok: effectiveOk,
          layersRun: report.layersRun,
          shortCircuitedAt: report.shortCircuitedAt,
          blockingCodes: effectiveBlocking.map((i) => i.code),
          warningCodes: effectiveWarningsWithDelimitersBypass.map((i) => i.code),
          strictMode: patchSource === "deterministic_fallback",
          devBypassBrokenCallAtEol: bypassedBrokenCallAtEol.length > 0,
          devBypassUnbalancedDelimiters: bypassedUnbalancedDelimiters.length > 0,
        })
      );

      const diagDiff = computeFileDiff(before, patch.fullContent);
      const diagAdded = diagDiff.filter((l) => l.type === "added").length;
      const diagRemoved = diagDiff.filter((l) => l.type === "removed").length;
      const diagTotalChanged = diagAdded + diagRemoved;
      const diagOriginalLines = countTotalLines(before || patch.fullContent);
      const diagIsConstrained = isConstrainedLocalizedPatchTask(input.task);
      const diagBeforeJsx = countJsxTagsDiagnostic(before);
      const diagAfterJsx = countJsxTagsDiagnostic(patch.fullContent);

      debugLog(
        "[zone-patch-diagnostic]",
        JSON.stringify({
          filePath: patch.filePath,
          patchSource,
          addedLines: diagAdded,
          removedLines: diagRemoved,
          totalChangedLines: diagTotalChanged,
          totalOriginalLines: diagOriginalLines,
          changeRatio:
            diagOriginalLines > 0
              ? Number((diagTotalChanged / diagOriginalLines).toFixed(3))
              : 0,
          taskIsConstrained: diagIsConstrained,
          layer4Limit: { totalChanged: 20, removed: 5 },
          exceedsLayer4Limit: diagTotalChanged > 20 || diagRemoved > 5,
          jsxBefore: diagBeforeJsx,
          jsxAfter: diagAfterJsx,
          jsxDelta: {
            opens: diagAfterJsx.opens - diagBeforeJsx.opens,
            closes: diagAfterJsx.closes - diagBeforeJsx.closes,
            selfClosing:
              diagAfterJsx.selfClosing - diagBeforeJsx.selfClosing,
            balanced:
              diagAfterJsx.opens - diagBeforeJsx.opens ===
              diagAfterJsx.closes - diagBeforeJsx.closes,
          },
          validatorVerdict: {
            ok: effectiveOk,
            layersRun: report.layersRun,
            shortCircuitedAt: report.shortCircuitedAt,
            blockingCodes: effectiveBlocking.map((i) => i.code),
            warningCodes: effectiveWarningsWithDelimitersBypass.map((i) => i.code),
          },
          diffHeadSample: buildDiffHeadSample(diagDiff, 200),
        })
      );

      if (effectiveOk && effectiveWarningsWithDelimitersBypass.length === 0) {
        kept.push(patch);
        continue;
      }

      const allIssues = [...effectiveBlocking, ...effectiveWarningsWithDelimitersBypass];
      for (const issue of allIssues) {
        const warningText = `[${issue.code}] ${issue.message}`;
        internalWarnings.push(warningText);
        visibleWarnings.push(warningText);
      }

      if (effectiveForceBlocked) {
        correctnessMustBlock = true;
        validatorAllOk = false;
      } else if (effectiveForcePreviewOnly) {
        fallbackForcePreviewOnly = true;
      }

      if (!effectiveOk) {
        const diagDiffHeadSample = buildDiffHeadSample(diagDiff, 240);
        const blockingCodes = effectiveBlocking.map((i) => i.code);
        const retryableBlocking = blockingCodes.filter((c) =>
          retryableCorrectnessCodes.has(c)
        );
        const canAttemptRepair =
          retryableBlocking.length > 0 &&
          !correctnessRepairAttempted.has(patch.filePath) &&
          diagTotalChanged <= 25 &&
          patchSource !== "deterministic_fallback";
        const maxRepairAttempts = getInferenceMode() === "hosted" ? 1 : 1;

        if (canAttemptRepair && maxRepairAttempts >= 1) {
          correctnessRepairAttempted.add(patch.filePath);
          debugLog(
            "[zone-repair-start]",
            JSON.stringify({
              filePath: patch.filePath,
              blockingCodes,
              retryableBlocking,
              totalChangedLines: diagTotalChanged,
            })
          );
          debugLog(
            "[zone-repair-context]",
            JSON.stringify({
              filePath: patch.filePath,
              originalTask: input.task.slice(0, 400),
              previousRawPatchPreview: (rawPatchTextByFile[patch.filePath] ?? "")
                .slice(0, 400),
              diffHeadSample: diagDiffHeadSample,
            })
          );
          try {
            emitStructuredProgress({
              type: "generating_patch",
              title: "Generating a localized patch",
              status: "active",
              filePath: patch.filePath,
            });
            const repaired = await planFullPatchWithLlm({
              task: [
                input.task,
                "",
                "PATCH CORRECTNESS VALIDATION FAILED AFTER APPLYING YOUR PATCH.",
                "You MUST repair the previous patch.",
                "",
                "CRITICAL REPAIR RULES:",
                "- Repair the previous patch. Do not introduce new structure.",
                "- Do NOT wrap components.",
                "- Do NOT add new functions.",
                "- Only fix the syntax/JSX issue with the smallest possible localized edit.",
                "- Do NOT expand scope. Do NOT modify other files.",
                "- You MUST output a patch.",
                "",
                "Extra guidance:",
                "- Remove ANY suspicious or stray characters",
                "- Fix JSX structure if needed",
                "- Prefer smallest possible change",
                "",
                "STRICT PATCH RULES:",
                "- FIND block MUST exactly match existing code.",
                "- Do not approximate.",
                "- Do not regenerate large sections.",
                "",
                `TARGET FILE: ${patch.filePath}`,
                "",
                "Previous raw patch (for reference):",
                rawPatchTextByFile[patch.filePath] ?? "",
                "",
                "Patched content that failed validation:",
                patch.fullContent.slice(0, 9000),
                "",
                "Validator blocking codes:",
                blockingCodes.join(", "),
                "",
                "Diagnostic diff head sample:",
                diagDiffHeadSample,
              ].join("\n"),
              lastAddedFunctions,
              plannerSuggestedFile: plannerSelection?.filesToEdit?.[0],
              filePath: patch.filePath,
              fileContent: patch.fullContent,
              fullOriginalFileContent: patch.fullContent,
              repoSummary: projectSummary,
              repoPath: input.repoPath,
              taskIntent: taskIntent.normalizedTask || taskIntent.action,
              normalizedTaskIntent: detectMicroEditIntent(input.task)
                ? "micro_edit"
                : "standard",
              outputMode: "find_replace_patch",
              relevantFiles: [{ path: patch.filePath, content: patch.fullContent }],
              existingTargetFiles: allFiles.map((file) => file.path),
              executionPlan,
              relatedContext:
                "IMPORTANT: Only output a valid patch. Do not explain.",
            });
            if (repaired.mode !== "patch") {
              debugLog(
                "[zone-repair-validation-failed]",
                JSON.stringify({
                  filePath: patch.filePath,
                  reason: `repair_mode_${repaired.mode}`,
                })
              );
              visibleWarnings.push("repair_attempted_but_failed");
            } else {
              debugLog("[zone-repair-patch-generated]", patch.filePath);
              const applied = applyDeveloperPatchText(
                patch.fullContent,
                repaired.patchText,
                { filePath: patch.filePath }
              );
              if (!applied.ok) {
                debugLog(
                  "[zone-repair-validation-failed]",
                  JSON.stringify({
                    filePath: patch.filePath,
                    reason: "repair_patch_apply_failed",
                  })
                );
                const failure = parsePatchFailureWarning(applied.warning);
                if (failure.reason === "no_match_abort") {
                  debugLog("[zone-retry-skipped-no-match]", patch.filePath);
                  fallbackForcePreviewOnly = true;
                }
                if (failure.reason === "anchor_too_small_for_large_replace") {
                  fallbackForcePreviewOnly = true;
                }
                visibleWarnings.push("repair_attempted_but_failed");
              } else {
                const repairDiff = computeFileDiff(
                  patch.fullContent,
                  applied.fullContent
                );
                const repairChangedLines = repairDiff.filter(
                  (l) => l.type === "added" || l.type === "removed"
                ).length;
                if (repairChangedLines > 50) {
                  debugLog(
                    "[zone-retry-aborted-large-diff]",
                    JSON.stringify({
                      filePath: patch.filePath,
                      changedLines: repairChangedLines,
                    })
                  );
                  fallbackForcePreviewOnly = true;
                  visibleWarnings.push("repair_attempted_but_failed");
                  debugLog(
                    "[zone-repair-validation-failed]",
                    JSON.stringify({
                      filePath: patch.filePath,
                      reason: "repair_diff_too_large",
                      changedLines: repairChangedLines,
                    })
                  );
                  // fall through to blocked behavior (do not keep repaired content)
                } else {
                const report2 = validatePatchCorrectness({
                  filePath: patch.filePath,
                  originalContent: before,
                  updatedContent: applied.fullContent,
                  task: input.task,
                  isConstrained: isConstrainedLocalizedPatchTask(input.task),
                  taskConstraints: detectExistingStructureTaskConstraints(
                    input.task
                  ),
                  strictMode: patchSource === "deterministic_fallback",
                });
                if (report2.ok) {
                  debugLog(
                    "[zone-repair-validation-passed]",
                    JSON.stringify({ filePath: patch.filePath })
                  );
                  visibleWarnings.push("repair_attempted_and_passed");
                  kept.push({ filePath: patch.filePath, fullContent: applied.fullContent });
                  continue;
                }
                debugLog(
                  "[zone-repair-validation-failed]",
                  JSON.stringify({
                    filePath: patch.filePath,
                    blockingCodes: report2.blocking.map((i) => i.code),
                  })
                );
                visibleWarnings.push("repair_attempted_but_failed");
                }
              }
            }
          } catch (err) {
            debugLog(
              "[zone-repair-validation-failed]",
              JSON.stringify({
                filePath: patch.filePath,
                reason: err instanceof Error ? err.message : String(err),
              })
            );
            visibleWarnings.push("repair_attempted_but_failed");
          }
        } else if (retryableBlocking.length > 0 && diagTotalChanged > 25) {
          debugLog(
            "[zone-repair-skipped]",
            JSON.stringify({
              filePath: patch.filePath,
              reason: "patch_too_large",
              totalChangedLines: diagTotalChanged,
              blockingCodes,
            })
          );
        } else if (retryableBlocking.length > 0 && correctnessRepairAttempted.has(patch.filePath)) {
          debugLog(
            "[zone-repair-skipped]",
            JSON.stringify({
              filePath: patch.filePath,
              reason: "already_attempted",
              blockingCodes,
            })
          );
        }
        validatorAllOk = false;
        const firstBlockingCode =
          effectiveBlocking[0]?.code ?? "correctness_failed";
        for (const result of patchResults) {
          if (result.filePath === patch.filePath && result.status === "applied") {
            result.status = "failed";
            result.reason = firstBlockingCode;
          }
        }
        patchResults.push({
          filePath: patch.filePath,
          status: "failed",
          reason: firstBlockingCode,
        });
        continue;
      }

      kept.push(patch);
    }
    applyPatches = kept;
    if (applyPatches.length === 0) {
      patchSource = "no_patch";
    }
  }

  if (patchCountBeforeCorrectness > 0) {
    notifyProgress("Validating developer output...", {
      type: "patch_correctness_checked",
      message:
        applyPatches.length > 0
          ? `Patch correctness checks passed for ${applyPatches.length} file(s).`
          : "Patch correctness checks rejected all generated patches.",
      stage: "correctness",
      status: applyPatches.length > 0 ? "passed" : "rejected_all",
    });
  } else {
    notifyProgress("Validating developer output...", {
      type: "patch_correctness_checked",
      message: "Patch correctness checks skipped (no patches to validate).",
      stage: "correctness",
      status: "skipped",
    });
  }

  if (patchCountBeforeCorrectness > 0) {
    const validatedChangedLines = applyPatches.reduce((sum, p) => {
      const before = originalContents[p.filePath] ?? "";
      const diff = computeFileDiff(before, p.fullContent);
      return (
        sum + diff.filter((l) => l.type === "added" || l.type === "removed").length
      );
    }, 0);
    const validatedStatus: "success" | "warning" =
      applyPatches.length > 0 && validatorAllOk && !correctnessMustBlock
        ? "success"
        : "warning";
    emitStructuredProgress({
      type: "validated",
      title: "Patch validation completed",
      detail: `changed lines: ${validatedChangedLines}`,
      status: validatedStatus,
    });
  }

  if (input.atomicPatch && patchResults.some((result) => result.status === "failed")) {
    notifyProgress("Ready", {
      type: "patch_generation_failed",
      message: "Atomic patch mode: one or more files failed validation.",
      stage: "patch_gen",
      status: "atomic_patch_failed",
    });
    notifyProgress("Ready", {
      type: "run_completed",
      message: "Run finished with errors.",
      stage: "finalize",
      status: "failed",
    });
    reportProgress("Ready");
    debugLog("[zone-flow-early-return]", JSON.stringify({ step: "atomic_patch_failed", reason: "atomic_patch_failed" }));
    perf.finish("atomic patch failed");
    const atomicDiffLines = applyPatches.map((p) => {
      const before = originalContents[p.filePath] ?? "";
      const diff = computeFileDiff(before, p.fullContent);
      return {
        filePath: p.filePath,
        addedLines: diff.filter((l) => l.type === "added").length,
        removedLines: diff.filter((l) => l.type === "removed").length,
      };
    });
    const atomicReport = await generateFinalRunReport({
      task: input.task,
      contextFilesMeta: selectedContextFiles.map((f) => ({
        path: f.path,
        reason: f.reason,
      })),
      planObjective: executionPlan?.objective ?? null,
      planScopeSummary: executionPlan?.scopeSummary ?? null,
      patchSource,
      fileDiffs: atomicDiffLines,
      patchScope: analyzePatchScope({ applyPatches, originalContents }),
      decisionMode: "safe_to_apply",
      warnings: visibleWarnings,
      correctness: { status: "rejected_all", summary: "Atomic patch mode failed validation for one or more files." },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "failed",
    });
    return {
      ok: false,
      reason: "atomic_patch_failed",
      finalRunReport: atomicReport,
    };
  }

  reportProgress("Validating developer output...");
  const changedFileMetrics = applyPatches.map((patch) => {
    const before = originalContents[patch.filePath] ?? "";
    return {
      totalLines: countTotalLines(before || patch.fullContent),
      changedLines: countChangedLines(before, patch.fullContent),
    };
  });
  const normalizeForDiff = (content: string): string =>
    content.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();

  reportProgress("Building diff preview...");
  const fileDiffs = applyPatches.map((patch) => {
    const before = normalizeForDiff(originalContents[patch.filePath] ?? "");
    const after = normalizeForDiff(patch.fullContent);
    const diff = computeFileDiff(before, after);
    return {
      filePath: patch.filePath,
      diff,
      addedLines: diff.filter((line) => line.type === "added").length,
      removedLines: diff.filter((line) => line.type === "removed").length,
    };
  });
  const hasRealPatchEvidence =
    applyPatches.length > 0 &&
    fileDiffs.some((fileDiff) => fileDiff.addedLines > 0 || fileDiff.removedLines > 0);
  const noCodeChangeReason = hasRealPatchEvidence
    ? null
    : deriveNoCodeChangeReason(patchResults);
  const patchScope = analyzePatchScope({
    applyPatches,
    originalContents,
  });
  const isCommentOnlyRun =
    fileDiffs.length > 0 &&
    fileDiffs.every((fd) =>
      fd.diff
        .filter((line) => line.type !== "unchanged")
        .every(
          (line) =>
            line.type === "removed" || /^\s*(\/\/|\/\*|\*)/.test(line.content)
        )
    );

  if (isCommentOnlyRun) {
    patchScope.rewriteLikeSuspicion = false;
    patchScope.totalChangedLines = fileDiffs.reduce(
      (sum, fd) => sum + fd.addedLines + fd.removedLines,
      0
    );
  }

  const constrainedLargeRewriteAssessment = assessConstrainedTaskLargeRewrite({
    task: input.task,
    patchScope,
  });
  const constrainedTaskLargeRewriteBlocked =
    constrainedLargeRewriteAssessment.blockApply;
  const constrainedTaskLargeRewriteForcePreview =
    constrainedLargeRewriteAssessment.flagged &&
    !constrainedLargeRewriteAssessment.blockApply;
  if (constrainedLargeRewriteAssessment.flagged) {
    const detail = `+${patchScope.totalAddedLines}/-${patchScope.totalRemovedLines} lines (totalChanged=${patchScope.totalChangedLines}, rewriteLikeSuspicion=${patchScope.rewriteLikeSuspicion}).`;
    const warnMsg = `[constrained_task_large_rewrite] Patch is too large for a constrained minimal task. ${detail}`;
    internalWarnings.push(warnMsg);
    visibleWarnings.push(warnMsg);
  }

  const designSystemSignals = detectDesignSystemSignals({
    addedLines: collectAddedPatchLines({
      applyPatches,
      originalContents,
    }),
  });
  const normalizedIntent = detectMicroEditIntent(input.task)
    ? "micro_edit"
    : "standard";
  const intentMismatchDecision = detectIntentMismatch({
    taskIntent: normalizedIntent,
    patchScope,
    codeIntent: taskIntent.codeIntent,
  });
  const intentMismatch = evaluateIntentPatchMismatch({
    task: input.task,
    patchScope,
  });
  const uiMappingRisk = evaluateUiMappingRisk({
    task: input.task,
    patchScope,
  });
  const effectiveTaskRiskResult = softenTaskRiskForLocalizedPatch({
    taskRiskResult,
    patchScope,
  });
  let planAlignment: PlanAlignmentResult | null = null;
  if (executionPlan && applyPatches.length > 0) {
    try {
      planAlignment = evaluatePlanAlignment({
        plan: executionPlan,
        changedFiles: applyPatches.map((patch) => patch.filePath),
        massScopeScore: Math.max(
          intentMismatch.risk.breakdown.massScope,
          uiMappingRisk.risk.breakdown.massScope,
          effectiveTaskRiskResult.breakdown.massScope
        ),
      });
      debugLog(
        `[zone-plan-align] score=${planAlignment.score} outOfPlan=${planAlignment.outOfPlanFiles.length} scopeMismatch=${planAlignment.scopeMismatch}`
      );
      if (planAlignment.warning) {
        internalWarnings.push(planAlignment.warning);
        visibleWarnings.push(planAlignment.warning);
      }
    } catch (err) {
      console.warn(
        `[zone-plan-align] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  let verification: VerificationResult | null = null;
  if (applyPatches.length > 0) {
    try {
      verification = verifyPatch({
        changedFiles: applyPatches.map((patch) => patch.filePath),
        patchContent: applyPatches
          .map((patch) => `FILE: ${patch.filePath}\n${patch.fullContent}`)
          .join("\n\n"),
        task: input.task,
        repoFiles: allFiles.map((file) => file.path),
      });
      debugLog(
        `[zone-verify] score=${verification.score} warnings=${verification.warnings.length}`
      );
      if (verification.warnings.length > 0) {
        internalWarnings.push(...verification.warnings);
        visibleWarnings.push(...verification.warnings);
      }
    } catch (err) {
      console.warn(
        `[zone-verify] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  let runtimeVerification: RuntimeVerificationResult | null = null;
  let runtimeVerificationPlan: RuntimeVerificationPlanResult | null = null;
  let verificationRepairAttempted = false;
  const verificationAttempts: Array<{
    command?: string;
    status: string;
    failureType?: "code_related" | "tooling_issue" | "timeout" | "skipped";
    failureSummary: string;
  }> = [];
  const repairAttempts: Array<{
    attempt: number;
    files: string[];
    status: "generated" | "applied" | "skipped" | "failed";
    summary: string;
  }> = [];
  if (!input.hostedContext && applyPatches.length > 0) {
    try {
      // Apply patches to disk before running verification, otherwise verification
      // runs against the unmodified repo and can yield misleading "passed" results.
      const applyResult = await applyLlmPatches(applyPatches, input.repoPath);
      debugLog("[zone-apply-before-verify]", {
        attempted: applyPatches.length,
        applied: applyResult.applied.length,
        failed: applyResult.failed.length,
      });
      const plan = detectVerificationPlan({
        repoPath: input.repoPath,
        repoFiles: allFiles.map((file) => file.path),
        task: input.task,
        patchedFilePaths: applyPatches.map((p) => p.filePath),
      });
      const plannedCommandSummary =
        plan.length > 0 ? plan.map((s) => s.command).join(" → ") : "";
      notifyProgress("Validating developer output...", {
        type: "verification_planned",
        message:
          plan.length > 0
            ? `Runtime verification: ${plan.length} step(s) queued.`
            : "Runtime verification skipped (no detectable commands).",
        stage: "verification",
        status: plan.length > 0 ? "planned" : "skipped_no_command",
        ...(plannedCommandSummary ? { command: plannedCommandSummary } : {}),
      });
      if (plan.length > 0) {
        notifyProgress("Validating developer output...", {
          type: "verification_started",
          message: "Running repository verification commands.",
          stage: "verification",
          status: "running",
          command: plan[0]?.command,
        });
      }
      debugLog(
        "[zone-verification-start]",
        JSON.stringify({ steps: plan.map((s) => s.command) })
      );
      if (plan.length > 0) {
        emitStructuredProgress({
          type: "verification",
          title: "Running verification",
          command: plan[0]?.command,
          status: "active",
        });
      }
      runtimeVerificationPlan = await runRuntimeVerificationPlan({
        repoPath: input.repoPath,
        plan,
      });
      const rvp0 = runtimeVerificationPlan;
      debugLog(
        `[zone-runtime-verify] status=${rvp0.status} steps=${rvp0.steps.length}`
      );
      const mapFailureType = (
        status: RuntimeVerificationPlanResult["status"]
      ):
        | "code_related"
        | "tooling_issue"
        | "timeout"
        | "skipped"
        | undefined =>
        status === "failed_environment_or_tooling"
          ? "tooling_issue"
          : status === "failed_code_related"
            ? "code_related"
            : status === "timeout"
              ? "timeout"
              : status === "skipped_no_command"
                ? "skipped"
                : undefined;
      verificationAttempts.push(
        ...rvp0.steps.map((s) => ({
          command: s.command,
          status: s.status,
          failureType: mapFailureType(rvp0.status),
          failureSummary: s.summary,
        }))
      );
      // Keep the legacy single-command field populated for existing consumers.
      runtimeVerification =
        rvp0.steps[0] ?? {
          attempted: rvp0.attempted,
          status:
            rvp0.status === "passed"
              ? "passed"
              : rvp0.status === "timeout"
                ? "timeout"
                : rvp0.status === "skipped_no_command"
                  ? "skipped"
                  : "failed",
          command: rvp0.failedCommand,
          summary: rvp0.summary,
        };

      const combinedVerificationSummary = [
        rvp0.summary,
        ...rvp0.steps.map((s) => `${s.command ?? ""}\n${s.summary ?? ""}\n${s.stderr ?? ""}`.trim()),
      ]
        .filter(Boolean)
        .join("\n\n");
      let verificationErrorInfo = parseVerificationError(
        combinedVerificationSummary,
        applyPatches.map((p) => p.filePath),
        input.repoPath
      );
      if (verificationErrorInfo.failingFile) {
        const failingNorm = verificationErrorInfo.failingFile.replace(/\\/g, "/");
        const repoPaths = new Set(allFiles.map((f) => f.path));
        if (!repoPaths.has(failingNorm)) {
          const prefixedServer = `server/${failingNorm.replace(/^\.?\//, "")}`;
          const prefixedClient = `client/${failingNorm.replace(/^\.?\//, "")}`;
          const resolved =
            repoPaths.has(prefixedServer)
              ? prefixedServer
              : repoPaths.has(prefixedClient)
                ? prefixedClient
                : null;
          if (resolved) {
            verificationErrorInfo = { ...verificationErrorInfo, failingFile: resolved };
          }
        }
      }
      debugLog("[zone-verification-parse]", verificationErrorInfo);

      // Order is critical:
      // 1) parseVerificationError always runs first
      // 2) pre-existing skips only when parseVerificationError says so
      // 3) no-tests-found + failing file => try smart fix loop
      if (runtimeVerificationPlan && verificationErrorInfo.isPreExisting) {
        const msg = verificationErrorInfo.errorType === "no_tests_found"
          ? "Verification skipped: pre-existing issue (no tests found)"
          : "Verification skipped: pre-existing verification failure";
        debugLog("[zone-verification-preexisting]", {
          command: runtimeVerificationPlan.failedCommand ?? plan[0]?.command,
          failingFile: verificationErrorInfo.failingFile,
          errorType: verificationErrorInfo.errorType,
        });
        // Downgrade from code-related failure: do not block apply; do not enter repair loop.
        runtimeVerificationPlan = {
          ...runtimeVerificationPlan,
          status: "failed_environment_or_tooling",
          summary: msg,
        };
        runtimeVerification = {
          attempted: runtimeVerification.attempted,
          status: "skipped",
          command: runtimeVerification.command,
          summary: msg,
        };
        internalWarnings.push(msg);
        visibleWarnings.push(msg);
      }

      // Smart verification loop: if tests can't be found but we can attribute it to a specific file,
      // try to fix the test file via agent loop, then re-run verification.
      if (
        runtimeVerificationPlan &&
        runtimeVerificationPlan.status === "failed_code_related" &&
        verificationErrorInfo.errorType === "no_tests_found" &&
        verificationErrorInfo.failingFile &&
        input.repoPath &&
        plan.length > 0
      ) {
        const verificationCommand = runtimeVerificationPlan.failedCommand ?? plan[0]?.command ?? "";
        emitStructuredProgress({
          type: "verification_investigating" as any,
          title: "Investigating test failure...",
          status: "active",
        });
        emitStructuredProgress({
          type: "verification_fixing" as any,
          title: `Fixing test file: ${verificationErrorInfo.failingFile}`,
          status: "active",
          filePath: verificationErrorInfo.failingFile,
        });

        const fixResult = await runAgentLoop({
          task: [
            `The test file ${verificationErrorInfo.failingFile} has no tests or is broken.`,
            `Error: ${verificationErrorInfo.errorMessage}`,
            "Read the file, understand what's wrong, and fix it so tests can be found.",
            verificationCommand ? `Then verify with: ${verificationCommand}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          repoPath: input.repoPath,
          runId: typeof input.runId === "string" ? input.runId.trim() : "",
          framework,
          maxIterations: 5,
          abortSignal: input.abortSignal,
          onStructuredEvent: (evt) => {
            const rid = typeof input.runId === "string" ? input.runId.trim() : "";
            if (!rid) return;
            const e = evt as any;
            if (e && typeof e === "object" && e.type === "command_approval_required") {
              emitStructuredProgress({
                type: "command_approval_required" as any,
                title: "Command approval required",
                status: "active",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
            if (e && typeof e === "object" && e.type === "command_auto_approved") {
              emitStructuredProgress({
                type: "command_auto_approved" as any,
                title: "Command auto-approved",
                status: "success",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
            if (e && typeof e === "object" && e.type === "command_trusted") {
              emitStructuredProgress({
                type: "command_trusted" as any,
                title: "Trusted command auto-approved",
                status: "success",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
          },
          onProgress: (msg) => {
            emitStructuredProgress({
              type: "verification_fixing" as any,
              title: msg,
              status: "active",
            });
          },
          onToolCall: (name, args) => {
            emitStructuredProgress({
              type: "tool_call",
              title: `[fix] ${name}: ${String((args as any)?.filePath || (args as any)?.command || "")}`,
              status: "active",
            });
          },
          onToolResult: (name, result) => {
            emitStructuredProgress({
              type: "tool_result",
              title: String(result.output || "").slice(0, 100),
              status: result.success ? "success" : "error",
            });
          },
          userApiKey: input.userApiKey,
        });

        if (fixResult.success) {
          emitStructuredProgress({
            type: "verification_fixed" as any,
            title: "Test file fixed, re-running verification...",
            status: "success",
          });
          emitStructuredProgress({
            type: "chat_response",
            title: fixResult.summary || "Fixed test file to enable verification.",
            status: "success",
          });
          // Re-run verification after fix.
          const rerunAfterFix = await runRuntimeVerificationPlan({
            repoPath: input.repoPath,
            plan,
          });
          runtimeVerificationPlan = rerunAfterFix;
          const first = rerunAfterFix.steps[0];
          runtimeVerification =
            first ?? {
              attempted: rerunAfterFix.attempted,
              status:
                rerunAfterFix.status === "passed"
                  ? "passed"
                  : rerunAfterFix.status === "timeout"
                    ? "timeout"
                    : rerunAfterFix.status === "skipped_no_command"
                      ? "skipped"
                      : "failed",
              command: rerunAfterFix.failedCommand,
              summary: rerunAfterFix.summary,
            };
        } else {
          const w = "Could not fix test file automatically";
          internalWarnings.push(w);
          visibleWarnings.push(w);
        }
      }

      const patchedFilesSet = new Set(applyPatches.map((p) => p.filePath));
      const failingFileIsPatched =
        verificationErrorInfo.failingFile != null &&
        (patchedFilesSet.has(verificationErrorInfo.failingFile) ||
          Array.from(patchedFilesSet).some((p) =>
            verificationErrorInfo.failingFile!.endsWith(p)
          ));
      debugLog("[zone-verification-smart-check]", {
        status: runtimeVerificationPlan?.status,
        failingFile: verificationErrorInfo.failingFile,
        failingFileIsPatched,
        repoPathPresent: Boolean(input.repoPath),
        planLen: plan.length,
      });

      // Smart verification loop: if the failing file is NOT one we patched (e.g. a unit test),
      // investigate and attempt to fix that file, then re-run verification.
      if (
        runtimeVerificationPlan &&
        runtimeVerificationPlan.status === "failed_code_related" &&
        verificationErrorInfo.failingFile &&
        !failingFileIsPatched &&
        input.repoPath &&
        plan.length > 0
      ) {
        let deterministicAssertionFixSucceeded = false;
        // Deterministic assertion fix (fast path): update expected string in test file
        // to match the new value inferred from the patched source file.
        const isTestFile =
          /\.test\.[jt]sx?$/i.test(verificationErrorInfo.failingFile) ||
          /\.spec\.[jt]sx?$/i.test(verificationErrorInfo.failingFile);
        if (
          verificationErrorInfo.errorType === "assertion_error" &&
          isTestFile &&
          typeof verificationErrorInfo.failingLine === "number" &&
          verificationErrorInfo.failingLine > 0
        ) {
          try {
            const absFailing = path.join(input.repoPath, verificationErrorInfo.failingFile);
            const failingText = existsSync(absFailing) ? readFileSync(absFailing, "utf8") : "";
            const failingLines = failingText.split(/\r?\n/);
            const lineIdx = verificationErrorInfo.failingLine - 1;
            const window = [
              failingLines[lineIdx - 1] ?? "",
              failingLines[lineIdx] ?? "",
              failingLines[lineIdx + 1] ?? "",
            ].join("\n");
            const oldExpected = extractFirstStringLiteralFromLine(window);
            if (oldExpected) {
              // Infer new expected string from the patch's before/after for the patched source file.
              let inferredNew: string | null = null;
              for (const p of applyPatches) {
                const before = originalContents[p.filePath] ?? "";
                if (!before.includes(oldExpected)) continue;
                const after = p.fullContent ?? "";
                inferredNew = inferReplacementFromPatchedFile({
                  before,
                  after,
                  oldExpected,
                });
                if (inferredNew) break;
              }

              if (inferredNew) {
                emitStructuredProgress({
                  type: "verification_investigating" as any,
                  title: "Investigating test failure...",
                  status: "active",
                });
                emitStructuredProgress({
                  type: "verification_fixing" as any,
                  title: `Fixing: ${verificationErrorInfo.failingFile}`,
                  status: "active",
                  filePath: verificationErrorInfo.failingFile,
                });

                const replacementApplied =
                  failingLines[lineIdx] && failingLines[lineIdx].includes(oldExpected)
                    ? (() => {
                        failingLines[lineIdx] = failingLines[lineIdx].replace(
                          oldExpected,
                          inferredNew!
                        );
                        return true;
                      })()
                    : (() => {
                        // fallback: replace first occurrence in file
                        const idx = failingText.indexOf(oldExpected);
                        if (idx < 0) return false;
                        const nextText = failingText.replace(oldExpected, inferredNew!);
                        writeFileSync(absFailing, nextText, "utf8");
                        return true;
                      })();

                if (replacementApplied && failingLines[lineIdx]) {
                  // If we modified the failing line, write back joined content.
                  writeFileSync(absFailing, failingLines.join("\n"), "utf8");
                }

                // Re-run verification immediately.
                const rerunAfterDeterministicFix = await runRuntimeVerificationPlan({
                  repoPath: input.repoPath,
                  plan,
                });
                debugLog("[zone-verification-rerun]", {
                  status: rerunAfterDeterministicFix.status,
                  failedCommand: rerunAfterDeterministicFix.failedCommand,
                });
                if (rerunAfterDeterministicFix.status === "passed") {
                  emitStructuredProgress({
                    type: "verification_fixed" as any,
                    title: "Verification fixed.",
                    status: "success",
                  });
                  runtimeVerificationPlan = rerunAfterDeterministicFix;
                  const first = rerunAfterDeterministicFix.steps[0];
                  runtimeVerification =
                    first ?? {
                      attempted: rerunAfterDeterministicFix.attempted,
                      status: "passed",
                      command: rerunAfterDeterministicFix.failedCommand,
                      summary: rerunAfterDeterministicFix.summary,
                    };
                  deterministicAssertionFixSucceeded = true;
                }
              }
            }
          } catch (e) {
            console.warn(
              "[zone-verification-deterministic-fix] failed:",
              e instanceof Error ? e.message : String(e)
            );
          }
        }

        if (deterministicAssertionFixSucceeded) {
          // Deterministic fix worked; skip agent-loop fallback.
          // Continue through the outer verification flow with runtimeVerificationPlan updated.
        } else {
        debugLog("[zone-verification-investigating]", {
          failingFile: verificationErrorInfo.failingFile,
          errorType: verificationErrorInfo.errorType,
        });
        emitStructuredProgress({
          type: "verification_investigating" as any,
          title: "Investigating test failure...",
          status: "active",
        });
        emitStructuredProgress({
          type: "verification_fixing" as any,
          title: `Fixing: ${verificationErrorInfo.failingFile}`,
          status: "active",
          filePath: verificationErrorInfo.failingFile,
        });

        const verificationCommand = runtimeVerificationPlan.failedCommand ?? plan[0]?.command ?? "";
        const fixResult = await runAgentLoop({
          task: [
            `Target file: ${verificationErrorInfo.failingFile}`,
            "",
            "A verification command failed after applying a patch to a different file.",
            `Error type: ${verificationErrorInfo.errorType}`,
            `Error: ${verificationErrorInfo.errorMessage}`,
            "",
            "Fix ONLY the failing file above so that verification passes.",
            'If this is a Jest assertion mismatch, update the expected string to match the new behavior (e.g. "Email is required.").',
            "Do NOT run any commands. Only edit the file.",
          ].join("\n"),
          repoPath: input.repoPath,
          runId: typeof input.runId === "string" ? input.runId.trim() : "",
          framework,
          maxIterations: 8,
          abortSignal: input.abortSignal,
          onStructuredEvent: (evt) => {
            const rid = typeof input.runId === "string" ? input.runId.trim() : "";
            if (!rid) return;
            const e = evt as any;
            if (e && typeof e === "object" && e.type === "command_approval_required") {
              emitStructuredProgress({
                type: "command_approval_required" as any,
                title: "Command approval required",
                status: "active",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
            if (e && typeof e === "object" && e.type === "command_auto_approved") {
              emitStructuredProgress({
                type: "command_auto_approved" as any,
                title: "Command auto-approved",
                status: "success",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
            if (e && typeof e === "object" && e.type === "command_trusted") {
              emitStructuredProgress({
                type: "command_trusted" as any,
                title: "Trusted command auto-approved",
                status: "success",
                command: String(e.command || ""),
                approvalId: String(e.approvalId || ""),
              } as any);
            }
          },
          onProgress: (msg) => {
            emitStructuredProgress({
              type: "verification_fixing" as any,
              title: msg,
              status: "active",
            });
          },
          onToolCall: (name, args) => {
            emitStructuredProgress({
              type: "tool_call",
              title: `[fix] ${name}: ${String((args as any)?.filePath || (args as any)?.command || "")}`,
              status: "active",
            });
          },
          onToolResult: (_name, result) => {
            emitStructuredProgress({
              type: "tool_result",
              title: String(result.output || "").slice(0, 100),
              status: result.success ? "success" : "error",
            });
          },
          userApiKey: input.userApiKey,
        });
        debugLog("[zone-verification-fix-result]", {
          success: fixResult.success,
          error: fixResult.error,
          summary: String(fixResult.summary || "").slice(0, 400),
          filesModified: Array.isArray(fixResult.filesModified)
            ? fixResult.filesModified.slice(0, 20)
            : [],
        });

        if (fixResult.success) {
          debugLog("[zone-verification-fixed]", { failingFile: verificationErrorInfo.failingFile });
          emitStructuredProgress({
            type: "verification_fixed" as any,
            title: "Verification-related file fixed, re-running verification...",
            status: "success",
          });
          emitStructuredProgress({
            type: "chat_response",
            title: fixResult.summary || "Fixed verification-related file.",
            status: "success",
          });
          const rerunAfterFix = await runRuntimeVerificationPlan({
            repoPath: input.repoPath,
            plan,
          });
          runtimeVerificationPlan = rerunAfterFix;
          const first = rerunAfterFix.steps[0];
          runtimeVerification =
            first ?? {
              attempted: rerunAfterFix.attempted,
              status:
                rerunAfterFix.status === "passed"
                  ? "passed"
                  : rerunAfterFix.status === "timeout"
                    ? "timeout"
                    : rerunAfterFix.status === "skipped_no_command"
                      ? "skipped"
                      : "failed",
              command: rerunAfterFix.failedCommand,
              summary: rerunAfterFix.summary,
            };
          debugLog("[zone-verification-rerun]", {
            status: rerunAfterFix.status,
            failedCommand: rerunAfterFix.failedCommand,
          });
        } else {
          const w = "Could not fix failing verification file automatically";
          internalWarnings.push(w);
          visibleWarnings.push(w);
        }
      }
      }

      // Gate the existing repair loop so it only triggers when the failure is clearly attributable
      // to the patched file(s) and the error type matches common code-regression categories.
      const shouldEnterExistingRepairLoop =
        runtimeVerificationPlan &&
        runtimeVerificationPlan.status === "failed_code_related" &&
        failingFileIsPatched &&
        (verificationErrorInfo.errorType === "syntax_error" ||
          verificationErrorInfo.errorType === "assertion_error" ||
          verificationErrorInfo.errorType === "runtime_error" ||
          verificationErrorInfo.errorType === "unknown");

      if (runtimeVerificationPlan.status === "failed_code_related" && shouldEnterExistingRepairLoop) {
        debugLog(
          "[zone-verification-failed]",
          JSON.stringify({
            failureType: "code_related",
            command: runtimeVerificationPlan.failedCommand,
            failureSummary: runtimeVerificationPlan.summary,
          })
        );
        const warning = `Runtime verification failed (code): ${runtimeVerificationPlan.failedCommand ?? "unknown command"}`;
        internalWarnings.push(warning);
        visibleWarnings.push(warning);

        const inferenceMode = getInferenceMode();
        const maxRepairAttempts = inferenceMode === "hosted" ? 1 : 2;
        const touchesProtected = applyPatches.some((p) =>
          isProtectedDeveloperUiPath(p.filePath)
        );
        const safeRepairLineThreshold = 30;
        const totalChangedForRepair = applyPatches.reduce((sum, p) => {
          const before = originalContents[p.filePath] ?? "";
          const diff = computeFileDiff(before, p.fullContent);
          return (
            sum +
            diff.filter((l) => l.type === "added" || l.type === "removed").length
          );
        }, 0);
        if (touchesProtected || totalChangedForRepair > safeRepairLineThreshold) {
          debugLog(
            "[zone-repair-skipped]",
            JSON.stringify({
              reason: touchesProtected ? "protected_files" : "patch_too_large",
              changedFiles: applyPatches.map((p) => p.filePath),
              totalChangedLines: totalChangedForRepair,
              maxRepairAttempts,
            })
          );
          repairAttempts.push({
            attempt: 1,
            files: applyPatches.map((p) => p.filePath),
            status: "skipped",
            summary: touchesProtected
              ? "Repair skipped: patch touched protected files."
              : `Repair skipped: patch too large (>${safeRepairLineThreshold} changed lines).`,
          });
        } else if (applyPatches.length > 0) {
          for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
            verificationRepairAttempted = true;
            debugLog(
              "[zone-repair-start]",
              JSON.stringify({
                attempt,
                files: applyPatches.map((p) => p.filePath),
                command: runtimeVerificationPlan.failedCommand,
              })
            );
            try {
            const brief = buildRetryGuidanceFromFailure({
              issues: [
                {
                  code: "RUNTIME_VERIFICATION_FAILED",
                  message: [
                    runtimeVerificationPlan.failedCommand
                      ? `Command: ${runtimeVerificationPlan.failedCommand}`
                      : "",
                    runtimeVerificationPlan.summary,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
              ],
            });
            const guidanceText = formatRetryGuidanceBrief(brief);
            debugLog("[zone-runtime-verify-retry] attempting repair");

            // Patch only the already-changed files; keep changes minimal.
            repairAttempts.push({
              attempt,
              files: applyPatches.map((p) => p.filePath),
              status: "generated",
              summary: `Repair attempt ${attempt}: generating patch for changed file(s).`,
            });
            for (let idx = 0; idx < applyPatches.length; idx += 1) {
              const patch = applyPatches[idx];
              if (!patch) continue;
              emitStructuredProgress({
                type: "generating_patch",
                title: "Generating a localized patch",
                status: "active",
                filePath: patch.filePath,
              });
              const repaired = await planFullPatchWithLlm({
                task: [
                  input.task,
                  "",
                  "RUNTIME VERIFICATION FAILED AFTER APPLYING YOUR PATCH.",
                  "You MUST fix the failure with the smallest possible change.",
                  "You MUST ONLY modify the file below. Do NOT touch other files.",
                  "",
                  "STRICT PATCH RULES:",
                  "- FIND block MUST exactly match existing code.",
                  "- Do not approximate.",
                  "- Do not regenerate large sections.",
                  `TARGET FILE: ${patch.filePath}`,
                  "",
                  "Failure guidance:",
                  guidanceText,
                ].join("\n"),
                lastAddedFunctions,
                plannerSuggestedFile: plannerSelection?.filesToEdit?.[0],
                filePath: patch.filePath,
                fileContent: patch.fullContent,
                fullOriginalFileContent: patch.fullContent,
                repoSummary: projectSummary,
                repoPath: input.repoPath,
                taskIntent: taskIntent.normalizedTask || taskIntent.action,
                normalizedTaskIntent: detectMicroEditIntent(input.task)
                  ? "micro_edit"
                  : "standard",
                outputMode: "find_replace_patch",
                relevantFiles: [{ path: patch.filePath, content: patch.fullContent }],
                existingTargetFiles: allFiles.map((file) => file.path),
                executionPlan,
                relatedContext: "IMPORTANT: Only output a valid patch. Do not explain.",
              });
              if (repaired.mode !== "patch") continue;
              debugLog("[zone-repair-patch-generated]", patch.filePath);
              const applied = applyDeveloperPatchText(patch.fullContent, repaired.patchText, {
                filePath: patch.filePath,
              });
              if (!applied.ok) {
                const failure = parsePatchFailureWarning(applied.warning);
                if (failure.reason === "no_match_abort") {
                  debugLog("[zone-retry-skipped-no-match]", patch.filePath);
                  fallbackForcePreviewOnly = true;
                }
                if (failure.reason === "anchor_too_small_for_large_replace") {
                  fallbackForcePreviewOnly = true;
                }
                continue;
              }
              const diff = computeFileDiff(patch.fullContent, applied.fullContent);
              const changed = diff.filter((l) => l.type === "added" || l.type === "removed").length;
              if (changed > 50) {
                debugLog(
                  "[zone-retry-aborted-large-diff]",
                  JSON.stringify({ filePath: patch.filePath, changedLines: changed })
                );
                fallbackForcePreviewOnly = true;
                continue;
              }
              applyPatches[idx] = { filePath: patch.filePath, fullContent: applied.fullContent };
            }
            repairAttempts.push({
              attempt,
              files: applyPatches.map((p) => p.filePath),
              status: "applied",
              summary: `Repair attempt ${attempt}: patch applied to changed file(s).`,
            });

            // Re-run runtime verification after repair attempt.
            debugLog("[zone-repair-verification-start]", JSON.stringify({ attempt }));
            if (plan.length > 0) {
              emitStructuredProgress({
                type: "verification",
                title: "Running verification",
                command: plan[0]?.command,
                status: "active",
              });
            }
            runtimeVerificationPlan = await runRuntimeVerificationPlan({
              repoPath: input.repoPath,
              plan,
            });
            const rvp1 = runtimeVerificationPlan;
            debugLog(
              `[zone-runtime-verify-retry] status=${rvp1.status} steps=${rvp1.steps.length}`
            );
            verificationAttempts.push(
              ...rvp1.steps.map((s) => ({
                command: s.command,
                status: s.status,
                failureType: mapFailureType(rvp1.status),
                failureSummary: s.summary,
              }))
            );
            if (rvp1.status === "passed") {
              debugLog("[zone-repair-success]", JSON.stringify({ attempt }));
              break;
            }
            if (rvp1.status === "failed_environment_or_tooling") {
              debugLog(
                "[zone-repair-failed]",
                JSON.stringify({ attempt, reason: "tooling_issue" })
              );
              break;
            }
            debugLog(
              "[zone-repair-failed]",
              JSON.stringify({ attempt, reason: rvp1.status })
            );
          } catch (err) {
            repairAttempts.push({
              attempt,
              files: applyPatches.map((p) => p.filePath),
              status: "failed",
              summary: `Repair attempt ${attempt} failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
            console.warn(
              `[zone-runtime-verify-retry] skipped: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        }
      } else if (runtimeVerificationPlan.status === "failed_environment_or_tooling") {
        debugLog(
          "[zone-verification-failed]",
          JSON.stringify({
            failureType: "tooling_issue",
            command: runtimeVerificationPlan.failedCommand,
            failureSummary: runtimeVerificationPlan.summary,
          })
        );
        const warning =
          "Patch generated, but verification could not complete because of setup/tooling. " +
          `(${runtimeVerificationPlan.failedCommand ?? "unknown command"})`;
        internalWarnings.push(warning);
        visibleWarnings.push(warning);
      } else if (runtimeVerificationPlan.status === "timeout") {
        debugLog(
          "[zone-verification-failed]",
          JSON.stringify({
            failureType: "timeout",
            command: runtimeVerificationPlan.failedCommand,
            failureSummary: runtimeVerificationPlan.summary,
          })
        );
        const warning = `Runtime verification timed out: ${runtimeVerificationPlan.failedCommand ?? "unknown command"}`;
        internalWarnings.push(warning);
        visibleWarnings.push(warning);
      }

      const rvp = runtimeVerificationPlan;
      const cmd = rvp.failedCommand ?? plan[0]?.command;
      if (rvp.status === "passed") {
        notifyProgress("Validating developer output...", {
          type: "verification_passed",
          message: "Runtime verification completed successfully.",
          stage: "verification",
          status: "passed",
          ...(plannedCommandSummary ? { command: plannedCommandSummary } : {}),
        });
      } else if (rvp.status === "failed_environment_or_tooling") {
        notifyProgress("Validating developer output...", {
          type: "tooling_issue",
          message:
            rvp.summary ||
            "Verification could not complete because of setup or tooling.",
          stage: "verification",
          status: "failed_environment_or_tooling",
          ...(cmd ? { command: cmd } : {}),
        });
      } else if (rvp.status === "failed_code_related" || rvp.status === "timeout") {
        notifyProgress("Validating developer output...", {
          type: "verification_failed",
          message: rvp.summary || `Verification outcome: ${rvp.status}`,
          stage: "verification",
          status: rvp.status,
          ...(cmd ? { command: cmd } : {}),
        });
      }
    } catch (err) {
      runtimeVerification = {
        attempted: false,
        status: "skipped",
        summary: `Runtime verification skipped: ${err instanceof Error ? err.message : String(err)}`,
      };
      console.warn(`[zone-runtime-verify] skipped`);
      notifyProgress("Validating developer output...", {
        type: "tooling_issue",
        message: `Runtime verification skipped: ${err instanceof Error ? err.message : String(err)}`,
        stage: "verification",
        status: "runtime_verify_exception",
      });
    }
  }
  logRiskDebug("runLlmPatchFlow after task-risk adjustments", {
    task: input.task,
    patchScope,
    taskRiskResult,
    effectiveTaskRiskResult,
    intentMismatchRisk: intentMismatch.risk,
    uiMappingRisk: uiMappingRisk.risk,
  });
  if (intentMismatch.warnings.length > 0) {
    internalWarnings.push(...intentMismatch.warnings);
    visibleWarnings.push(...intentMismatch.warnings);
  }
    if (uiMappingRisk.warnings.length > 0) {
      internalWarnings.push(...uiMappingRisk.warnings);
      visibleWarnings.push(...uiMappingRisk.warnings);
    }
    if (effectiveTaskRiskResult.score >= 71) {
      internalWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
      visibleWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
    } else if (effectiveTaskRiskResult.score >= 31) {
      internalWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
      visibleWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
    }

  let syncedInternalWarnings = internalWarnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score")
  );
  let syncedVisibleWarnings = visibleWarnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score")
  );

    const developerConfidenceBaseRaw = calculateDeveloperConfidence({
      warnings: syncedInternalWarnings,
      changedFileCount: applyPatches.length,
      changedFileMetrics,
      vagueTask,
    });
    let developerConfidenceBase = isCommentOnlyRun
      ? Math.max(developerConfidenceBaseRaw, 85)
      : developerConfidenceBaseRaw;
    if (applyPatches.length === 0 && patchPlan.patches.length > 0) {
      developerConfidenceBase = Math.min(developerConfidenceBase, 40);
    }
  const confidenceCaps = [
    intentMismatchDecision.severity === "medium"
      ? intentMismatchDecision.confidenceCap
      : undefined,
    uiMappingRisk.confidenceCap,
    planAlignment?.score,
    verification?.score,
    runtimeVerification?.status === "failed"
      ? Math.max(0, developerConfidenceBase - 15)
      : undefined,
  ].filter((value): value is number => typeof value === "number");
  let developerConfidence =
    confidenceCaps.length > 0
      ? Math.min(developerConfidenceBase, ...confidenceCaps)
      : developerConfidenceBase;
  if (patchSource === "deterministic_fallback") {
    developerConfidence = Math.min(developerConfidence, 65);
  }
  const runtimeVerificationFailed =
    runtimeVerification?.attempted === true &&
    (runtimeVerification.status === "failed" || runtimeVerification.status === "timeout");
  const runtimeVerificationCodeFailed = runtimeVerificationPlan?.status === "failed_code_related";
  const runtimeVerificationToolingFailed =
    runtimeVerificationPlan?.status === "failed_environment_or_tooling";
  const runtimeFailureGuidance =
    (runtimeVerificationCodeFailed || runtimeVerification?.status === "timeout") && runtimeVerification
      ? buildRetryGuidanceFromFailure({
          issues: [
            {
              code:
                runtimeVerification.status === "timeout"
                  ? "RUNTIME_VERIFICATION_TIMEOUT"
                  : "RUNTIME_VERIFICATION_FAILED",
              message: [
                runtimeVerification.command
                  ? `Command: ${runtimeVerification.command}`
                  : "",
                runtimeVerification.summary,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        })
      : null;

  const allDiffLines = fileDiffs.flatMap((fd) =>
    fd.diff.map(
      (line) =>
        `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
    )
  );
  const patchQuality = scorePatchQuality({
    taskIntent: normalizedIntent,
    patchScope,
    validationWarnings: visibleWarnings,
    designSystemSignals,
    intentMismatch: intentMismatchDecision,
    diffLines: allDiffLines,
  });
  const microEditProtection = enforceMicroEditProtection({
    taskIntent: normalizedIntent,
    patchScope,
    intentMismatch: intentMismatchDecision,
    patchQuality,
  });
  const mergedDeveloperRisk = {
      score: Math.max(
        intentMismatch.risk.score,
        uiMappingRisk.risk.score,
        effectiveTaskRiskResult.score
      ),
      breakdown: {
        destructive: Math.max(
          intentMismatch.risk.breakdown.destructive,
          uiMappingRisk.risk.breakdown.destructive,
          effectiveTaskRiskResult.breakdown.destructive
      ),
      schema: Math.max(
        intentMismatch.risk.breakdown.schema,
          uiMappingRisk.risk.breakdown.schema,
          effectiveTaskRiskResult.breakdown.schema
      ),
      massScope: Math.max(
        intentMismatch.risk.breakdown.massScope,
          uiMappingRisk.risk.breakdown.massScope,
          effectiveTaskRiskResult.breakdown.massScope
      ),
    },
  };
  if (microEditProtection.isViolation) {
    syncedInternalWarnings.push(...microEditProtection.violationReasons);
    syncedVisibleWarnings.push(...microEditProtection.violationReasons);
  }

const hasBlockedPatch = patchResults.some(r => r.status === "failed" && r.reason === "developer_validation_blocked");
if (
  input.hostedContext &&
  patchResults.some((result) => result.status === "failed") &&
  applyPatches.length > 0
) {
  const rolledBackPaths = new Set(applyPatches.map((patch) => patch.filePath));
  if (rolledBackPaths.size > 0) {
    applyPatches = [];
    for (const result of patchResults) {
      if (
        result.status === "applied" &&
        rolledBackPaths.has(result.filePath)
      ) {
        result.status = "failed";
        result.reason = "atomic_rollback";
      }
    }
    syncedVisibleWarnings.push(
      "[ATOMIC_ROLLBACK] One or more files failed validation. All changes in this patch set have been rolled back."
    );
  }
}
const finalDeveloperRiskScore = applySafePatchRiskCap({
  developerRisk: mergedDeveloperRisk,
  patchScope,
  hasIntentMismatch: intentMismatchDecision.hasMismatch,
  hasMicroEditViolation: microEditProtection.isViolation,
  hasValidationBlock: hasBlockedPatch,
});
let finalDeveloperRisk = {
  ...mergedDeveloperRisk,
  score: finalDeveloperRiskScore,
};

// Micro-destructive: tiny localized removals should not carry full destructive weight.
if (patchScope.changedFileCount === 1 && applyPatches.length === 1) {
  const onlyPath = applyPatches[0]?.filePath ?? "";
  const originalLines = countTotalLines(originalContents[onlyPath] ?? "");
  const changeRatio =
    originalLines > 0 ? patchScope.totalChangedLines / originalLines : 1;
  const isMicroDestructive =
    patchScope.totalChangedLines <= 3 &&
    patchScope.totalRemovedLines <= 3 &&
    changeRatio < 0.01;
  if (
    isMicroDestructive &&
    finalDeveloperRisk.breakdown.schema === 0 &&
    finalDeveloperRisk.breakdown.massScope === 0 &&
    finalDeveloperRisk.breakdown.destructive > 0
  ) {
    finalDeveloperRisk = {
      ...finalDeveloperRisk,
      score: Math.min(finalDeveloperRisk.score, 5),
      breakdown: {
        ...finalDeveloperRisk.breakdown,
        destructive: Math.min(finalDeveloperRisk.breakdown.destructive, 5),
      },
    };
  }
}
logRiskDebug("runLlmPatchFlow final risk", {
  task: input.task,
  patchScope,
  mergedDeveloperRisk,
  finalDeveloperRisk,
  // Phase J.1: hasBlockedPatch (validateDeveloperOutput security block) now
  // produces decisionMode=blocked. Soft signals (vagueTask, low confidence,
  // intent mismatch, etc.) no longer gate apply — they're recorded in
  // warnings/safety reasons but the verdict is safe_to_apply.
  decisionMode:
    runtimeVerificationFailed
      ? "blocked"
      : constrainedTaskLargeRewriteBlocked
        ? "blocked"
        : hasBlockedPatch
          ? "blocked"
          : "safe_to_apply",
});
syncedInternalWarnings = syncDeveloperRiskWarnings({
  warnings: syncedInternalWarnings,
  developerRisk: finalDeveloperRisk,
});
syncedVisibleWarnings = syncDeveloperRiskWarnings({
  warnings: syncedVisibleWarnings,
  developerRisk: finalDeveloperRisk,
});
if (noCodeChangeReason) {
  const noCodeChangeWarning = `[NO_CODE_CHANGE_PRODUCED] ${noCodeChangeReason}`;
  if (!syncedInternalWarnings.includes(noCodeChangeWarning)) {
    syncedInternalWarnings.push(noCodeChangeWarning);
  }
  if (!syncedVisibleWarnings.includes(noCodeChangeWarning)) {
    syncedVisibleWarnings.push(noCodeChangeWarning);
  }
}

// Phase J.1: every patch flow either applies (safe_to_apply) or hard-blocks
// for a real security/verification violation. The previous chain of soft
// preview_only triggers (vagueTask, low confidence, intent mismatch, micro-
// edit protection, fallback preview, etc.) no longer gates the verdict.
// hasBlockedPatch (validateDeveloperOutput hit DEVELOPER_SECRET_LOGGING /
// DEVELOPER_VALIDATION_REMOVAL / DEVELOPER_AUTH_WEAKENING) is promoted into
// the "blocked" branch so security violations stay non-applicable.
let decisionMode: "preview_only" | "safe_to_apply" | "blocked" =
  (runtimeVerificationCodeFailed || runtimeVerification?.status === "timeout")
    ? "blocked"
    : deterministicFallbackTooLarge
      ? "blocked"
      : correctnessMustBlock
        ? "blocked"
      : constrainedTaskLargeRewriteBlocked
      ? "blocked"
      : hasBlockedPatch
        ? "blocked"
        : "safe_to_apply";
  // Minimal safe patch fast-path: tiny additive patch + validator ok + low risk => safe_to_apply.
  // This intentionally ignores warnings and verifyPatch warnings; only blocking signals matter.
  if (
    decisionMode !== "blocked" &&
    applyPatches.length === 1 &&
    patchScope.changedFileCount === 1 &&
    patchScope.totalChangedLines <= 3 &&
    patchScope.totalRemovedLines <= 1 &&
    patchScope.totalAddedLines >= 1 &&
    validatorAllOk === true &&
    finalDeveloperRisk.score <= 10 &&
    finalDeveloperRisk.breakdown.schema === 0 &&
    finalDeveloperRisk.breakdown.destructive === 0 &&
    finalDeveloperRisk.breakdown.massScope === 0 &&
    !patchScope.rewriteLikeSuspicion &&
    !patchScope.cssRewriteSuspicion &&
    !hasBlockedPatch &&
    !vagueTask &&
    !microEditProtection.shouldForcePreview &&
    !intentMismatchDecision.forcePreviewOnly &&
    !uiMappingRisk.forcePreviewOnly &&
    !fallbackForcePreviewOnly &&
    !constrainedTaskLargeRewriteForcePreview &&
    !constrainedTaskLargeRewriteBlocked &&
    (verification == null || verification.score >= 60)
  ) {
    const previousDecision = decisionMode;
    debugLog(
      "[zone-decision-fast-path]",
      JSON.stringify({
        applied: true,
        reason: "minimal_safe_patch",
        previousDecision,
        nextDecision: "safe_to_apply",
      })
    );
    decisionMode = "safe_to_apply";
  }
  // Phase J.1: minimal-safe-patch override (was: preview_only → safe_to_apply
  // for tiny additive patches). Now unreachable since decisionMode never lands
  // on preview_only. Kept as a comment marker for J.5 cleanup; the safe_to_apply
  // verdict we'd want is already the default for non-blocked runs.
  // Phase J.1: previously, "no patches produced" downgraded safe_to_apply →
  // preview_only so the UI showed a "preview" verdict on empty diffs. With
  // preview_only collapsed, leave the decision as safe_to_apply — the UI
  // already shows a "no changes made" indicator separately when fileDiffs
  // is empty.

  // LAST-MILE minimal safe patch override.
  // This runs after all other decision calculations and before response payload construction.
  const minimalSafePatch =
    applyPatches.length === 1 &&
    patchScope.changedFileCount === 1 &&
    patchScope.totalChangedLines <= 3 &&
    validatorAllOk === true &&
    finalDeveloperRisk.score <= 10 &&
    !patchScope.rewriteLikeSuspicion &&
    !patchScope.cssRewriteSuspicion &&
    !finalDeveloperRisk.breakdown?.schema &&
    !finalDeveloperRisk.breakdown?.massScope &&
    !finalDeveloperRisk.breakdown?.destructive &&
    patchScope.totalRemovedLines <= 1 &&
    (verification == null || verification.score >= 60);
  if (minimalSafePatch && decisionMode !== "safe_to_apply") {
    debugLog("[zone-decision-fast-path]", {
      applied: true,
      reason: "minimal_safe_patch",
      previousDecision: decisionMode,
      nextDecision: "safe_to_apply",
      patchScope,
      finalDeveloperRisk,
    });
    decisionMode = "safe_to_apply";
  }
  const verificationStatus: "passed" | "skipped" | "tooling_issue" | "code_failed" | "timeout" =
    runtimeVerificationPlan?.status === "passed"
      ? "passed"
      : runtimeVerificationPlan?.status === "skipped_no_command"
        ? "skipped"
        : runtimeVerificationPlan?.status === "failed_environment_or_tooling"
          ? "tooling_issue"
          : runtimeVerificationPlan?.status === "failed_code_related"
            ? "code_failed"
            : runtimeVerificationPlan?.status === "timeout"
              ? "timeout"
              : runtimeVerification?.status === "timeout"
                ? "timeout"
                : runtimeVerification
                  ? "code_failed"
                  : "skipped";

  const finalExecutionOutcome:
    | "completed"
    | "completed_with_verification_skipped"
    | "completed_with_tooling_issue"
    | "failed_verification"
    | "failed_after_retry"
    | "completed_with_issues" =
    noCodeChangeReason || constrainedTaskLargeRewriteBlocked
      ? "completed_with_issues"
      : verificationStatus === "passed"
        ? "completed"
        : verificationStatus === "skipped"
          ? "completed_with_verification_skipped"
          : verificationStatus === "tooling_issue"
            ? "completed_with_tooling_issue"
            : verificationStatus === "timeout"
              ? "completed_with_issues"
              : verificationRepairAttempted
                ? "failed_after_retry"
                : "failed_verification";
  const resultState:
    | "completed_verified"
    | "completed_after_repair"
    | "failed_verification"
    | "failed_after_repair"
    | "completed_with_tooling_issue" =
    verificationStatus === "passed"
      ? verificationRepairAttempted
        ? "completed_after_repair"
        : "completed_verified"
      : verificationStatus === "tooling_issue"
        ? "completed_with_tooling_issue"
        : verificationRepairAttempted
          ? "failed_after_repair"
          : "failed_verification";
  const noApplyablePatch = applyPatches.length === 0 || patchSource === "no_patch";
  const finalState: "preview_only" | "safe_to_apply" | "blocked" =
    decisionMode === "blocked"
      ? "blocked"
      : finalExecutionOutcome === "failed_verification" ||
          finalExecutionOutcome === "failed_after_retry"
        ? "blocked"
        // Phase J.1: completed_with_issues promotes to blocked unless we
        // genuinely had nothing to apply (no LLM-produced structured patch
        // AND no apply patches). The previous condition also required
        // decisionMode === "preview_only", which is now collapsed; the
        // remaining no-patch / no-structured exception preserves the
        // "nothing happened, don't hard-block" semantics for empty-diff runs.
        : finalExecutionOutcome === "completed_with_issues" &&
            !(noApplyablePatch && patchPreviewHadNoStructuredPatchesFromLlm)
          ? "blocked"
          : decisionMode;
  const validationBlocked = finalState === "blocked";
  if ((runtimeVerificationCodeFailed || runtimeVerification?.status === "timeout") && runtimeVerification) {
    const warning = `Final verification did not pass: ${runtimeVerification.command ?? "unknown command"} (${runtimeVerification.status}).`;
    if (!syncedInternalWarnings.includes(warning)) syncedInternalWarnings.push(warning);
    if (!syncedVisibleWarnings.includes(warning)) syncedVisibleWarnings.push(warning);
    if (runtimeFailureGuidance) {
      const correctionWarning = `Required correction: ${runtimeFailureGuidance.requiredFix}`;
      const noChangeWarning =
        "Verification failed; do not treat this as no changes needed unless the repo can be proven to already match the requested correct state.";
      if (!syncedInternalWarnings.includes(correctionWarning)) {
        syncedInternalWarnings.push(correctionWarning);
      }
      if (!syncedVisibleWarnings.includes(correctionWarning)) {
        syncedVisibleWarnings.push(correctionWarning);
      }
      if (!syncedInternalWarnings.includes(noChangeWarning)) {
        syncedInternalWarnings.push(noChangeWarning);
      }
      if (!syncedVisibleWarnings.includes(noChangeWarning)) {
        syncedVisibleWarnings.push(noChangeWarning);
      }
    }
  }
  const safetyResolution = resolveSafetyLevel({
    hasBlockedPatch:
      hasBlockedPatch ||
      runtimeVerificationFailed ||
      constrainedTaskLargeRewriteBlocked,
    developerConfidence,
    decisionMode: decisionMode === "blocked" ? "preview_only" : decisionMode,
    developerRiskScore: finalDeveloperRisk.score,
    intentMismatch: {
      hasMismatch: intentMismatchDecision.hasMismatch,
      severity: intentMismatchDecision.severity,
    },
    patchQuality,
  });
  const finalSafetyResolution =
    microEditProtection.shouldDowngradeSafety &&
    safetyResolution.safetyLevel !== "high_risk_blocked"
      ? {
          ...safetyResolution,
          safetyLevel: "preview_only" as const,
          safetyReasons: [
            ...safetyResolution.safetyReasons,
            ...microEditProtection.violationReasons,
          ],
        }
      : safetyResolution;
  perf.mark("decision evaluation complete");

  // 7. Build patchPreview string
  const patchPreview = [
    ...(constrainedLargeRewriteAssessment.flagged
      ? ["Patch is too large for a constrained minimal task.", ""]
      : []),
    "=== LLM PATCH PREVIEW ===",
    `Summary: ${patchPlan.summary}`,
    ...(selectedTargetFile ? [`Targeted file: ${selectedTargetFile}`] : []),
    "",
    "Patches:",
    ...patchPlan.patches.map(
      (p) =>
        `- ${p.path} [${p.operation}]\n  ${p.summary}\n  Hint: ${p.targetHint}`
    ),
    ...(patchResults.length > 0
      ? [
          "",
          "=== PATCH RESULTS ===",
          ...patchResults.map((result) =>
            renderPatchResultLine(result, syncedInternalWarnings)
          ),
        ]
      : []),
    ...(syncedVisibleWarnings.length > 0
      ? ["", "Warnings:", ...syncedVisibleWarnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");

  const verificationCommandsForReport =
    runtimeVerificationPlan && runtimeVerificationPlan.steps.length > 0
      ? runtimeVerificationPlan.steps
          .map((s) => s.command)
          .filter((c): c is string => typeof c === "string" && c.length > 0)
          .join(" → ")
      : null;

  const correctnessForReport =
    patchCountBeforeCorrectness > 0
      ? applyPatches.length > 0
        ? {
            status: "passed" as const,
            summary: "Remaining patches passed Zone patch correctness validation.",
          }
        : {
            status: "rejected_all" as const,
            summary: "Patch correctness validation rejected all generated patches.",
          }
      : {
          status: "skipped" as const,
          summary: "No patches entered correctness validation.",
        };

  const finalRunReport = await generateFinalRunReport({
    task: input.task,
    contextFilesMeta: selectedContextFiles.map((f) => ({
      path: f.path,
      reason: f.reason,
    })),
    planObjective: executionPlan?.objective ?? null,
    planScopeSummary: executionPlan?.scopeSummary ?? null,
    patchSource,
    fileDiffs: fileDiffs.map((fd) => ({
      filePath: fd.filePath,
      addedLines: fd.addedLines,
      removedLines: fd.removedLines,
    })),
    patchScope,
    decisionMode,
    finalState,
    warnings: syncedVisibleWarnings,
    correctness: correctnessForReport,
    verificationCommandsLabel: verificationCommandsForReport,
    runtimeVerificationSummary: runtimeVerificationPlan?.summary ?? null,
    runtimeVerificationFailedCommand: runtimeVerificationPlan?.failedCommand ?? null,
    verificationStatus,
    finalExecutionOutcome,
    developerConfidence,
  });

  let handoffReport: ZoneHandoffReport | undefined;
  const hasHandoffWorthyDiff =
    applyPatches.length > 0 &&
    fileDiffs.some((fd) => fd.addedLines > 0 || fd.removedLines > 0);
  // Phase J.1: previously gated on safe_to_apply OR preview_only. The
  // preview_only branch collapsed; safe_to_apply alone covers the same set.
  if (decisionMode === "safe_to_apply" && hasHandoffWorthyDiff) {
    const normalizePathKey = (p: string): string =>
      String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
    const patchDescByNorm = new Map<string, string>();
    for (const p of patchPlan.patches) {
      patchDescByNorm.set(
        normalizePathKey(p.path),
        String(p.summary || "").trim()
      );
    }
    const implLine = String(patchPlan.summary || "")
      .split(/\n/)[0]
      ?.trim();
    const changes: ZoneHandoffReport["changes"] = fileDiffs.map((fd) => {
      const norm = normalizePathKey(fd.filePath);
      const description = (
        patchDescByNorm.get(norm) ||
        implLine ||
        "Updated file"
      ).slice(0, 300);
      return {
        file: fd.filePath,
        added: fd.addedLines,
        removed: fd.removedLines,
        description,
      };
    });
    const handoffVerification: ZoneHandoffReport["verification"] =
      verificationStatus === "passed"
        ? "passed"
        : verificationStatus === "skipped" || verificationStatus === "tooling_issue"
          ? "skipped"
          : "failed";
    const changesSummary =
      changes.length > 0
        ? changes
            .map(
              (c) =>
                `- ${c.file} (+${c.added}/-${c.removed}): ${c.description}`
            )
            .join("\n")
        : "No recorded file diffs.";
    const suggestedNextPrompt = `The following changes were made to your repo:\n${changesSummary}\n\nYou can continue from here.`;
    handoffReport = {
      summary: "Zone applied the following changes:",
      changes,
      verification: handoffVerification,
      suggestedNextPrompt,
    };
    emitStructuredProgress({
      type: "handoff_report",
      title: "AI Handoff",
      status: "success",
      report: handoffReport,
    });
  }

  // 8. Return
  const runSummaryVerificationReason = deriveRuntimeVerificationReason(verificationStatus);
  const runSummaryVerificationCommands =
    runtimeVerificationCommands(runtimeVerificationPlan);
  const runSummary = assembleRunSummary({
    fileDiffs,
    verificationReason: runSummaryVerificationReason,
    verificationNote: deriveRuntimeVerificationNote({
      verificationStatus,
      runtimeVerificationPlan,
      runtimeVerification,
    }),
    verificationCommands: runSummaryVerificationCommands,
    decisionMode,
    totalUsd: getRunCost(input.userId ?? "local-dev", input.runId ?? ""),
    iterCost: latestIterCostUpdate,
  });
  emitStructuredProgress({
    type: "run_summary",
    title: "Run summary",
    status: "success",
    ...runSummary,
  });
  notifyProgress("Ready", {
    type: "run_completed",
    message: "Run finished successfully.",
    stage: "finalize",
    status: "success",
  });
  reportProgress("Ready");
  perf.mark("response payload ready");
  perf.finish("complete");
  return {
    ok: true,
    patchPreview,
    warnings: syncedVisibleWarnings,
    ...(noCodeChangeReason ? { reason: noCodeChangeReason } : {}),
    ...(selectedTargetFile ? { targetFile: selectedTargetFile } : {}),
    ...(tokenBudgetExceededAtExit ? { tokenBudgetExceeded: true as const } : {}),
    ...(loopDetectedAtExit ? { loopDetected: loopDetectedAtExit } : {}),
    developerConfidence,
    developerRisk: finalDeveloperRisk,
    intentMismatch: {
      hasMismatch: intentMismatchDecision.hasMismatch,
      severity: intentMismatchDecision.severity,
      reasonCodes: intentMismatchDecision.reasonCodes,
      warnings: intentMismatchDecision.warnings,
    },
    patchQuality,
    patchQualitySummary: {
      source: patchSource,
      fallbackUsed: patchSource === "deterministic_fallback",
      changedFileCount: patchScope.changedFileCount,
      totalChangedLines: patchScope.totalChangedLines,
    },
    designSystemSignals,
    safetyResolution: finalSafetyResolution,
    microEditProtection,
    decisionMode,
    finalState,
    finalExecutionOutcome,
    resultState,
    verificationStatus,
    attemptsUsed: runtimeVerification ? (verificationRepairAttempted ? 2 : 1) : undefined,
    ...(verificationAttempts.length > 0 ? { verificationAttempts } : {}),
    ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
    validationBlocked,
    ...(runtimeVerificationFailed && runtimeVerification
      ? {
          finalVerificationFailure: {
            status: runtimeVerification.status,
            command: runtimeVerification.command,
            summary: runtimeVerification.summary,
            ...(runtimeFailureGuidance
              ? {
                  rootCause: runtimeFailureGuidance.rootCause,
                  normalizedFailureReason:
                    runtimeFailureGuidance.normalizedFailureReason,
                  incorrectAssumption:
                    runtimeFailureGuidance.incorrectAssumption,
                  requiredFix: runtimeFailureGuidance.requiredFix,
                  constraint: runtimeFailureGuidance.nextAttemptConstraint,
                  scopeConstraint: runtimeFailureGuidance.scopeConstraint,
                }
              : {}),
          },
        }
      : {}),
    applyPatches,
    patchResults,
    fileDiffs,
    contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
    ...(executionPlan ? { plan: executionPlan } : {}),
    ...(planAlignment ? { planAlignment } : {}),
    ...(verification ? { verification } : {}),
    ...(runtimeVerification ? { runtimeVerification } : {}),
    ...(runtimeVerificationPlan ? { runtimeVerificationPlan } : {}),
    lifecycleEvents: [...lifecycleEvents],
    finalRunReport,
    ...(handoffReport ? { handoffReport } : {}),
  };
}

/**
 * Maps a structured event emitted by the agent loop into a ZoneStructuredProgressEvent
 * shape suitable for the TUI progress bus. Returns null for unrecognised types and for
 * side-effect-only events (iter_cost_update, todos_*, todo_status_changed) that are
 * handled inline in onStructuredEvent.
 * Pure — no state mutations, no I/O; safe to call from any context or test.
 */
export function mapStructuredEventToProgress(
  evt: unknown
): Omit<ZoneStructuredProgressEvent, "runId" | "ts"> | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as any;
  switch (e.type as string) {
    case "command_approval_required":
      return {
        type: "command_approval_required",
        title: "Command approval required",
        status: "active",
        command: String(e.command || ""),
        approvalId: String(e.approvalId || ""),
      };
    case "edit_approval_required":
      return {
        type: "edit_approval_required",
        title: "Edit approval required",
        status: "active",
        filePath: String(e.filePath || ""),
        approvalId: String(e.approvalId || ""),
      };
    case "command_auto_approved":
      return {
        type: "command_auto_approved",
        title: "Command auto-approved",
        status: "success",
        command: String(e.command || ""),
        approvalId: String(e.approvalId || ""),
      };
    case "command_trusted":
      return {
        type: "command_trusted",
        title: "Trusted command auto-approved",
        status: "success",
        command: String(e.command || ""),
        approvalId: String(e.approvalId || ""),
      };
    case "token_budget_status":
      return {
        type: "token_budget_status",
        title: String(e.title || "Token budget"),
        status:
          (e.status as "active" | "warning" | "error" | "success" | undefined) ??
          "active",
        cumulativeTokens:
          typeof e.cumulativeTokens === "number" ? e.cumulativeTokens : undefined,
        tokenBudgetCap:
          typeof e.tokenBudgetCap === "number" ? e.tokenBudgetCap : undefined,
        tokenBudgetRatio:
          typeof e.tokenBudgetRatio === "number" ? e.tokenBudgetRatio : undefined,
        iter: typeof e.iter === "number" ? e.iter : undefined,
        breakdown:
          e.breakdown && typeof e.breakdown === "object"
            ? e.breakdown
            : undefined,
      };
    case "subagent_started":
    case "subagent_completed":
      return {
        type: e.type as "subagent_started" | "subagent_completed",
        title: String(e.title || e.type).slice(0, 160),
        status: e.status as "active" | "success" | "warning" | "error" | undefined,
        subagentStatus: e.subagentStatus,
        subagentId: e.subagentId,
        subagentType: e.subagentType,
        parentRunId: e.parentRunId,
      };
    case "narration":
      return {
        type: "narration",
        title: String(e.title || "").slice(0, 200),
        text: String(e.text || "").slice(0, 2000),
        iter: typeof e.iter === "number" ? e.iter : undefined,
        status: "active",
      };
    case "thinking":
      return {
        type: "thinking",
        title: String(e.title || e.text || "").slice(0, 200),
        text: String(e.text || "").slice(0, 4000),
        iter: typeof e.iter === "number" ? e.iter : undefined,
        status: "active",
      };
    case "compaction_started":
      return {
        type: "compaction_started",
        title: "Compacting context",
        status: "active",
        count: typeof e.count === "number" ? e.count : 0,
      };
    case "compaction_status":
      return {
        type: "compaction_status",
        title: "Compacting context",
        status: "active",
        count: typeof e.count === "number" ? e.count : 0,
        tokensBefore: typeof e.tokensBefore === "number" ? e.tokensBefore : undefined,
        tokensAfter: typeof e.tokensAfter === "number" ? e.tokensAfter : undefined,
        savedTokens: typeof e.savedTokens === "number" ? e.savedTokens : undefined,
      };
    case "compaction_exhausted":
      return {
        type: "compaction_exhausted",
        title: "Context exhausted",
        status: "warning",
        message: typeof e.message === "string" ? e.message : "",
      };
    case "compaction_overflow_warning":
      return {
        type: "compaction_overflow_warning",
        title: "Context window full — no compactable history",
        status: "warning",
      };
    case "loop_warning_emitted":
      return {
        type: "loop_warning_emitted",
        title: String(e.title || "Loop warning"),
        status: "warning",
        toolName: String(e.toolName || ""),
        count: typeof e.count === "number" ? e.count : 0,
      };
    case "loop_detected_terminal":
      return {
        type: "loop_detected_terminal",
        title: String(e.title || "Loop detected"),
        status: "error",
        toolName: String(e.toolName || ""),
        count: typeof e.count === "number" ? e.count : 0,
      };
    case "staged_diffs_ready_for_approval":
      // plan_ready_for_approval intentionally bypasses this mapper — emitted from dispatch.ts
      // directly via progressCallback, not through the agent-loop onStructuredEvent channel.
      // Do NOT add plan_ready_for_approval here.
      return {
        type: "staged_diffs_ready_for_approval",
        title: String(e.title || "Review staged changes"),
        status: "active",
        approvalId: String(e.approvalId || ""),
        stagedFilesJson:
          typeof e.stagedFilesJson === "string" ? e.stagedFilesJson : undefined,
        stagedVerificationSummary:
          typeof e.stagedVerificationSummary === "string" ? e.stagedVerificationSummary : undefined,
        stagedTrigger:
          typeof e.stagedTrigger === "string" ? e.stagedTrigger : undefined,
      };
    default:
      return null;
  }
}
