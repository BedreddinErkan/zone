import { log } from "../utils/logger.js";
import { writeCacheLog } from "../utils/commandCacheLog.js";
import { recordToolResultSize } from "./toolResultSizeTracker.js";
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
  /** Questions asked this run — the longitudinal signal for whether the cap and
   *  the prompt discipline are right. */
  askCount: number;
  /** Wall-clock spent parked on a human. Excluded from the reported duration so a
   *  long pause reads as a pause, not as slow inference. */
  parkedMs: number;
  /** dispatch.ts's plan-mode gate decision, carried alongside the archetype it
   *  preceded so a misfire is one jq against this marker, no join against
   *  [zone-plan-mode] by runId. Null when the gate wasn't computed for this run
   *  (strict/checkpoint path, durable resume, or non-plan-mode runs). */
  leadVerb: string | null;
  mode: string | null;
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
  trigger: "iter_cap" | "rollback_x2" | "coaching_exhausted" | "forced_tier_blocking" | null;
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

export interface AskUserData {
  runId: string | null;
  archetype: TaskArchetype | null;
  tier: string | null;
  iter: number;
  questionChars: number;
  /** True when the run had already written files — asking late is a distinct
   *  pathology from asking lazily, and the two need separating in the data. */
  hadWrittenFiles: boolean;
}

export function emitAskUser(data: AskUserData): void {
  log("[zone-ask-user]", JSON.stringify({ event: "ask_user", ...data }));
}

export interface AskUserRefusedData {
  runId: string | null;
  /**
   * Why the ask did not reach a human. These indict different things and must not
   * collapse into one counter — the whole argument for refusing rather than hiding
   * the tool was that the attempt becomes a measurable event:
   *   cap_exceeded      — a second ask; the cap may be too tight
   *   pre_investigation — asked before looking; the prompt discipline isn't landing
   *   no_channel        — nobody could answer; a plumbing gap, not model behaviour
   *   user_declined     — the user dismissed it; repeated declines are their own signal
   */
  reason: "cap_exceeded" | "pre_investigation" | "no_channel" | "user_declined";
  archetype: TaskArchetype | null;
  iter: number;
  /**
   * Which variant of the reason. For no_channel: the declared channel, or
   * "subagent". For user_declined: "carried_over" when the user set aside a
   * suspended run at the turn boundary, null for the in-run Esc. The two
   * declines share a reason deliberately — they are the same signal — so this is
   * what keeps them separable without splitting the counter.
   */
  detail: string | null;
}

export function emitAskUserRefused(data: AskUserRefusedData): void {
  log("[zone-ask-user-refused]", JSON.stringify({ event: "ask_user_refused", ...data }));
}

export interface TerminalCallFailedData {
  /** Which terminal call: token_budget_wrapup | max_iterations_assessment | … */
  site: string;
  /** True when the cause was a request timeout rather than any other failure. */
  timedOut: boolean;
  errorName: string;
  errorMessage: string;
}

/**
 * A terminal summary/assessment call failed and was swallowed so the run could still
 * flush its work. Without this the swallow is indistinguishable from success, which
 * matters more now that a timeout there can cost tens of minutes before it happens.
 */
export function emitTerminalCallFailed(data: TerminalCallFailedData): void {
  log("[zone-terminal-call-failed]", JSON.stringify({ event: "terminal_call_failed", ...data }));
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
  /** Set only when a tier-derived tool subset is active (B.2). Omitted for complex / subagent loops. */
  toolSubsetSize?: number;
  /** Whether a real classifier output informed `tier`, or it's the "medium" literal
   *  default applied when no classification exists (e.g. the plan-investigation path,
   *  which calls runAgentLoop with no taskClassification at all). Without this, a
   *  record with confidence 0 and fallbackUsed false is indistinguishable from a
   *  real classification result unless the reader already knows buildFallback always
   *  sets fallbackUsed true. */
  classificationSource: "classifier" | "absent";
}

export function emitTierConstraints(data: TierConstraintsData): void {
  log("[zone-tier-constraints-applied]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitTierArchetypeMismatch — [zone-tier-archetype-mismatch]
// Emitted once per run when forceTier="simple" conflicts with a classified
// archetype that requires search/navigation tools.
// ---------------------------------------------------------------------------

export interface TierArchetypeMismatchData {
  runId: string | null | undefined;
  forcedTier: string;
  classifiedArchetype: string;
  archetypeConfidence: number;
  blockedTools: string[];
}

export function emitTierArchetypeMismatch(data: TierArchetypeMismatchData): void {
  log("[zone-tier-archetype-mismatch]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitTierGrantUnusable — [zone-tier-grant-unusable]
// Emitted once per run when tier grants a subagent quota for a tool the
// resolved toolset does not contain. Tier and archetype are decided
// independently; this makes the case where they disagree observable instead of
// silent. `removedBy` matters: dropping Task on a small task is a deliberate
// Zone decision (iteration-inflation.md Fix A), and a marker that cannot tell
// that apart from an accidental mismatch is noise.
// ---------------------------------------------------------------------------

export interface TierGrantUnusableData {
  runId: string | null | undefined;
  tier: string;
  archetype: string | null;
  grantedSubagentCalls: number;
  toolSubsetSize: number;
  removedBy: "task_too_small" | "capability_filter";
}

export function emitTierGrantUnusable(data: TierGrantUnusableData): void {
  log("[zone-tier-grant-unusable]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitWriteCapabilityAbsent — [zone-write-capability-absent]
// Emitted once per run when the resolved tool list contains no write-capable
// tool while the run is a patch (execution) run, not an investigation/chat
// one. Diagnosed from a run where the archetype dispatcher re-classified an
// approved-plan execution as `investigation` and applied its read-only
// capability filter — silent except when tier happened to also trip the
// unrelated [zone-tier-grant-unusable] subagent-quota gate. `filterSource`
// names which arm of the capability-filter precedence produced the read-only
// set, so the condition is actionable, not just observed.
// ---------------------------------------------------------------------------

export interface WriteCapabilityAbsentData {
  runId: string | null | undefined;
  mode: string;
  archetype: string | null;
  tier: string;
  toolSubsetSize: number;
  filterSource: "capabilityFilter" | "tierFilterFromClassifier" | "allowedTools" | "modeDefault" | "none";
  hasApprovedPlan: boolean;
}

export function emitWriteCapabilityAbsent(data: WriteCapabilityAbsentData): void {
  log("[zone-write-capability-absent]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitReadOnlyPipelineSuppressed — [zone-readonly-pipeline-suppressed]
// Emitted once per run when the archetype dispatcher resolved a read-only
// pipeline (investigation/question) but the run carries a user-approved plan
// with real steps — the fix for the condition [zone-write-capability-absent]
// names. The capability filter is suppressed so the run falls through to the
// tier-derived (write-capable) filter instead; iterCap/coachingBudget are
// left exactly as the pipeline set them. This is a silent-default override by
// construction, so it is not allowed to itself be silent.
//
// Emitted from agentLoop.ts's runAgentLoopScoped, after the system prompt is
// actually assembled — not from the suppression decision site
// (runLlmPatchFlow.ts, before the prompt exists), which can only ever report
// intent. `promptBranch` is the prompt-cage half of the fix: it's derived by
// checking which archetype-ternary header is actually present in the built
// system prompt (agentLoop.ts's QA_HEADER/INVESTIGATION_HEADER), so it
// reports the branch that really fired, not a re-evaluation of the condition
// that chose it.
// ---------------------------------------------------------------------------

export type PromptBranch = "question" | "investigation" | "default";

export interface ReadOnlyPipelineSuppressedData {
  runId: string | null | undefined;
  archetype: string | null;
  stepCount: number;
  promptBranch: PromptBranch;
}

export function emitReadOnlyPipelineSuppressed(data: ReadOnlyPipelineSuppressedData): void {
  log("[zone-readonly-pipeline-suppressed]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitReadOnlySuppressionMismatch — [zone-readonly-suppression-mismatch]
// Once the fix above lands, `promptBranch` is an invariant, not a variable:
// suppression only fires when planApproved is true, and planApproved forces
// the archetype ternary to its default branch unconditionally — so
// promptBranch can only ever be "default" when this marker's sibling fires.
// `readOnlyPipelineSuppressed` and `planApproved` are threaded onto
// AgentLoopInput separately, with nothing enforcing that they agree; if they
// ever drift (or a future archetype grows its own read-only preamble outside
// the effectiveArchetype gate), promptBranch stops being "default" while
// suppression is still true. That is the exact signature of the drift this
// whole fix exists to close, so it gets its own distinctly-named marker
// rather than a value sitting inside the payload above that nobody diffs.
// ---------------------------------------------------------------------------

export function emitReadOnlySuppressionMismatch(data: ReadOnlyPipelineSuppressedData): void {
  log("[zone-readonly-suppression-mismatch]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitPromptBranch — [zone-prompt-branch]
// Which arm of the archetype ternary actually assembled, for EVERY run.
//
// Deliberately a separate marker rather than widening the gate on
// [zone-readonly-pipeline-suppressed] above, which would have been the smaller
// diff: that marker means "suppression happened", promptBranch is a field ON
// that event, and its sibling [zone-readonly-suppression-mismatch] fires
// whenever promptBranch !== "default" INSIDE that gate — as a drift detector
// on the invariant suppression ⇒ planApproved ⇒ default branch. Widening the
// gate to runs that never suppressed would make the mismatch marker fire on
// every one of them: a false positive by construction, in the one detector
// built to catch this exact class of drift.
//
// Motivating gap: an answer-only plan (steps:[]) leaves hasApprovedSteps false,
// so readOnlyPipelineSuppressed is false, so NO prompt-branch telemetry existed
// for that shape at all — which is how it ran three measured passes against a
// patch contract before anyone noticed. Ungated here for the same reason: a
// branch decision that only reports for some shapes is how the next one hides.
// ---------------------------------------------------------------------------

export interface PromptBranchData {
  runId: string | null | undefined;
  archetype: string | null;
  planApproved: boolean;
  promptBranch: PromptBranch;
}

export function emitPromptBranch(data: PromptBranchData): void {
  log("[zone-prompt-branch]", JSON.stringify(data));
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
// emitManifestSetGrowth — [zone-manifest-set-growth]
// Emitted by ManifestInjectionProcessor when the file-read manifest entry set
// changes between iterations (file added or evicted by LRU cap, Phase 6.A).
// ---------------------------------------------------------------------------

export interface ManifestSetGrowthData {
  runId: string | null | undefined;
  iter: number;
  prevEntryCount: number;
  newEntryCount: number;
  addedFiles: string[];
  droppedFiles: string[];
  cappedAtMax: boolean;
}

export function emitManifestSetGrowth(data: ManifestSetGrowthData): void {
  log("[zone-manifest-set-growth]", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// emitToolResultSize — [zone-tool-result-size]
// Emitted per tool-result push. Also feeds the per-run accumulator so
// emitToolResultSummary can aggregate at run close without rescanning
// responseInput (which is in the inner scoped function's scope).
// ---------------------------------------------------------------------------

export interface ToolResultSizeData {
  runId: string;
  tool: string;
  bytes: number;
  callId: string;
  iter: number;
}

export function emitToolResultSize(opts: ToolResultSizeData): void {
  recordToolResultSize(opts.runId, opts.tool, opts.bytes);
  log("[zone-tool-result-size]", JSON.stringify(opts));
}

// ---------------------------------------------------------------------------
// emitToolResultSummary — [zone-tool-result-summary]
// Emitted once per top-level run in the finally block. Data sourced from
// getAndClearToolResultSummary (clears the accumulator as a side effect).
// ---------------------------------------------------------------------------

export interface ToolResultSummaryData {
  runId: string;
  totalResults: number;
  totalBytes: number;
  perTool: Record<string, { count: number; bytes: number }>;
}

export function emitToolResultSummary(opts: ToolResultSummaryData): void {
  log("[zone-tool-result-summary]", JSON.stringify(opts));
}

// ---------------------------------------------------------------------------
// Re-export IterCostUpdatePayload for callers that spread lastIterCostPayload
// but also need the type without an extra import.
// ---------------------------------------------------------------------------
export type { IterCostUpdatePayload };
