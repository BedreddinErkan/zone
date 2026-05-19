import {
  extractResponsesApiOutputText,
  getModelName,
} from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext, withRequestContext } from "./openaiContext.js";
import { getModelForRole } from "./modelRouting.js";
import { readMemory, formatMemoryForPrompt } from "../memory/projectMemory.js";
import { log, debugLog, errorLog } from "../utils/logger.js";
import { parseVerificationError } from "../core/parseVerificationError.js";
import { sanitizeVerificationEnv, strippedEnvKeys } from "../core/buildEnv.js";
import { buildVerifyDiagnostic } from "../core/buildVerifyDiagnostic.js";
import { maybeExpandScopeForVerifyDiagnostic } from "../tools/scopeGuard.js";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { CHAT_TOOLS, READ_ONLY_TOOLS, ZONE_TOOLS } from "../tools/toolDefinitions.js";
import {
  emptySubagentTokenUsage,
  resetSubagentCallCount,
  type SubagentResult,
  type SubagentTokenUsage,
} from "./subagents.js";
import type { TaskClassification, TaskTier } from "./taskClassifier.js";
import { resolveTierLimits } from "./tierLimits.js";
import { resolveDailyUsdCap } from "./usdCapResolver.js";
import { loadOrgPolicy } from "./policyLoader.js";
import { getUsage, recordRunRetry, recordRunSummary } from "../usage/usageTracker.js";
import { canResumeFromTerminationReason } from "./patchUserFacingReason.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";
import { extractUsage } from "./recordingClient.js";
import {
  buildIterCostUpdate,
  cacheHitRatio,
  emptyIterCostAccumulator,
  type IterCostAccumulator,
  type IterCostUpdatePayload,
} from "../usage/iterCostMeter.js";
import { parseTodoProgressMarkers } from "../core/todoLifecycle.js";
import {
  buildApplyRolledBackMarkerLog,
  buildApplyRolledBackMessage,
  parseTscErrorPreview,
} from "./applyRollbackFeedback.js";
import { validateTodoWriteArgs } from "../tools/todoWriteValidate.js";
import {
  executeTool,
  withStagingTempFlush,
  type ToolResult,
} from "../tools/toolExecutor.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import type { Mode } from "../types/mode.js";
import { ContextCompactor, buildFileReadManifest } from "./compaction/ContextCompactor.js";
import { CompactionExhaustedError, type CompactionResult } from "./compaction/types.js";
import { classifyTurns } from "./compaction/classifyTurns.js";
import { hashToolCall, createDetectorState, recordAndDetect } from "./loopDetector.js";
import { UpstreamUnavailableError } from "./withExponentialBackoff.js";
import { emitTokenBreakdown, emitBreakdownSummary, type BreakdownEvent } from "./tokenBreakdown.js";
import { pruneStaleReads, emitContextPruned } from "./contextPruner.js";

// "plan" kept as accepted input for backward compat — normalizeAgentLoopMode maps it to "patch"
type AgentLoopMode = Exclude<Mode, "auto"> | "investigation" | "plan";

export interface AgentLoopInput {
  task: string;
  repoPath: string;
  mode?: AgentLoopMode;
  runId?: string;
  framework?: ProjectFramework;
  maxIterations?: number; // default: 10
  /**
   * Optional custom max iterations. When set, this is a hard cap: escalation
   * bonus logic is disabled so restricted runtimes stay bounded.
   */
  maxIterationsOverride?: number;
  onProgress?: (msg: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onStructuredEvent?: (evt: unknown) => void;
  /**
   * Phase F1: live tool-input streaming. Fires for each argument fragment
   * emitted by the LLM while generating a write-class tool call (apply_patch,
   * write_file). The first delta for a given blockId has isFirstDelta=true.
   * Anthropic provider only; silently ignored for OpenAI.
   */
  onToolInputStream?: (event: {
    blockId: string;
    toolName: string;
    delta: string;
    isFirstDelta: boolean;
    iter: number;
    /** F1.4: id of the subagent emitting this delta. null/undefined for
     *  parent-agent streams. Worker subagents share the parent's runId so
     *  this is how the UI distinguishes "agent is writing" vs "↳ worker N
     *  is writing" in the side-panel slot. */
    subagentId?: string | null;
  }) => void;
  abortSignal?: AbortSignal;
  /** Optional import-ecosystem context block built by buildImportContextSummary. Injected by runLlmPatchFlow. */
  importContextSummary?: string;
  /**
   * J.5: prior run's final summary, threaded in by runLlmPatchFlow when
   * the conversation has an `agent_summary` event from a recent rollback.
   * Capped + marker-preserving truncation is applied at the load site
   * (extractPriorRunSummary). When non-empty, the agent loop injects a
   * "PRIOR RUN CONTEXT" framing block above the user task so the agent
   * reads APPLY_ROLLED_BACK markers from previous attempts before
   * re-investigating. Empty / undefined → no-op (parent of all existing
   * agentLoop callsites is unchanged).
   */
  priorRunSummary?: string;
  /**
   * BYOK: user-supplied LLM API key (sent from the browser via X-Zone-LLM-Key header).
   * Takes priority over process.env.OPENAI_API_KEY when present.
   * Never logged â€” only the source ("user" vs "env") is logged.
   */
  userApiKey?: string;
  /** Tur P2-scope: when present, write tools reject paths outside the
   *  union of plan.steps[*].filesLikely. Forwarded into executeTool. */
  executionPlan?: import("./executionPlan.js").ExecutionPlan | null;
  /** agent-persistence Tur: full repo file list, used by buildVerifyDiagnostic
   *  to surface candidate culprits when a build/test failure points to a
   *  framework-generated path. Optional — when missing, the diagnostic still
   *  fires but with no candidate list. */
  repoFilePaths?: string[];
  /** Usage-tracker Tur: who to attribute this run's BYOK token spend to.
   *  Defaults to "local-dev" when missing. Plumbed through runLlmPatchFlow. */
  userId?: string;
  /**
   * Optional tool whitelist. If provided, only tools whose name appears in this
   * set are exposed to the LLM and accepted by the executor. If undefined,
   * defaults to the full ZONE_TOOLS set.
   */
  allowedTools?: ReadonlySet<string>;
  /** Suppress TodoWrite's sidebar meta-tool path for read-only modes. */
  disableTodoWrite?: boolean;
  /**
   * Optional subagent metadata reserved for the Task tool follow-up. Setting
   * this does not change behavior beyond allowedTools enforcement.
   */
  subagent?: {
    id: string;
    type: "worker" | "explore" | "verifier";
    parentRunId: string;
  };
  /**
   * Shared staging map owned by a parent agent loop. Subagents write into this
   * map so the top-level parent keeps exclusive flush/discard authority.
   */
  parentStagingFiles?: Map<string, string>;
  /** Parent cumulative budget at subagent dispatch. Subagent loops add their
   *  own per-iteration tokens to this base so Phase H.7 is enforced while
   *  delegated work is still running. */
  tokenBudgetBaseTokens?: number;
  /** L.2: task classification from pre-dispatch classifier. Used to resolve
   *  tier-based tool exposure and budget caps. Absent for subagent loops. */
  taskClassification?: TaskClassification | null;
  /** L.4.1: per-request tier override from API caller (beats ZONE_FORCE_TIER env). */
  forceTier?: TaskTier;
  /**
   * Phase X.0 C3: conversation/thread ID from the HTTP session. When provided,
   * used as the OpenAI prompt_cache_key prefix instead of runId so successive
   * runs in the same thread share a stable cache key and get cache hits
   * rather than misses on every new runId.
   */
  conversationId?: string;
  /** Phase O: lane identifier forwarded from the audit caller so telemetry and
   *  UI can distinguish the scope audit mini-agent from the main patch agent.
   *  "audit" = investigateScope(); "main" or absent = primary agent loop.
   */
  lane?: "main" | "audit";
  /**
   * Phase X.0.1: distilled findings from the pre-execution scope audit.
   * When present, injected as an AUDIT CONTEXT block in the user message
   * so the execute agent skips re-investigating ground the audit covered.
   * Feature-gated: undefined when no audit ran (simple tasks, audit disabled).
   */
  auditFindings?: {
    summary: string;
    citationCount: number;
    toolCallCount: number;
    costUsd: number;
    // Step B: structured fields for richer AUDIT CONTEXT render
    scopeVerdict?: "under_scope" | "over_scope" | "mixed" | "none";
    severity?: "none" | "minor" | "major";
    citations?: Array<{ file: string; line?: number }>;
    filesAlreadyRead?: string[];
    // Step C: structured Phase 1 output fields
    rootCause?: string;
    fixInstruction?: string;
    filesToEdit?: string[];
    evidence?: string;
  };
}

export type VerificationReason =
  | 'tests_passed'
  | 'tests_skipped_no_infra'
  | 'tests_inconclusive'
  | 'tests_failed_unrelated'
  | 'tests_failed_by_patch'
  | 'no_verification_attempted'
  | 'verification_failed_staged'
  // Phase J.3: distinguishes "patch introduced new errors" (rolled_back UI)
  // from "patch had pre-existing errors but didn't regress them" (apply OK).
  | 'verification_regressed'
  // Phase F.2: warn-mode regression — patches flushed to disk, errors surfaced
  // as warnings. Distinct from 'verification_regressed' (rollback) so that
  // downstream isVerificationRegressed strict-equals check does NOT trigger
  // decisionMode='rolled_back' UI banner.
  | 'verification_warnings'
  | 'no_changes_made';

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  toolCallLog: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  filesModified: string[];
  error?: string;
  patchValidatedByAgent: boolean;
  verificationReason: VerificationReason;
  /** Phase H.7: how the loop ended. Used by upstream flows (investigation /
   *  patch) to surface "Token budget reached" vs "Iteration budget reached"
   *  distinctly in the UI. Optional for backward-compat with older callers. */
  terminationReason?: "natural_completion" | "max_iterations" | "token_budget_exceeded" | "compaction_exhausted" | "loop_detected" | "daily_usd_cap_exceeded" | "upstream_unavailable" | "phase1_handoff";
  /** Phase Q.2: populated when terminationReason === "loop_detected". The
   *  offending tool name + observed count in the sliding-window detector. */
  loopDetected?: { toolName: string; count: number };
  /** Per-loop LLM token usage. For subagent loops this is serialized into the
   *  Task tool result so the parent can enforce the combined Phase H.7 cap. */
  tokenUsage?: SubagentTokenUsage;
  /** Phase K.6: cumulative LLM cost (USD) for this agent loop's own calls.
   *  Serialized into Task tool result so parent can propagate to cumulativeCost. */
  costUsd?: number;
  /** Phase J.3.1: staging snapshot captured before rollback discarded it.
   *  Only populated when verificationReason === "verification_regressed".
   *  Keyed by absolute path; values are the content the agent attempted to
   *  write. runLlmPatchFlow uses this together with the pre-write
   *  beforeByFile snapshot to render a "what was attempted" diff card. */
  discardedStaging?: Map<string, string>;
}

const MAX_SELF_CORRECTION_ATTEMPTS = 5;
// agent-loop-stability Tur: bumped 10 → 15. Build-failure investigations need
// more headroom than test-failure ones — first iter for the build, second to
// read the failing file, third to apply the fix, fourth to re-verify; multiply
// for two-bug scenarios. Existing escalation bonus still adds 5 on top for
// apply_patch repeat-failure (max 20).
export const BASE_MAX_ITERATIONS = 15;
export const ESCALATION_BONUS_ITERATIONS = 5;

// Phase H.7: per-run token budget. ~$0.50/run for typical Claude pricing,
// leaves ~200k context tampon vs 1M. WARN drives UI cost-strip yellow at 80%;
// HARD triggers graceful exit at 95% — agent gets one final synthesis call
// (no tools) and the run returns terminationReason="token_budget_exceeded".
export const TOKEN_BUDGET_CAP = 800_000;
export const TOKEN_BUDGET_WARN = 0.8;
export const TOKEN_BUDGET_HARD = 0.95;
export const TOKEN_BUDGET_MID_WARN = 0.70;

function cleanTokenNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function extractTokenUsageForBudget(rawUsage: unknown): Omit<SubagentTokenUsage, "perIter"> {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { input: 0, output: 0, cached: 0, total: 0 };
  }
  const usage = rawUsage as Record<string, unknown>;
  const promptTokenDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;
  const input = cleanTokenNumber(usage.prompt_tokens ?? usage.input_tokens);
  const output = cleanTokenNumber(usage.completion_tokens ?? usage.output_tokens);
  const cached = cleanTokenNumber(
    promptTokenDetails?.cached_tokens ?? usage.cache_read_input_tokens
  );
  return {
    input,
    output,
    cached,
    total: input + output,
  };
}

function getZoneToolName(tool: (typeof ZONE_TOOLS)[number]): string {
  return (
    (tool as { function?: { name?: string }; name?: string }).function?.name ??
    (tool as { name?: string }).name ??
    ""
  );
}

function getToolSortName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const t = tool as { function?: { name?: unknown }; name?: unknown };
  return typeof t.function?.name === "string"
    ? t.function.name
    : typeof t.name === "string"
      ? t.name
      : "";
}

export function sortToolsForPromptCache<T>(tools: readonly T[]): T[] {
  return Array.from(tools).sort((a, b) =>
    getToolSortName(a).localeCompare(getToolSortName(b))
  );
}

export function buildOpenAIPromptCacheKey(
  runId: string | undefined,
  conversationId?: string | undefined
): string | undefined {
  const threadId = typeof conversationId === "string" ? conversationId.trim() : "";
  const normalized = threadId || (typeof runId === "string" ? runId.trim() : "");
  if (!normalized) return undefined;
  const prefix = threadId ? "zone-thread" : "zone-run";
  return `${prefix}-${normalized.slice(0, 16)}`.slice(0, 64);
}

/** Step B: stable module-level directive for Phase 2 when AUDIT CONTEXT is present.
 *  No ${...} interpolation — per-run data lives in the user-message AUDIT CONTEXT block. */
const TRUST_PHASE1_DIRECTIVE =
  `=== AUDIT CONTEXT IS AUTHORITATIVE ===\n` +
  `A prior investigation phase analyzed this task and produced the AUDIT CONTEXT block in the user message. Its findings — verdict, severity, cited files, files-already-investigated, and summary — are authoritative.\n\n` +
  `Execute the implied fix. Do not re-read files listed under "Files already investigated" unless your direct observations contradict the audit's evidence. One targeted read_file for verification is allowed; broad search_in_files or find_references over the same surface is wasted work and counts against your iteration budget.\n\n` +
  `If the AUDIT CONTEXT block is empty or internally contradictory, fall back to standard investigation. Otherwise trust it.\n` +
  `=== END AUDIT CONTEXT GUIDANCE ===`;

export function assembleAgentSystemPrompt(input: {
  agentIntro: string;
  frameworkLines: string[];
  hasFramework: boolean;
  projectMemoryBlock: string;
  importContextSummary?: string;
  baseMaxIterations: number;
  canRunCommand: boolean;
  backgroundCommandBlock: string;
  repoPath: string;
  planProgressBlock?: string;
  planAnnotationsBlock?: string;
  /** Step B: when set, appends TRUST_PHASE1_DIRECTIVE before the repo path line. */
  auditFindings?: unknown;
}): string {
  return (
    `${input.agentIntro}\n\n` +
    (input.hasFramework ? `${input.frameworkLines.join("\n")}\n\n` : "") +
    (input.projectMemoryBlock ? `${input.projectMemoryBlock}\n\n` : "") +
    (input.importContextSummary
      ? `RELATED FILES (read-only context for planning — call read_file for full content):\n` +
        input.importContextSummary + `\n` +
        `(End related files context)\n\n`
      : "") +
    (input.planProgressBlock ? `${input.planProgressBlock}\n\n` : "") +
    (input.planAnnotationsBlock ? `${input.planAnnotationsBlock}\n\n` : "") +
    `PATCH RULES:\n` +
    `- apply_patch for EXISTING files; write_file ONLY for new files.\n` +
    `- FIND: copy verbatim from read_file output, 1-5 lines, unique in the file.\n` +
    `- REPLACE: one local substitution of FIND. Never copy in code from elsewhere in the file — use a second block instead.\n` +
    `- intent='add' (default, REPLACE = FIND + additions), 'modify' (REPLACE = edited FIND), 'delete' (REPLACE shorter than FIND, may be empty).\n` +
    `- MINIMUM CHANGE: preserve every existing line the user didn't ask to change.\n` +
    `- scope: OMIT by default. Only set when FIND occurs multiple times AND the target is inside a NAMED function/class. Never for arrow-const, default exports, or React components.\n` +
    `- After a successful apply_patch, do NOT re-read the same file — the patch is already written.\n\n` +
    `PRE-EXISTING BROKEN FILE — when apply_patch returns rejectionReason 'file_already_broken_pre_patch':\n` +
    `The file had a syntax error before your patch. Read it, locate the line/col in the rejection, then write ONE apply_patch that fixes the pre-existing error AND makes your change (pass scope: null — scope resolution cannot work on an unparseable file).\n\n` +
    `APPLY_ROLLED_BACK — when apply_patch returns a result beginning with "APPLY_ROLLED_BACK":\n` +
    `- Patch reverted — disk is at pre-apply state for paths listed under "Files restored to pre-apply state".\n` +
    `- Read the error list. "Suggested: " lines are hints for coordinated multi-file edits.\n` +
    `- Do NOT use shell commands to bypass. Re-investigate, then retry with apply_patch or Task (≥3-file edits).\n\n` +
    `VERIFICATION WARNINGS — when a run summary contains a "VERIFICATION WARNINGS" block:\n` +
    `- Your patches are on disk. The verifier found new errors your changes introduced.\n` +
    `- Options: (a) read error locations and patch to fix; (b) call revert_patch({path}) to undo specific files; (c) accept if errors are pre-existing or out-of-scope.\n` +
    `- revert_patch({path: "<rel-path>"}) restores a file to its pre-run state without deleting other changes.\n\n` +
    `PRIOR RUN CONTEXT — if the user message begins with "PRIOR RUN CONTEXT — your last attempt in this thread produced this result:":\n` +
    `- This thread had a previous run; its final summary is between that header and "END PRIOR RUN CONTEXT.".\n` +
    `- If the block contains APPLY_ROLLED_BACK or VERIFICATION WARNINGS, start from those errors — re-investigate from those specific locations.\n` +
    `- If the block contains "Suggested: ", apply that direction (coordinated multi-file edit via Task).\n` +
    `- The user's current task follows END PRIOR RUN CONTEXT — combine: prior context = WHERE the problem is.\n\n` +
    `TEST FAILURES — investigate, don't summarize:\n` +
    `- Read the file/line in the error. Decide: caused by your change, or pre-existing?\n` +
    `- Pre-existing: fix if simple, else note as out-of-scope in your final summary.\n` +
    `- Your mistake: fix with apply_patch (intent='modify' or 'delete'), re-run tests.\n` +
    `- Only give up after a self-correction attempt.\n\n` +
    `Operate efficiently — the cost ceiling terminates the run; avoid redundant reads and retries.\n\n` +
    `TASK SUBAGENTS (Task) — when to dispatch:\n` +
    `Default is single-thread. Hard cap: 2 dispatches per parent run (MAX_SUBAGENT_CALLS=2, WORKER_MAX_ITER=6). Each dispatch costs ~30K-100K tokens.\n` +
    `GOOD signals (DO dispatch):\n` +
    `- Current plan step is marked \`subagentEligible: true\` (consult the plan-annotations block above when present).\n` +
    `- Same transformation across 5+ files (multi_file_fanout): rename, codemod. Worker.\n` +
    `- Pure read-only investigation across the repo (exploration): "map all callers of X". Explore.\n` +
    `- A single step that would otherwise consume 10+ parent iterations (long_isolated_step).\n` +
    `- Verifier rolled back your patch AND you have spent ≥2 iterations on the rollback recovery AND the diagnosis requires reading 3+ files outside your patched scope (e.g., tsconfig + vitest config + jest setup; module resolution config + package.json + lockfile; build pipeline + bundler config): dispatch ONE explore subagent with a narrow question scoped to the environment investigation. Worker returns scoped findings; you apply them without burning your iter budget on environment archaeology (focused_diagnosis).\n` +
    `BAD signals (DON'T dispatch): 1-2 file edits, shared mutation state, uncertain scope, patch-then-verify cycles.\n` +
    `DISPATCH REASON (required): prefix description with "multi_file_fanout: ...", "exploration: ...", "long_isolated_step: ...", or "focused_diagnosis: ...". Example: Task({ subagent_type: "worker", description: "multi_file_fanout: rename foo→bar across src/api/handlers/* (8 files)" }).\n\n` +
    `NARRATION: before each tool call, write one short sentence in plain English describing what you're about to do and why. ` +
    `Examples: "Reading the README to find the existing structure.", "Patching package.json to add the dev dependency.", "Searching for callers of the renamed function." ` +
    `One line, no bullets, no markdown headers, no emoji. Shown as live narration. Don't repeat in the final summary.\n\n` +
    `SEARCH FIRST: for symbol/pattern queries (find a function call, find usages, locate a definition), use search_in_files BEFORE read_file. search_in_files now supports regex, output_mode, and context_lines. Reading entire files to find a single symbol is the most common wasteful pattern.\n\n` +
    `READ_FILE ECONOMY: ≤10K chars returns full content (no line-number prefix — safe to copy into FIND). >10K returns numbered head (lines 1-100) + outline + numbered tail — use lineRange: [start, end] (1-indexed inclusive) to read the specific region before patching. When you receive a FILE OUTLINE (file too large for full read), your next action MUST be read_file with lineRange covering the symbol or region you need — the outline alone is insufficient context for editing.\n\n` +
    `INTERPRETING COMMAND OUTPUT: every run_command result starts with [exit_code=N — ...]. exit_code=0 ⇒ success — DO NOT retry based on output text (e.g. "Tests: N failed" may be pre-existing failures unrelated to your patch). exit_code≠0 ⇒ failure — read the tail for the reason. When verifying your own patch, focus only on tests that cover files you modified. If a command exited 0, do not run additional commands to verify or investigate its output. Trust the exit code as final and move on.\n\n` +
    `VERIFIER SHELL DISCIPLINE — pipe exit code semantics:\n` +
    `Some shell patterns produce non-zero exit codes that are NOT real failures:\n` +
    `1. \`grep PATTERN | wc -l\` — grep returns exit 1 when no matches found; the pipeline exits 1 even though wc -l succeeded with count "0".\n` +
    `2. \`grep -c PATTERN\` — returns count directly without piping; exits 1 if no match, BUT the count is in stdout regardless.\n\n` +
    `DEFENSIVE PATTERNS for counting:\n` +
    `✓ \`command 2>&1 | grep -c " FAIL" || echo 0\` — grep -c returns count; \`|| echo 0\` swallows the 1-exit when no match.\n` +
    `✓ Separate verification — run target test directly first to confirm pass, then check full suite for regression count. Do NOT conflate the two.\n` +
    `✗ Avoid: \`grep " FAIL" | wc -l\` — pipe will return 1 on grep no-match.\n\n` +
    `PRIORITY RULE: If \`npx vitest run path/to/target.test.ts\` returned exit 0, your fix is verified. A downstream pipe noise (regression count) is secondary — do NOT retry the fix based on pipe noise.\n\n` +
    `Few-shot examples:\n` +
    `[Example A — target passes, regression count noise (pipe noise scenario)]\n` +
    `[shell] npx vitest run src/billing/conversationRepository.test.ts 2>&1 → exitCode=0\n` +
    `[agent] Target test passed. Check regression count defensively.\n` +
    `[shell] npx vitest run 2>&1 | grep -c " FAIL" || echo 0 → 59\n` +
    `[agent] 62 → 59, baseline improved. Fix verified, no retry needed.\n\n` +
    `[Example B — real test failure, not pipe noise]\n` +
    `[shell] npx vitest run path/to/changed.test.ts 2>&1 → exitCode=1, "Tests 2 failed | 3 passed"\n` +
    `[agent] Real failure in target. Inspect output for cause, then retry the fix.\n\n` +
    `FINAL SUMMARY (required — write this as your last response):\n` +
    `Structure your final response as exactly four sections in this order. Do not add any other headings.\n\n` +
    `## What changed\n` +
    `One bullet per logical change (max 120 chars each). Reference files with inline backticks, e.g. \`src/foo.ts\`. Write "(none)" if no patches were applied.\n\n` +
    `## Why\n` +
    `One or two sentences. Explain the user-visible behavior, bug, or goal the change addresses. Do not restate the task verbatim.\n\n` +
    `## Tests\n` +
    `One line using exactly one of: tests_passed, tests_failed_unrelated, tests_failed_by_patch, tests_inconclusive, tests_skipped_no_infra, not_run. Include the command when tests ran, e.g. "tests_passed (npm test -- foo)".\n\n` +
    `## Notes\n` +
    `Optional. Include only when there is a remaining warning, an out-of-scope item, or a concrete follow-up. Omit the heading entirely when empty.\n\n` +
    `FORBIDDEN in the summary:\n` +
    `- Triple-backtick code fences or diffs — the UI already shows the diff cards above your summary\n` +
    `- File contents, patches, or FIND/REPLACE blocks\n` +
    `- Filler phrases like "I have successfully completed..." or "In conclusion..."\n` +
    `- Extra headings beyond the four above\n` +
    `- Tables or decorative markdown\n` +
    `Token budget: 150-300 tokens; hard cap 900 characters.\n\n` +
    `EXAMPLES:\n\n` +
    `[Example 1 — natural_completion]\n` +
    `## What changed\n` +
    `- Added \`omit<T, K>\` utility to \`src/utils/omit.ts\` with type-safe key removal\n` +
    `- Updated barrel export in \`src/utils/index.ts\`\n\n` +
    `## Why\n` +
    `Completes the symmetry with the existing \`pick\` utility; both share the same generic signature pattern.\n\n` +
    `## Tests\n` +
    `tests_passed (npm test -- omit, 4 scenarios)\n\n` +
    `[Example 2 — max_iterations]\n` +
    `## What changed\n` +
    `- Added \`group\` and \`pluck\` utilities to \`src/utils/collections.ts\`\n` +
    `- Tests added but barrel export update not completed\n\n` +
    `## Why\n` +
    `Plan called for both utilities plus barrel update and call-site refactor; iteration limit hit before all steps finished.\n\n` +
    `## Tests\n` +
    `not_run (iteration cap reached before verification step)\n\n` +
    `## Notes\n` +
    `Plan step "Update src/utils/index.ts barrel" did not complete. Hand-off to a follow-up run recommended.\n\n` +
    `[Example 3 — APPLY_ROLLED_BACK]\n` +
    `## What changed\n` +
    `- Attempted to refactor \`src/auth/session.ts\` to use the new TokenProvider interface\n\n` +
    `## Why\n` +
    `Switching session storage from cookie to header would unblock the upcoming SSO work.\n\n` +
    `## Tests\n` +
    `tests_failed_by_patch (tsc: TS2305 — module './tokenProvider' has no exported member 'TokenProvider')\n\n` +
    `## Notes\n` +
    `APPLY_ROLLED_BACK. The TokenProvider type must be defined in a prior run before this refactor can land.\n\n` +
    `ELIDED READS: tool_result blocks marked "[Earlier read: ...]" had their content removed to save context. Call read_file again if you need it.\n\n` +
    `TRUNCATED FILE SECTIONS: if you see a ZONE_CONTEXT_TRUNCATED marker, part of the file was omitted. Do NOT include the marker line in any apply_patch FIND block; use read_file with lineRange on the same path to fetch the hidden section. Only generate FIND blocks from lines you have fully read.\n\n` +
    `FINAL ASSESSMENT (required) — include exactly one tag on its own line in your final response:\n` +
    `  [ZONE_VERIFICATION: tests_passed]           — suite ran, all passed\n` +
    `  [ZONE_VERIFICATION: tests_skipped_no_infra] — no test script/framework found\n` +
    `  [ZONE_VERIFICATION: tests_inconclusive]     — environment/infra issue prevented tests (missing script, command not found, ENOENT, port conflict); patch likely correct\n` +
    `  [ZONE_VERIFICATION: tests_failed_unrelated] — tests failed but failure is pre-existing\n` +
    `  [ZONE_VERIFICATION: tests_failed_by_patch]  — tests failed because of your patch (you MUST attempt to fix before marking complete)\n\n` +
    (input.hasFramework && input.canRunCommand
      ? `When running commands, use the correct package manager and commands above.\n`
      : "") +
    input.backgroundCommandBlock +
    (input.auditFindings ? `${TRUST_PHASE1_DIRECTIVE}\n\n` : "") +
    `Repository path: ${input.repoPath}`
  );
}

function normalizeAgentLoopMode(mode: AgentLoopInput["mode"]): Exclude<Mode, "auto"> {
  if (mode === "chat" || mode === "investigate" || mode === "patch") {
    return mode;
  }
  if (mode === "investigation") return "investigate";
  if (mode === "plan") return "patch";
  return "patch";
}


function modeDefaultAllowedTools(mode: Exclude<Mode, "auto">): ReadonlySet<string> | undefined {
  if (mode === "chat") return new Set(CHAT_TOOLS);
  if (mode === "investigate") return new Set(READ_ONLY_TOOLS);
  return undefined;
}

function assembleChatSystemPrompt(input: {
  repoPath: string;
  projectMemoryBlock: string;
  baseMaxIterations: number;
}): string {
  return [
    "You are Zone, answering conversationally about the user's codebase.",
    "",
    "Rules:",
    "- Do not modify files.",
    "- Do not run shell commands.",
    "- Use read_file and list_files only when code context is needed.",
    "- If the user asks for an edit, tell them to switch to patch mode.",
    "- Be concise, but include file references when they help.",
    "",
    `Repo path: ${input.repoPath}`,
    input.projectMemoryBlock,
    "",
    `You may use up to ${input.baseMaxIterations} iterations, but stop as soon as you can answer well.`,
    `FINAL SUMMARY: End with a brief 2-3 sentence prose summary of your answer. No code blocks (unless a snippet clarifies the point), no section headers.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// Phase G: Phase 1 runtime-grounding heuristic — appended after INVESTIGATION_OUTPUT_FORMAT.
// Module-level const: no per-run interpolation, cache-safe.
const PHASE1_RUNTIME_HEURISTIC = `INVESTIGATION HEURISTIC — RUNTIME GROUNDING:

When the task mentions failing tests, build errors, runtime exceptions, or \
"why is X broken", your FIRST action should be to reproduce the failure using \
run_command_readonly. Examples:

- "Fix failing tests in foo.test.ts" → \`npx vitest run path/to/foo.test.ts\` \
first, read actual error output, THEN form hypothesis.
- "Build fails after refactor" → \`tsc --noEmit\` first.
- "Test crashes intermittently" → run multiple times, observe pattern.

Static code analysis without runtime observation produces non-deterministic \
diagnoses. Your fixInstruction must be grounded in the actual error message, \
not in what the code "should" be doing.

If the task does not involve runtime behavior (e.g., "rename function X across \
the codebase"), skip the runtime step and proceed with reads + searches.`;

// Step C Lever A: module-level const — no per-run interpolation, cache-safe.
const INVESTIGATION_OUTPUT_FORMAT = `At the end of your investigation, output a JSON block fenced with \`\`\`json containing exactly these fields:
{
  "rootCause": "<one sentence — root cause or key gap this task must address>",
  "fixInstruction": "<one actionable verb phrase for the execute agent — what to do. If you cannot produce a concrete fix instruction within the iteration budget, write 'investigate further: <specific topic>' and set complete to false.>",
  "filesToEdit": ["<file path>"],
  "evidence": "<key file:line citations that support the above>",
  "complete": true | false
}

Set \`complete: true\` only when \`fixInstruction\` is a paste-ready imperative.
Set \`complete: false\` (and use the 'investigate further' instruction) when evidence is insufficient — Phase 2 will then decide whether to continue investigation or surface the partial finding to the user.

The JSON block must be the LAST item in your response, after the prose summary. ANY iteration may be your last — if you are at the iteration budget, emit the JSON now even if complete=false.`;

export function assembleInvestigationSystemPrompt(input: {
  repoPath: string;
  projectMemoryBlock: string;
  baseMaxIterations: number;
  /** X.0.1: when provided, used as the first line so audit and execute runs
   *  share a common system-prompt prefix and hit the Anthropic content-addressed
   *  cache across phase transitions. Without it, the hardcoded investigation
   *  intro is used (backward-compat for call sites that don't supply it). */
  agentIntro?: string;
}): string {
  const openingLines = input.agentIntro
    ? [
        input.agentIntro,
        "INVESTIGATION mode — read-only tools only.",
      ]
    : [
        "You are Zone, answering a question about the codebase in INVESTIGATION mode. Read-only tools only.",
      ];
  return [
    ...openingLines,
    "",
    "Be proactive in a single pass: search → read 2-3 top hits → synthesize complete answer.",
    "Do not rely on intuition when the repository can be searched.",
    "",
    "Tools available:",
    "- read_file: ≤10K chars returns full content; >10K returns head 100 lines + file outline + tail 50 lines. Use lineRange to read exact sections from outline hits.",
    "- list_files",
    "- search_in_files",
    "- find_references",
    "- run_command_readonly: run failing tests, typecheck, lint, or read-only git inspection. Whitelisted commands only (e.g. 'npx vitest run path/to/test.ts', 'tsc --noEmit', 'git diff'). Output truncated to head 100 + tail 50 lines. Blocked: mutations, network writes, package installs, shell substitution.",
    "",
    "SEARCH FIRST: Use search_in_files to locate symbols before reading files. Reading an entire file for a single symbol wastes iterations.",
    "",
    "Process:",
    "1. Identify what the question asks: definition, usages, control flow, data shape, or design rationale.",
    "2. Search for relevant terms with search_in_files. Prefer source globs such as `src/**/*.ts`, `src/**/*.py`, or `src/**/*.{ts,tsx,js,jsx}` before broad `**/*` searches.",
    "3. Read 2-3 top hits with read_file. Read related context files when imports or callers matter.",
    "4. If the question is about usages of an identifier, use find_references when you know the exporting source file, and read each relevant call site briefly.",
    "5. Ignore logs, build output, dependency folders, and generated artifacts unless the user specifically asks about them.",
    "6. If the search results show a short list of source call-site files, read each source file before answering.",
    "7. Synthesize from the explored files only. If evidence is incomplete, say what was and was not checked.",
    "",
    "Final answer:",
    "- Write clear markdown.",
    "- Include file paths in backticks, with line numbers where helpful, for example `src/foo.ts:42` or `src/foo.py:42`.",
    "- Aim for ≥3 distinct file citations when the symbol is non-trivial; if only 1-2 references exist, state that explicitly.",
    "- Use code blocks for short snippets only when they clarify the answer.",
    "",
    "Do NOT end with offers to continue ('shall I dig deeper?', 'would you like me to explore further?', etc.) — the user already asked the question. Deliver the full answer now.",
    "FINAL SUMMARY: End with a brief 2-3 sentence prose summary of your findings. No code blocks, no markdown section headers beyond what the answer requires.",
    "Do not write or modify code. Do not call run_command (full shell). Do not call TodoWrite. Do not produce patches.",
    `Maximum iterations: ${input.baseMaxIterations} (already enforced; be targeted).`,
    `Repository path: ${input.repoPath}`,
    ...(input.projectMemoryBlock ? ["", input.projectMemoryBlock] : []),
    "",
    INVESTIGATION_OUTPUT_FORMAT,
    "",
    PHASE1_RUNTIME_HEURISTIC,
  ].join("\n");
}

// K.4: exported so tests can assert prompt content without running the full loop.
export function buildWorkerAgentIntro(): string {
  return (
    `You are a Worker subagent in Zone. You have been delegated a single,\n` +
    `specific subtask by a parent agent. Your job is to complete this subtask\n` +
    `efficiently and return a structured summary.\n\n` +
    `Constraints:\n` +
    `- You have a restricted tool set. Only use the tools available to you.\n` +
    `- You CANNOT delegate further (no nested subagents).\n` +
    `- You CANNOT update project memory or run shell commands.\n` +
    `- Stay focused on the delegated subtask. Do not expand scope.\n` +
    `- Iteration budget is limited (6 iterations). Be decisive.\n\n` +
    `TASK TOOL FORBIDDEN\n` +
    `You are a SUBAGENT. You CANNOT dispatch other subagents via the Task tool.\n` +
    `Task tool is BLOCKED in your context (defensive: even if visible, do not call).\n` +
    `Complete your assigned scope with the tools available to you.\n` +
    `If your scope is too large, return early with a partial summary — the parent agent\n` +
    `will decide whether to dispatch additional subagents.\n` +
    `Recursive subagent dispatch is NEVER appropriate.\n\n` +
    `When the subtask is done (or you determine it cannot be completed), respond\n` +
    `with the following structured summary as your final message — and nothing else:\n\n` +
    `SUMMARY: <one short paragraph, 2-4 sentences>\n` +
    `FILES_MODIFIED: <comma-separated relative paths, or "none">\n` +
    `STATUS: <success | failed | partial>\n` +
    `NOTES: <optional; one sentence only if there are caveats>\n\n` +
    `Do not include any other text after the structured summary block.`
  );
}

export function buildExploreAgentIntro(): string {
  return (
    `You are an EXPLORE subagent in Zone. Your job is to INVESTIGATE and REPORT — not to make changes.\n\n` +
    `You have been given a read-only investigation task by a parent agent. Find the relevant code,\n` +
    `understand it, and return a compact findings summary so the parent can act on it without\n` +
    `reading every file themselves.\n\n` +
    `Constraints:\n` +
    `- READ-ONLY. You have access to read_file, list_files, search_in_files, find_references only.\n` +
    `- You CANNOT modify files, run commands, delegate further, or update memory.\n` +
    `- Keep findings concise: file:line + one-sentence note per entry. Do NOT dump raw file contents.\n` +
    `- Iteration budget is limited (15 iterations). Be targeted — search first, read selectively.\n` +
    `- If the task requires modifications, return STATUS: failed with an explanation in SUMMARY.\n\n` +
    `TASK TOOL FORBIDDEN\n` +
    `You are a SUBAGENT. You CANNOT dispatch other subagents via the Task tool.\n` +
    `Task tool is BLOCKED in your context (defensive: even if visible, do not call).\n` +
    `Complete your assigned scope with read_file, search_in_files, list_files, find_references.\n` +
    `If your scope is too large, return early with a partial summary — the parent agent\n` +
    `will decide whether to dispatch additional subagents.\n` +
    `Recursive subagent dispatch is NEVER appropriate.\n\n` +
    `When you have finished investigating, respond with the following structured block as your\n` +
    `final message — and nothing else:\n\n` +
    `FINDINGS:\n` +
    `- <path>:<line> — <one-sentence relevance note>\n` +
    `- <path>:<line> — <one-sentence relevance note>\n` +
    `(repeat for each finding; omit line number if not applicable)\n\n` +
    `SUMMARY: <2-4 sentences explaining what you found and why it matters>\n` +
    `STATUS: <completed | partial | failed>`
  );
}

export type IterationBudgetState = {
  maxIterationsForRun: number;
  escalationBonusGranted: boolean;
};

export function maybeGrantEscalationBonus(
  state: IterationBudgetState,
  escalatedFileCount: number,
  currentIter: number,
  onProgress: ((msg: string) => void) | undefined,
  baseMaxIterations = BASE_MAX_ITERATIONS
): IterationBudgetState {
  if (state.escalationBonusGranted || escalatedFileCount <= 0) {
    return state;
  }

  const nextState = {
    maxIterationsForRun: baseMaxIterations + ESCALATION_BONUS_ITERATIONS,
    escalationBonusGranted: true,
  };
  onProgress?.(JSON.stringify({
    event: "zone-agent-escalation-bonus-granted",
    newMaxIterations: nextState.maxIterationsForRun,
    escalatedFileCount,
    currentIter,
  }));
  return nextState;
}

function normalizePatchedPath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").trim();
}

// â"€â"€â"€ Self-correction routing (Phase Tier-2) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

export type SelfCorrectTrigger =
  | "test_failed"
  | "apply_patch_find_not_found"
  | "apply_patch_multiple_matches"
  | "apply_patch_semantic_smell"
  | "apply_patch_syntax_broken_post_write"
  | "apply_patch_repeated_failure_same_file"
  | "apply_patch_pre_existing_broken"
  | "apply_patch_scope_not_found"
  | "apply_patch_replace_shorter_than_find"
  | "apply_patch_find_block_empty"
  | "apply_patch_marker_imbalance"
  | "apply_patch_no_read_first"
  | "tool_command_spawn_failure"
  | "tool_path_enoent"
  | "unknown";

const SYNTAX_BROKEN_POST_WRITE_COACHING_PROMPT =
  `Your last apply_patch was applied but it BROKE the file's syntax (parse error reported). The file has been reverted to its pre-patch state.\n\n` +
  `Do NOT submit the same REPLACE block again. The previous REPLACE almost certainly had one of these defects:\n` +
  `- Mismatched braces, parentheses, or brackets\n` +
  `- Missing semicolons, commas, or closing tags\n` +
  `- A truncated function body (you started a block but didn't finish it)\n` +
  `- A REPLACE block that omitted necessary trailing characters from FIND\n\n` +
  `REQUIRED steps before retrying:\n` +
  `1. Call read_file on the target file FIRST. The file has been reverted - re-read it.\n` +
  `2. Manually count braces/parens in your planned REPLACE block before submitting.\n` +
  `3. If your previous REPLACE was the entire function body, consider patching ONLY the changed line(s) instead of rewriting the whole body.\n\n` +
  `Next action: call read_file on the broken file, then produce a corrected apply_patch with a verified syntactically valid REPLACE block (different from the last one).`;

const PRE_EXISTING_BROKEN_COACHING_PROMPT =
  `The file you tried to patch is ALREADY syntactically broken at the reported line - this breakage existed BEFORE your patch. Your patch was rejected because patching a syntactically invalid file is unsafe.\n\n` +
  `Do NOT retry the same patch. The pre-existing breakage must be repaired in the SAME apply_patch as your feature change. A second apply_patch attempt with the same FIND/REPLACE will be rejected for the same reason.\n\n` +
  `REQUIRED steps before retrying:\n` +
  `1. Call read_file on the target file FIRST.\n` +
  `2. Locate the breakage near the reported line number (look 5-10 lines above and below for missing braces, broken JSX, partial function declarations, etc.).\n` +
  `3. Construct ONE apply_patch whose FIND block is large enough to cover BOTH the breakage region AND the area you originally wanted to change, and whose REPLACE block fixes both.\n\n` +
  `Next action: read the file, then submit one combined repair-plus-feature apply_patch.`;

// Provider-agnostic hardening: appended to test_failed and
// apply_patch_syntax_broken_post_write coaching to block three failure modes
// observed in OpenAI gpt-4o smoke runs (run bddcd8d3):
//   1. Comment-out as fix (line preserved with "// " prefix)
//   2. Duplicate imports/declarations in REPLACE blocks
//   3. "Pre-existing/unrelated" verdicts without any investigation
// Sonnet 4.5 already complies with all three rules; the directives are
// imperative-form so they don't regress Sonnet but force OpenAI compliance.
const PROVIDER_AGNOSTIC_HARDENING =
  `\n\n**REMOVING CODE MEANS DELETING IT**\n\n` +
  `If a line of code is causing an error and the fix is to remove it:\n` +
  `- DELETE the line entirely (omit it from REPLACE block)\n` +
  `- DO NOT prefix with "// " — that is not a fix, the line still exists\n` +
  `- "// import X" is preserved code, not removed code\n\n` +
  `CORRECT removal:\n` +
  `  --- FIND ---\n` +
  `  import { Bad } from "y";\n` +
  `  import { Good } from "z";\n` +
  `  --- REPLACE ---\n` +
  `  import { Good } from "z";\n\n` +
  `INCORRECT (comment-out is NOT a fix):\n` +
  `  --- FIND ---\n` +
  `  import { Bad } from "y";\n` +
  `  --- REPLACE ---\n` +
  `  // import { Bad } from "y";\n\n` +
  `**REPLACE ONLY SUBSTITUTES THE FIND BLOCK**\n\n` +
  `Lines BEFORE and AFTER the FIND block stay untouched. Do NOT include them in REPLACE.\n\n` +
  `If FIND is "import A;" and you put "import B;\\nimport A;" in REPLACE:\n` +
  `- The result is duplicate "import A;" in the file (one was already below)\n` +
  `- This causes "Identifier already declared" syntax errors\n\n` +
  `Before constructing REPLACE: re-read the surrounding lines. Only include in REPLACE the new content for the FIND region.\n\n` +
  `**BEFORE CLAIMING ANY ERROR IS PRE-EXISTING OR UNRELATED**\n\n` +
  `You MUST satisfy ALL of the following:\n` +
  `1. Read at least one file that could plausibly be the cause\n` +
  `2. Form a specific hypothesis about why the error occurs\n` +
  `3. Attempt at least one apply_patch implementing that hypothesis\n` +
  `4. Verify whether the patch resolved or worsened the error\n\n` +
  `"I cannot determine the cause" or "this seems unrelated" are NOT acceptable verdicts without evidence of investigation. The verification system will mark unrelated claims without patch attempts as failed assessment.\n\n` +
  `Acceptable verdict reasons after investigation:\n` +
  `- Patch attempted, error resolved → tests_passed\n` +
  `- Patch attempted, new error revealed → continue investigation OR tests_failed_by_patch\n` +
  `- Multiple patch attempts, root cause is architectural → state the architectural finding with specific file/line evidence`;

// U.2.C: scope-aware variant used for test failures only (not syntax errors).
// The mandatory apply_patch requirement is gated on whether the failing file
// is within the scope of the agent's changes. For out-of-scope failures the
// agent may emit tests_failed_unrelated immediately after citing evidence,
// without attempting a patch. This prevents wasted iterations on unrelated
// test infrastructure failures (e.g. jsdom/DOM tests after a utility change).
const TEST_FAILURE_SCOPE_HARDENING =
  `\n\n**SCOPE CHECK BEFORE CLAIMING UNRELATED**\n\n` +
  `STEP 1: Quote the exact failing test file path or assertion from the output.\n` +
  `STEP 2: Is that file within scope of your changes this run (files you modified or created)?\n\n` +
  `Scope-IN — the failing file is a file you touched:\n` +
  `  → You MUST attempt a corrective apply_patch. Read the assertion, form a specific hypothesis, patch, verify.\n` +
  `  → "I cannot determine the cause" is not acceptable — read the failing line and produce evidence.\n\n` +
  `Scope-OUT — the failing file is NOT a file you touched this run:\n` +
  `  → Emit [ZONE_VERIFICATION: tests_failed_unrelated] with the failing file path and a one-line\n` +
  `    confirmation it is not in your edits. Do NOT attempt to patch files outside your scope.\n\n` +
  `Cannot extract a failing file path from the output:\n` +
  `  → Emit [ZONE_VERIFICATION: tests_inconclusive] — do not guess or assume out-of-scope.\n\n` +
  `Acceptable verdicts after scope check:\n` +
  `- In-scope, patch resolved → tests_passed\n` +
  `- In-scope, patch attempted, not resolved → tests_failed_by_patch\n` +
  `- Out-of-scope, evidence cited → tests_failed_unrelated\n` +
  `- Cannot determine scope → tests_inconclusive`;

export type FailureRecord = {
  trigger: SelfCorrectTrigger | string;
  errorLine: number | null;
  patchHash: string;
  iter: number;
};

function parsePatchBlocks(patch: string): Array<{ find: string; replace: string }> {
  const blocks: Array<{ find: string; replace: string }> = [];
  const FIND_MARKER = "--- FIND ---";
  const REPLACE_MARKER = "--- REPLACE ---";
  let remaining = String(patch || "");
  while (remaining.includes(FIND_MARKER)) {
    const findIdx = remaining.indexOf(FIND_MARKER);
    const afterFind = remaining.slice(findIdx + FIND_MARKER.length);
    const repIdx = afterFind.indexOf(REPLACE_MARKER);
    if (repIdx === -1) break;
    const findContent = afterFind.slice(0, repIdx);
    const afterReplace = afterFind.slice(repIdx + REPLACE_MARKER.length);
    const nextFindIdx = afterReplace.indexOf(FIND_MARKER);
    const replaceContent =
      nextFindIdx === -1 ? afterReplace : afterReplace.slice(0, nextFindIdx);
    blocks.push({
      find: findContent.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
      replace: replaceContent.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
    });
    remaining = nextFindIdx === -1 ? "" : afterReplace.slice(nextFindIdx);
  }
  return blocks;
}

export function hashPatchBlocks(args: Record<string, unknown> | null | undefined): string {
  const patch = String(args?.patch ?? "");
  const blocks = parsePatchBlocks(patch);
  const concatenated = blocks.length > 0
    ? blocks.map((b) => `${b.find}\n--\n${b.replace}`).join("\n===\n")
    : patch;
  return createHash("sha256").update(concatenated).digest("hex").slice(0, 12);
}

export function extractErrorLine(output: string): number | null {
  const match = String(output || "").match(/\bline\s+(\d+)\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Phase Q.3: pull a dispatch reason out of a Task description. The agent is
 * coached (system prompt) to start the description with one of:
 *   "multi_file_fanout: ..." | "exploration: ..." | "long_isolated_step: ..."
 * Returns the prefix when matched; otherwise "manual". Logged at dispatch
 * time for traceability — not used to gate behavior.
 */
export function extractDispatchReason(description: unknown): string {
  if (typeof description !== "string") return "manual";
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = firstLine.match(/^(multi_file_fanout|exploration|long_isolated_step)\s*:/i);
  if (m) return m[1].toLowerCase();
  return "manual";
}

/**
 * Phase Q.6: render the plan's per-step subagent annotations into a prompt
 * block. Only renders when at least one step is marked delegatable — keeps
 * the prompt terse for trivial tasks.
 *
 * The block is injected near the start of the system prompt so the agent
 * can match the runtime hint to the dispatch coaching it sees in TASK
 * SUBAGENTS. Without this block, the system prompt's "the current plan
 * step is marked subagentEligible: true" instruction is dead-letter — the
 * agent has no per-step visibility.
 */
export function buildPlanAnnotationsBlock(
  plan: import("./executionPlan.js").ExecutionPlan | null | undefined
): string {
  if (!plan || !Array.isArray(plan.steps)) return "";
  const delegatableSteps = plan.steps
    .map((step, idx) => ({ step, idx }))
    .filter(({ step }) => step.subagentEligible === true && !!step.subagentType);
  if (delegatableSteps.length === 0) return "";

  const lines: string[] = [
    "PLAN ANNOTATIONS — delegatable steps in this run:",
  ];
  for (const { step, idx } of delegatableSteps) {
    const files = Array.isArray(step.filesLikely) && step.filesLikely.length > 0
      ? step.filesLikely.join(", ")
      : "unknown";
    lines.push(
      `- Step ${idx + 1} (${step.subagentType}): ${step.title} — files: ${files}`
    );
  }
  lines.push(
    "",
    "When you reach a delegatable step, prefer Task dispatch over inline work — that's why the plan marked it. Use the matching subagent_type (worker for multi-file edits, explore for read-only investigation) and start the description with the dispatch reason prefix (multi_file_fanout / exploration / long_isolated_step)."
  );
  return lines.join("\n");
}

export function detectRepeatedFailure(
  failureHistory: Map<string, FailureRecord[]>,
  targetFilePath: string | null
): { filePath: string; reason: string } | null {
  if (!targetFilePath) return null;
  const records = failureHistory.get(targetFilePath);
  if (!records || records.length < 2) return null;

  const last = records[records.length - 1]!;
  const prev = records[records.length - 2]!;

  if (last.trigger === prev.trigger && last.patchHash === prev.patchHash) {
    return { filePath: targetFilePath, reason: "identical_patch_retried" };
  }

  if (
    last.trigger === prev.trigger &&
    last.errorLine !== null &&
    last.errorLine === prev.errorLine
  ) {
    return { filePath: targetFilePath, reason: "same_root_cause_different_patch" };
  }

  if (last.trigger === prev.trigger) {
    return { filePath: targetFilePath, reason: "same_trigger_repeated_2x" };
  }

  const sameTriggerCount = records.filter((r) => r.trigger === last.trigger).length;
  if (sameTriggerCount >= 3) {
    return { filePath: targetFilePath, reason: "trigger_repeated_3x" };
  }
  return null;
}

function extractSemanticSmellName(errorPreview: string): string {
  const match = String(errorPreview || "").match(/smell detected was:\s*([a-z_]+)/i);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

function getSemanticSmellSpecificGuidance(smellName: string): string {
  switch (smellName) {
    case "broken_template_expression":
      return "You wrote `$ {expr}` somewhere â€” remove the space, it must be `${expr}`.";
    case "duplicate_jsx_attribute":
      return "The JSX element has the same attribute defined twice. Remove the old attribute when adding the new one.";
    case "duplicate_import_statement":
      return "Two import statements target the same module path. Merge them into one import.";
    case "duplicate_adjacent_jsdoc":
      return "You added two identical /** */ JSDoc blocks back-to-back above the same declaration. Remove the duplicate — keep only one comment.";
    case "inline_style_pseudo_class":
      return "Inline React style does not support pseudo-classes like `:hover`. Use a CSS class instead.";
    default:
      return "Remove the conflicting old code and re-issue the patch with one clean replacement.";
  }
}

/** Classify a tool failure into a coaching trigger. */
export function classifyFailure(
  toolName: string,
  output: string,
  error: string | undefined
): SelfCorrectTrigger {
  const text = `${output ?? ""} ${error ?? ""}`.toLowerCase();
  if (toolName === "apply_patch") {
    if (/no_read_first|haven't read this file yet|haven.t read this file yet/i.test(text)) {
      return "apply_patch_no_read_first";
    }
    if (/marker imbalance|--- find ---.*marker.*but.*--- replace ---.*marker/i.test(text)) {
      return "apply_patch_marker_imbalance";
    }
    // Pre-existing broken file: output says "NOT caused by your patch" or "already syntactically broken".
    // The literal rejectionReason "file_already_broken_pre_patch" is a separate field, not in output text.
    if (/file_already_broken_pre_patch|not caused by your patch|already syntactically broken/i.test(text))
      return "apply_patch_pre_existing_broken";
    if (/semantic_smell_post_write|semantically broken output|smell detected was:/i.test(text))
      return "apply_patch_semantic_smell";
    if (/syntax_broken_post_write|broke file syntax/i.test(text))
      return "apply_patch_syntax_broken_post_write";
    if (/find content not found|find_not_found/i.test(text)) return "apply_patch_find_not_found";
    // "matches K locations ... must be unique" is the actual wording from toolExecutor (find_multiple_matches).
    if (/multiple matches|multi-?match|has \d+ occurrences|matches \d+ locations|must be unique/i.test(text))
      return "apply_patch_multiple_matches";
    if (/scope symbol .* not found|rejected_not_found/i.test(text))
      return "apply_patch_scope_not_found";
    // "REPLACE has N lines but FIND has N lines" â€” the replace-shorter-than-find rejection.
    if (/replace has \d+ lines but find has \d+ lines/i.test(text))
      return "apply_patch_replace_shorter_than_find";
    // "FIND block is empty" â€” the find-block-empty rejection.
    if (/find block is empty/i.test(text))
      return "apply_patch_find_block_empty";
  }
  if (toolName === "run_command") {
    if (/spawn .* enoent/i.test(text)) return "tool_command_spawn_failure";
    if (/missing script|command not found|is not recognized/i.test(text))
      return "tool_command_spawn_failure";
    if (/test_failed|tests? failed|failed assertion|expect\(/i.test(text)) return "test_failed";
    return "test_failed"; // generic command failure during test phase
  }
  if (/enoent.*no such file/i.test(text)) return "tool_path_enoent";
  return "unknown";
}

/** S.2.1: map SelfCorrectTrigger to a compact reason string for JSONL diagnostics. */
export function applyPatchRetryReason(trigger: SelfCorrectTrigger | string): string {
  switch (trigger) {
    case "apply_patch_find_not_found": return "find_mismatch";
    case "apply_patch_multiple_matches": return "multiple_matches";
    case "apply_patch_semantic_smell": return "semantic_smell";
    case "apply_patch_syntax_broken_post_write": return "syntax_broken";
    case "apply_patch_repeated_failure_same_file": return "repeated_failure";
    case "apply_patch_pre_existing_broken": return "pre_existing_broken";
    case "apply_patch_scope_not_found": return "scope_not_found";
    case "apply_patch_replace_shorter_than_find": return "replace_shorter";
    case "apply_patch_find_block_empty": return "find_block_empty";
    case "apply_patch_marker_imbalance": return "marker_imbalance";
    case "apply_patch_no_read_first": return "no_read_first";
    default: return "unknown";
  }
}

/** Return a focused, actionable coaching string for the given trigger. */
export function buildCoachingPrompt(
  trigger: SelfCorrectTrigger,
  errorPreview: string,
  _recentToolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>,
  options?: {
    attemptCount?: number;
    filePath?: string;
    /** agent-persistence Tur: when true, the failing file lives under a
     *  framework-generated path (.next/, dist/, etc.). The coaching
     *  prompt switches to a hard-investigate variant that bans
     *  tests_failed_unrelated and requires reading candidate culprits. */
    generatedPathDetected?: boolean;
    /** Optional parsed failing path, surfaced inside the coaching text
     *  so the agent doesn't have to re-extract it from raw output. */
    parsedFailingFile?: string | null;
  }
): string {
  const attemptCount = options?.attemptCount ?? 2;
  const filePath = options?.filePath ?? "this file";
  switch (trigger) {
    case "apply_patch_no_read_first":
      return (
        "You tried to apply_patch a file you haven't read in this run. " +
        "Call read_file FIRST to see the exact lines, then write apply_patch with FIND " +
        "blocks that match verbatim (whitespace included). Don't guess from prior knowledge of similar projects."
      );
    case "apply_patch_find_not_found":
      return (
        `Your FIND block did not match any content in the file.\n` +
        `Common causes:\n` +
        `- The FIND block contains lines that don't exist verbatim (whitespace, line endings, or content drift).\n` +
        `- You assumed code from memory instead of reading the file fresh.\n` +
        `Re-read the target file with read_file FIRST, then copy the EXACT lines you want to replace into FIND.\n` +
        `If the section you want is large, narrow the FIND block to the smallest unique span (3-5 lines max).\n` +
        `Next action: call read_file on the target file before producing your next apply_patch.`
      );
    case "apply_patch_multiple_matches":
      return (
        `Your FIND block matched multiple locations. apply_patch refuses ambiguous edits.\n` +
        `Solutions, pick one:\n` +
        `1. Add the 'scope' parameter (symbolName + symbolKind) to bound the search to a single function/method/class.\n` +
        `2. Extend the FIND block with surrounding lines until it becomes unique in the file.\n` +
        `Next action: produce a new apply_patch with either scope OR a longer, unique FIND block.`
      );
    case "apply_patch_marker_imbalance":
      return (
        `Your last apply_patch had unbalanced --- FIND --- / --- REPLACE --- markers.\n\n` +
        `Required structure: each \`--- FIND ---\` MUST be followed by exactly one \`--- REPLACE ---\`. ` +
        `For multiple edits in one file, use multiple block pairs.\n\n` +
        `WRONG (one FIND, two REPLACE - what you submitted):\n` +
        `  --- FIND ---\n  <region A>\n  --- REPLACE ---\n  <new A>\n  <new B>\n  --- REPLACE ---\n  <new B alt>\n\n` +
        `RIGHT (two FIND, two REPLACE - multi-block):\n` +
        `  --- FIND ---\n  <region A>\n  --- REPLACE ---\n  <new A>\n  --- FIND ---\n  <region B>\n  --- REPLACE ---\n  <new B>\n\n` +
        `Next action: re-issue apply_patch with balanced markers. If only one edit is needed, use exactly one FIND/REPLACE pair.`
      );
    case "apply_patch_semantic_smell": {
      const smellName = extractSemanticSmellName(errorPreview);
      const smellSpecificGuidance = getSemanticSmellSpecificGuidance(smellName);
      return (
        `Your last apply_patch was applied but it produced semantically broken output. The file has been reverted.\n\n` +
        `The smell detected was: ${smellName}\n` +
        `${smellSpecificGuidance}\n\n` +
        `Common causes:\n` +
        `- Forgot to delete the OLD code when inserting NEW code (resulting in duplicate JSX attributes, duplicate imports, or two function definitions)\n` +
        `- Wrote \${expression} as $ {expression} â€” template expressions cannot have whitespace between $ and {\n` +
        `- Used React inline style with pseudo-classes like :hover â€” these do not work; use a CSS class instead\n\n` +
        `Next action: re-read the target file, then produce a corrected apply_patch that removes the conflicting old code and uses correct syntax.`
      );
    }
    case "apply_patch_syntax_broken_post_write":
      return SYNTAX_BROKEN_POST_WRITE_COACHING_PROMPT + PROVIDER_AGNOSTIC_HARDENING;
      return (
        `Your patch was applied but produced invalid syntax â€” the file was reverted to its pre-patch state.\n` +
        `This means your REPLACE block has a bug: missing brace, semicolon, paren, comma, or malformed statement.\n` +
        `Do NOT just retry the same patch. Re-examine your REPLACE block character by character.\n` +
        `If you're unsure where the syntax broke, narrow the change to the smallest possible REPLACE that still accomplishes the task.\n` +
        `Next action: produce a corrected apply_patch with a verified syntactically valid REPLACE block.`
      );
    case "apply_patch_repeated_failure_same_file":
      return (
        `Tool change required for ONE file: "${filePath}".\n\n` +
        `You've failed ${attemptCount} times on "${filePath}" with the same root cause. ` +
        `apply_patch is now blocked for THIS FILE ONLY. Other files in this task are unaffected - ` +
        `keep using apply_patch for them as normal.\n\n` +
        `For "${filePath}" specifically, switch tools:\n` +
        `1. Call read_file on "${filePath}" to see the current state.\n` +
        `2. Mentally compute the FULL corrected file content (every line, top to bottom).\n` +
        `3. Call write_file with filePath="${filePath}" and content=<the entire corrected file>.\n\n` +
        `write_file replaces the whole file atomically. The validator will still check syntax/semantics, ` +
        `but you don't have to reason about FIND/REPLACE matching, indentation, or surrounding lines.\n\n` +
        `Important - task continuation:\n` +
        `Switching tools for "${filePath}" is a LOCAL fix, not a signal to pause the rest of the task. ` +
        `If your task involves other files (cross-file refactor, multi-file rename, etc.), continue working on ` +
        `those files with apply_patch as you were. Handle "${filePath}" with write_file when you reach it; ` +
        `do not let this escalation reorder the remaining work.\n\n` +
        `Note: write_file is normally restricted, but the shrink-guard has been bypassed for "${filePath}" ` +
        `because of the escalation. Use it for this file.`
      );
    case "apply_patch_pre_existing_broken":
      return PRE_EXISTING_BROKEN_COACHING_PROMPT;
      return (
        `The target file was already syntactically broken BEFORE your patch â€” this is not your fault but you must repair it.\n` +
        `Read the file at the reported error line, identify the breakage, and produce ONE apply_patch whose FIND/REPLACE block:\n` +
        `1. Includes the broken region in FIND.\n` +
        `2. Restores valid syntax in REPLACE while ALSO making your intended change.\n` +
        `Omit 'scope' for this call â€” the AST locator cannot parse a broken file.\n` +
        `Next action: read the file, then submit one combined repair-plus-feature apply_patch.`
      );
    case "apply_patch_scope_not_found":
      return (
        `Your apply_patch failed because the scope symbol you specified does not exist in the file. ` +
        `Common causes:\n` +
        `- The target is inside an arrow-function const (e.g., 'const handler = () => {}'). Scope only finds NAMED declarations.\n` +
        `- The target is inside 'export default function X()'. Default exports register as '__default__', not as 'X'.\n` +
        `- The symbol exists with a different kind (e.g., 'class' vs 'function').\n` +
        `Action: REMOVE the scope parameter and re-issue the patch. If the FIND string is unique in the file, scope is unnecessary. ` +
        `Do not guess another symbol name — that wastes iterations.`
      );
    case "tool_command_spawn_failure":
      return (
        `The shell command failed to spawn. On Windows, common causes:\n` +
        `- Bare 'npm test' may fail if npm is not on PATH for the spawn â€” try chained: 'cd <path> && npm test'.\n` +
        `- Wrong cwd â€” pass the absolute repo path or use 'cd <abs-path> && <command>'.\n` +
        `- Wrong script name â€” open package.json to confirm the actual script ('test' vs 'test:e2e' vs 'test:unit').\n` +
        `- Tools like 'npx playwright test' may need to run in a specific subfolder.\n` +
        `Next action: read package.json to confirm the test script name, then re-run with a chained 'cd <repo-path> && <correct-script>' command.`
      );
    case "tool_path_enoent":
      return (
        `A file path failed with ENOENT. Most common cause in Zone: passing an absolute path got concatenated to the cwd.\n` +
        `Solutions:\n` +
        `- Use a path RELATIVE to the repo root (e.g. 'server/controllers/foo.js' not 'C:\\Users\\...\\foo.js').\n` +
        `- If you must use absolute, double-check the executor isn't prepending cwd.\n` +
        `Next action: re-issue the call with a repo-relative path.`
      );
    case "test_failed":
      if (options?.generatedPathDetected) {
        // agent-persistence Tur: hard investigator path. Generated paths
        // (.next/, dist/, build/, out/, .svelte-kit/, .nuxt/) are NEVER the
        // user's direct fault — they are downstream of user-source bugs.
        // We ban tests_failed_unrelated for this case and require the agent
        // to read candidate culprits before any verdict.
        const failingFileRef = options.parsedFailingFile
          ? `\`${options.parsedFailingFile}\``
          : "the framework-generated path shown in the diagnostic above";
        return (
          `Build/test failed and the failing file is in a framework-generated path ` +
          `(${failingFileRef}). Generated paths are downstream of user-source bugs ` +
          `— the real cause lives in YOUR \`app/\`, \`components/\`, \`lib/\` etc.\n\n` +
          `MANDATORY investigation steps before any verdict:\n` +
          `1. Read at least 2 candidate culprit files from the diagnostic above ` +
          `(layout files, providers, recently-modified user files).\n` +
          `2. Look specifically for: missing \`"use client";\` directive, server/client mismatch, ` +
          `broken imports, hooks called from server components.\n` +
          `3. Form a SPECIFIC hypothesis: which file + which line + what change.\n` +
          `4. Apply the fix via apply_patch (or write_file when prepending a single directive).\n` +
          `5. Re-run the failing command to verify the fix.\n\n` +
          `You MUST NOT emit [ZONE_VERIFICATION: tests_failed_unrelated] in this case. ` +
          `Generated paths are never "unrelated" — they reflect user-source state.\n\n` +
          `Permitted verdicts after investigation:\n` +
          `- [ZONE_VERIFICATION: tests_passed] â€” fix applied and verified.\n` +
          `- [ZONE_VERIFICATION: tests_failed_by_patch] â€” fix attempt didn't resolve it; surface what you tried.\n` +
          `- [ZONE_VERIFICATION: tests_inconclusive] â€” investigated thoroughly but couldn't isolate cause; ` +
          `cite which files you read and what you ruled out.\n\n` +
          `Next action: read the candidate files now, then form a hypothesis.` +
          PROVIDER_AGNOSTIC_HARDENING
        );
      }
      return (
        `Tests reported failure or warnings. Determine: is the failure RELATED to your change, ` +
        `or pre-existing/infrastructure noise (deprecation warnings, missing optional deps, env issues)?\n` +
        `Before claiming unrelated, you MUST cite evidence:\n` +
        `- Quote the failing test file path or assertion location from the output.\n` +
        `- Confirm that file is NOT among the files you modified.\n` +
        `- If you cannot extract a failing file path, do NOT claim unrelated â€” emit ` +
        `[ZONE_VERIFICATION: tests_inconclusive] instead.\n` +
        `Verdict rules:\n` +
        `- Unrelated: emit [ZONE_VERIFICATION: tests_failed_unrelated] AND in the same message ` +
        `state the failing file path and confirm it is not in your edits.\n` +
        `- Related: read the assertion/stack trace pointing to your change and produce a corrective apply_patch.\n` +
        `- Cannot tell: emit [ZONE_VERIFICATION: tests_inconclusive].\n` +
        `Avoid blindly re-running the same test command; that consumes attempts without progress.\n` +
        `Next action: classify with evidence; if related, produce a corrective patch.` +
        TEST_FAILURE_SCOPE_HARDENING
      );
    case "apply_patch_replace_shorter_than_find":
      return (
        `Your REPLACE block has FEWER lines than your FIND block, which apply_patch rejects to protect against accidental deletion.\n` +
        `Rules:\n` +
        `- For intent='modify': REPLACE must contain the FULL edited version of every line in FIND.\n` +
        `- For intent='add': REPLACE = every FIND line verbatim, then your new lines appended.\n` +
        `- For intent='delete': REPLACE may be shorter (or empty), but you must set intent='delete'.\n` +
        `Next action: re-read the file, reconstruct the FIND block, and ensure REPLACE has at least as many lines as FIND.`
      );
    case "apply_patch_find_block_empty":
      return (
        `Your FIND block is empty â€” apply_patch requires at least one line in FIND to locate the insertion point.\n` +
        `If you want to append to a file, use FIND to anchor on the last existing line and REPLACE to include it plus your additions.\n` +
        `Next action: re-read the file and add a non-empty FIND anchor around where you want to make changes.`
      );
    case "unknown":
    default:
      return (
        `Something went wrong but the failure mode wasn't recognized automatically.\n` +
        `Re-read the most recent tool error carefully. If the error says "not found", it is likely a path or naming issue. ` +
        `If it mentions syntax, check your REPLACE blocks. If it mentions multiple matches, narrow your FIND.\n` +
        `Next action: do not repeat the previous attempt verbatim â€” change ONE specific thing; keep any note concise.`
      );
  }
}

/** Chat Completions API: `response.choices[0].message.tool_calls`. */
function extractFunctionCallItems(
  response: unknown
): ChatCompletionMessageFunctionToolCall[] {
  const choices = (response as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } } | null)
    ?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const calls: ChatCompletionMessageFunctionToolCall[] = [];
  for (const item of toolCalls) {
    const t = item as Partial<ChatCompletionMessageFunctionToolCall> | null;
    if (
      t &&
      t.type === "function" &&
      typeof t.id === "string" &&
      t.function &&
      typeof t.function.name === "string" &&
      typeof t.function.arguments === "string"
    ) {
      calls.push(item as ChatCompletionMessageFunctionToolCall);
    }
  }
  return calls;
}

/** Parse a [ZONE_VERIFICATION: <reason>] tag from text. */
function parseVerificationTag(text: string): VerificationReason | null {
  const m = String(text || "").match(/\[ZONE_VERIFICATION:\s*([\w_]+)\]/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const valid: VerificationReason[] = [
    'tests_passed', 'tests_skipped_no_infra', 'tests_inconclusive',
    'tests_failed_unrelated', 'tests_failed_by_patch', 'no_verification_attempted',
    'verification_failed_staged',
    'no_changes_made',
  ];
  return (valid as string[]).includes(raw) ? (raw as VerificationReason) : null;
}

/** Remove any [ZONE_VERIFICATION: <reason>] tag (and the whitespace/newlines around it) from text. */
export function stripVerificationTag(text: string): string {
  return String(text || "")
    .replace(/\s*\[ZONE_VERIFICATION:\s*[\w_]+\]\s*/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function didApplyPatch(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>
): boolean {
  return log.some(
    (e) =>
      (e.tool === "apply_patch" || e.tool === "write_file") &&
      !String(e.result || "").toLowerCase().includes("error") &&
      !String(e.result || "").toLowerCase().includes("not found") &&
      !String(e.result || "").toLowerCase().includes("fail")
  );
}

/** Check whether the agent has read or written this file earlier in the current run.
 * A subsequent successful apply_patch/write_file on the same file does NOT invalidate
 * the read — the agent emitted that change so the context is still fresh. */
function wasFileReadOrWritten(
  log: Array<{ tool: string; args: Record<string, unknown>; success?: boolean }>,
  filePath: string
): boolean {
  const target = String(filePath || "").trim();
  if (!target) return false;
  for (const entry of log) {
    const entryPath =
      typeof entry.args?.filePath === "string"
        ? String(entry.args.filePath)
        : null;
    if (entryPath !== target) continue;
    if (entry.tool === "read_file" && entry.success !== false) return true;
    if (entry.tool === "write_file" && entry.success !== false) return true;
    if (entry.tool === "apply_patch" && entry.success === true) return true;
  }
  return false;
}

export function applyNoInfraVerificationOverride(input: {
  verificationReason: VerificationReason;
  framework?: { hasTests: boolean; testFilesDetected: boolean };
  patchApplied: boolean;
  triggeredBy: "natural_completion" | "max_iterations";
}): VerificationReason {
  if (
    input.framework &&
    !input.framework.hasTests &&
    input.patchApplied &&
    (input.verificationReason === "tests_inconclusive" ||
      input.verificationReason === "no_verification_attempted")
  ) {
    debugLog("[zone-agent-no-infra-override]", JSON.stringify({
      triggeredBy: input.triggeredBy,
      originalVerdict: input.verificationReason,
      overriddenTo: "tests_skipped_no_infra",
      reason: "framework has no runnable tests; downgraded inconclusive/no-verification to skipped",
      hasTests: false,
      testFilesDetected: input.framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }

  return input.verificationReason;
}

// Phase Q.4 invariant: runStagingVerification uses its own exec instance and
// reads err.stdout/err.stderr directly — it never goes through executeTool's
// run_command handler. truncateCommandOutput therefore does NOT affect
// pass/fail determination here.
const execAsync_verify = promisify(exec);

export function selectVerificationCommand(
  framework: { language?: string; testCommand?: string } | undefined
): { command: string; timeoutMs: number; label: string } | null {
  if (!framework) return null;
  if (framework.language === "typescript") {
    return { command: "npx tsc --noEmit", timeoutMs: 60000, label: "tsc" };
  }
  if (framework.testCommand && (framework.language === "javascript" || framework.language === "python")) {
    return { command: framework.testCommand, timeoutMs: 90000, label: "test" };
  }
  return null;
}

// Phase J.3: count diagnostic errors in verification output. Used to compare
// pre-staging baseline vs post-staging output so projects with pre-existing
// errors don't have every patch blocked.
function countVerificationErrors(label: string, output: string): number {
  const text = String(output || "");
  if (!text) return 0;
  if (label === "tsc") {
    // TypeScript: lines like `src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.`
    const matches = text.match(/error TS\d+:/g);
    return matches ? matches.length : 0;
  }
  if (label === "test") {
    // Test runner output is heterogeneous; count common failure markers.
    // Covers vitest/jest (FAIL, ✗), pytest (FAILED, \d+ failed), and similar.
    let count = 0;
    count += (text.match(/\bFAIL(ED)?\b/g) || []).length;
    count += (text.match(/✗/g) || []).length;
    count += (text.match(/\d+ failed/i) ? 1 : 0);
    return Math.max(count, text ? 1 : 0);
  }
  return text ? 1 : 0;
}

async function runVerificationCommand(
  choice: { command: string; timeoutMs: number; label: string },
  repoPath: string
): Promise<
  | { status: "pass"; durationMs: number }
  | { status: "fail"; durationMs: number; errorPreview: string }
> {
  const start = Date.now();
  try {
    await execAsync_verify(choice.command, {
      cwd: repoPath,
      timeout: choice.timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: sanitizeVerificationEnv(),
    });
    return { status: "pass", durationMs: Date.now() - start };
  } catch (err) {
    const stdout = String((err as { stdout?: unknown }).stdout ?? "");
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const combined = (stdout + "\n" + stderr).trim();
    const preview = combined.split("\n").slice(0, 30).join("\n").slice(0, 2000);
    return {
      status: "fail",
      durationMs: Date.now() - start,
      errorPreview: preview || String((err as Error).message ?? err),
    };
  }
}

export async function runStagingVerification(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
}): Promise<
  | { status: "pass"; label: string; durationMs: number; baselineErrorCount?: number; postErrorCount?: number }
  | {
      status: "fail";
      label: string;
      durationMs: number;
      errorPreview: string;
      // Phase J.3: counts let downstream distinguish a regression (post >
      // baseline) from a pre-existing failure (post <= baseline). Only
      // populated when we ran a baseline pass after the staged run failed.
      baselineErrorCount?: number;
      postErrorCount?: number;
      regressed?: boolean;
    }
  | { status: "skipped"; reason: string }
> {
  if (input.stagingFiles.size === 0) {
    return { status: "skipped", reason: "no_staged_files" };
  }
  const choice = selectVerificationCommand(input.framework);
  if (!choice) {
    return { status: "skipped", reason: "no_command_for_framework" };
  }

  const start = Date.now();
  // Run verification against temp-flushed staging.
  let stagedErr: unknown = null;
  let stagedExitCode = 0;
  try {
    await input.withStagingTempFlush(input.stagingFiles, async () => {
      return await execAsync_verify(choice.command, {
        cwd: input.repoPath,
        timeout: choice.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizeVerificationEnv(),
      });
    });
  } catch (err) {
    stagedErr = err;
    const code = Number((err as { code?: unknown }).code);
    stagedExitCode = Number.isFinite(code) ? code : 1;
  }

  if (stagedErr === null) {
    console.log(
      `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=0 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
    );
    return { status: "pass", label: choice.label, durationMs: Date.now() - start };
  }

  console.log(
    `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=${stagedExitCode} stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
  );
  const stagedStdout = String((stagedErr as { stdout?: unknown }).stdout ?? "");
  const stagedStderr = String((stagedErr as { stderr?: unknown }).stderr ?? "");
  const stagedCombined = (stagedStdout + "\n" + stagedStderr).trim();
  const stagedPreview =
    stagedCombined.split("\n").slice(0, 30).join("\n").slice(0, 2000) ||
    String((stagedErr as Error).message ?? stagedErr);
  const postErrorCount = countVerificationErrors(choice.label, stagedCombined);

  // Phase J.3: staged run failed. Compare to baseline (no staging). If the
  // baseline ALSO fails with ≥ the same error count, the patch didn't make
  // things worse — pre-existing errors shouldn't block apply.
  const baseline = await runVerificationCommand(choice, input.repoPath);
  const baselineErrorCount =
    baseline.status === "fail"
      ? countVerificationErrors(choice.label, baseline.errorPreview)
      : 0;

  const regressed = postErrorCount > baselineErrorCount;
  debugLog("[zone-verify-baseline]", JSON.stringify({
    label: choice.label,
    stagedExitCode,
    baselineStatus: baseline.status,
    baselineErrorCount,
    postErrorCount,
    regressed,
  }));

  return {
    status: "fail",
    label: choice.label,
    durationMs: Date.now() - start,
    errorPreview: stagedPreview,
    baselineErrorCount,
    postErrorCount,
    regressed,
  };
}

/** Phase F: formats post-loop verification regression as WARN text (patches stay on disk). */
function buildVerificationWarningsMessage(opts: {
  errors: Array<{ file?: string; line?: number; col?: number; code: string; message: string }>;
  filesFlushed: number;
  baselineErrorCount?: number;
  postErrorCount?: number;
}): string {
  const header = `VERIFICATION WARNINGS — patches applied (${opts.filesFlushed} file${opts.filesFlushed !== 1 ? "s" : ""}), new errors detected.`;
  const counts =
    opts.baselineErrorCount !== undefined && opts.postErrorCount !== undefined
      ? `Errors: ${opts.postErrorCount} (baseline was ${opts.baselineErrorCount}).`
      : "";
  const errorLines = opts.errors.slice(0, 20).map((e) => {
    const loc = e.file ? `${e.file}${e.line !== undefined ? `:${e.line}` : ""}` : "";
    return `  ${loc ? `${loc} ` : ""}[${e.code}] ${e.message}`;
  });
  return [header, ...(counts ? [counts] : []), ...(errorLines.length ? ["Errors:", ...errorLines] : [])].join("\n");
}

export async function finalizeStaging(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
  /** Phase F: "warn" (default) keeps patches on disk and surfaces errors as warnings.
   *  "rollback" restores pre-Phase-F behavior: staging discarded when regression detected. */
  verifyMode?: "warn" | "rollback";
}): Promise<{
  flushed: boolean;
  verification:
    | { status: "pass"; label: string; durationMs: number; baselineErrorCount?: number; postErrorCount?: number }
    | {
        status: "fail";
        label: string;
        durationMs: number;
        errorPreview: string;
        baselineErrorCount?: number;
        postErrorCount?: number;
        regressed?: boolean;
      }
    | { status: "skipped"; reason: string };
  filesFlushed: number;
  flushFailures: number;
  // Phase J.3.1: when staging is discarded by a regression rollback, return
  // the staged content as a snapshot so runLlmPatchFlow can render the
  // "what was attempted" diff under the rolled-back banner. Keyed by the
  // same absolute paths as input.stagingFiles. Empty/undefined when no
  // discard happened (pass-through or pre-existing-errors).
  discardedStaging?: Map<string, string>;
}> {
  const verification = await runStagingVerification({
    stagingFiles: input.stagingFiles,
    repoPath: input.repoPath,
    framework: input.framework,
    withStagingTempFlush: input.withStagingTempFlush,
  });

  debugLog("[zone-staging-verification]", JSON.stringify({
    status: verification.status,
    label: "label" in verification ? verification.label : null,
    durationMs: "durationMs" in verification ? verification.durationMs : null,
    reason: "reason" in verification ? verification.reason : null,
    errorPreviewLen:
      verification.status === "fail" ? verification.errorPreview.length : 0,
    baselineErrorCount:
      "baselineErrorCount" in verification ? verification.baselineErrorCount : undefined,
    postErrorCount:
      "postErrorCount" in verification ? verification.postErrorCount : undefined,
    regressed:
      verification.status === "fail" ? verification.regressed : undefined,
  }));

  // Phase J.3 / Phase F: when verification regresses:
  //   - rollback mode (ZONE_VERIFY_MODE=rollback): discard staging, restore disk.
  //   - warn mode (default): skip discard, fall through to flush — patches stay on
  //     disk; agentLoop surfaces errors as VERIFICATION WARNINGS in the summary.
  if (verification.status === "fail" && verification.regressed !== false) {
    if ((input.verifyMode ?? "warn") === "rollback") {
      const discardedCount = input.stagingFiles.size;
      const discardedStaging = new Map<string, string>(input.stagingFiles);
      input.stagingFiles.clear();
      debugLog("[zone-staging-discard]", JSON.stringify({
        reason: "verification_regressed",
        discardedCount,
        baselineErrorCount: verification.baselineErrorCount,
        postErrorCount: verification.postErrorCount,
      }));
      return {
        flushed: false,
        verification,
        filesFlushed: 0,
        flushFailures: 0,
        discardedStaging,
      };
    }
    // warn mode: fall through — flush proceeds, errors surface in summary.
    debugLog("[zone-staging-warn-mode]", JSON.stringify({
      reason: "verification_regressed_warn_mode",
      baselineErrorCount: verification.baselineErrorCount,
      postErrorCount: verification.postErrorCount,
    }));
  }

  if (verification.status === "fail" && verification.regressed === false) {
    debugLog("[zone-staging-pre-existing-errors]", JSON.stringify({
      reason: "no_regression",
      baselineErrorCount: verification.baselineErrorCount,
      postErrorCount: verification.postErrorCount,
      label: verification.label,
    }));
    // Fall through to flush — patch will apply despite pre-existing errors.
  }

  let allUnchanged = true;
  let comparedCount = 0;
  for (const [abs, content] of input.stagingFiles) {
    comparedCount++;
    let diskContent: string | null = null;
    try {
      diskContent = fs.readFileSync(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        diskContent = null;
        allUnchanged = false;
        break;
      }
      allUnchanged = false;
      break;
    }
    if (diskContent !== content) {
      allUnchanged = false;
      break;
    }
  }

  if (allUnchanged && comparedCount > 0) {
    debugLog("[zone-staging-noop]", JSON.stringify({
      stagedCount: input.stagingFiles.size,
      comparedCount,
    }));
    return {
      flushed: false,
      verification: { status: "skipped", reason: "no_changes_made" },
      filesFlushed: 0,
      flushFailures: 0,
    };
  }

  // staging-flush-bug Tur: filesFlushed previously incremented immediately
  // after fs.writeFileSync regardless of whether disk actually persisted the
  // content. The smoke for run 71133d8f saw [zone-staging-flush] report 2
  // files written but on-disk mtime was unchanged — the log was lying. The
  // counter now reflects VERIFIED writes (re-read disk content matches
  // staging). Per-file [zone-staging-flush-write] logs surface mtime
  // before/after and content-match status to catch any future regression.
  let filesFlushed = 0;
  let flushFailures = 0;
  for (const [abs, content] of input.stagingFiles) {
    let mtimeBefore: number | null = null;
    try {
      mtimeBefore = fs.statSync(abs).mtimeMs;
    } catch {
      mtimeBefore = null;
    }
    try {
      fs.writeFileSync(abs, content, "utf8");
      let mtimeAfter: number | null = null;
      try {
        mtimeAfter = fs.statSync(abs).mtimeMs;
      } catch {
        mtimeAfter = null;
      }
      let diskContentMatches = false;
      try {
        diskContentMatches = fs.readFileSync(abs, "utf8") === content;
      } catch {
        diskContentMatches = false;
      }
      debugLog("[zone-staging-flush-write]", JSON.stringify({
        filePath: abs,
        bytesWritten: content.length,
        mtimeBefore,
        mtimeAfter,
        changed: mtimeBefore !== mtimeAfter,
        diskContentMatches,
      }));
      if (diskContentMatches) {
        filesFlushed++;
      } else {
        flushFailures++;
        errorLog("[zone-staging-flush-error]", {
          filePath: abs,
          error: "post_write_content_mismatch",
          bytesExpected: content.length,
        });
      }
    } catch (err) {
      flushFailures++;
      errorLog("[zone-staging-flush-error]", {
        filePath: abs,
        error: String((err as Error).message ?? err),
      });
    }
  }
  // Final integrity sweep: re-read all files at the moment we emit the
  // [zone-staging-flush] log. If a downstream restore overwrites any of our
  // writes between the per-file write and this point, postFlushMismatches
  // will be > 0 and surface the bug visibly.
  let postFlushMismatches = 0;
  for (const [abs, content] of input.stagingFiles) {
    try {
      if (fs.readFileSync(abs, "utf8") !== content) postFlushMismatches++;
    } catch {
      postFlushMismatches++;
    }
  }
  debugLog("[zone-staging-flush]", JSON.stringify({
    filesFlushed,
    failures: flushFailures,
    totalStaged: input.stagingFiles.size,
    postFlushMismatches,
  }));
  return { flushed: true, verification, filesFlushed, flushFailures };
}

/** Infer verification reason from the tool call log when the agent gave no tag. */
export function inferVerificationFromLog(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean; testFilesDetected: boolean }
): VerificationReason {
  const patchApplied = didApplyPatch(log);
  if (framework && !framework.hasTests && patchApplied) {
    debugLog("[zone-agent-no-infra-verdict]", JSON.stringify({
      reason: "tests_skipped_no_infra",
      hasTests: false,
      testFilesDetected: framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }
  const hasInfraError = log.some(
    (e) =>
      e.tool === "run_command" &&
      /spawn.*enoent|enoent.*cmd\.exe|missing script|command not found|cannot find/i.test(
        String(e.result || "")
      )
  );
  const testsRan = log.some(
    (e) => e.tool === "run_command" && /\bpassed\b|\b\d+ pass/i.test(String(e.result || ""))
  );
  if (patchApplied && testsRan) return "tests_passed";
  if (patchApplied && hasInfraError) return "tests_inconclusive";
  if (!patchApplied) return "tests_failed_by_patch";
  return "no_verification_attempted";
}

export function validateUnrelatedClaim(input: {
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  patchedFilePaths: string[];
  framework?: { hasTests: boolean };
}): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    input.framework && !input.framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";
  const anyRunCommand = input.log.some((entry) => entry.tool === "run_command");
  const looksLikePassingRunCommand = (output: string): boolean => {
    const text = String(output || "");
    return (
      /\ball tests passed\b/i.test(text) ||
      /\b0 failed\b/i.test(text) ||
      /\b\d+\s+passed\b.*\b0\s+failed\b/i.test(text)
    );
  };
  const isRunCommandFailure = (entry: {
    tool: string;
    result: string;
    success?: boolean;
  }): boolean => {
    if (entry.tool !== "run_command") return false;
    return entry.success === false;
  };
  const failingRunCommand = [...input.log]
    .reverse()
    .find(
      (entry) =>
        isRunCommandFailure(entry) &&
        !looksLikePassingRunCommand(String(entry.result || ""))
    );

  // Bug 44: stale-failure resolution check.
  // If a failing run_command was followed by a successful run_command,
  // the failure was resolved by a subsequent patch+retry. The agent's
  // `tests_failed_unrelated` claim might still be technically wrong (the
  // failure was related to their patch path), but it should not be demoted
  // to `tests_failed_by_patch` because the file is no longer failing.
  // This handles the canonical "agent encountered a build error, fixed it,
  // re-ran build, build passed" sequence.
  if (failingRunCommand) {
    const failingIdx = input.log.indexOf(failingRunCommand);
    const succeededAfter = input.log.slice(failingIdx + 1).some(
      (entry) => entry.tool === "run_command" && entry.success === true
    );
    if (succeededAfter) {
      return {
        accept: true,
        reason:
          "failing run_command was resolved by a later successful run_command — verification effectively passed",
      };
    }
  }

  if (!anyRunCommand) {
    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "no run_command in log â€” agent claimed test failure without ever running tests",
    };
  }

  if (!failingRunCommand) {
    return {
      accept: true,
      reason:
        "run_command(s) executed but none look like failure â€” accepting agent classification",
    };
  }

  const verificationError = parseVerificationError(
    String(failingRunCommand.result || ""),
    input.patchedFilePaths
  );
  const failingOutput = String(failingRunCommand.result || "");
  const normalizedPatched = input.patchedFilePaths.map(normalizePatchedPath);
  const failingFile = normalizePatchedPath(verificationError.failingFile ?? "");
  const failingFileIsPatched =
    !!failingFile &&
    normalizedPatched.some(
      (patchedFilePath) =>
        patchedFilePath === failingFile || failingFile.endsWith(patchedFilePath)
    );

  if (verificationError.isPreExisting === true) {
    return {
      accept: true,
      reason: "parser confirms pre-existing/tooling",
    };
  }

  if (
    !failingFile &&
    /npm warn|deprecated|warning:/i.test(failingOutput) &&
    !/command failed:/i.test(failingOutput)
  ) {
    return {
      accept: true,
      reason: "warning-only output without a failing file path is treated as tooling noise",
    };
  }

  if (failingFileIsPatched) {
    return {
      accept: false,
      demoteTo: "tests_failed_by_patch",
      reason:
        "failing file is in patchedFilePaths â€” agent's unrelated claim rejected",
    };
  }

  if (failingFile) {
    return {
      accept: true,
      reason: "parser extracted failing file outside patchedFilePaths",
    };
  }

  return {
    accept: false,
    demoteTo: noInfraDemote,
    reason:
      "cannot verify unrelated claim â€” no failing file extracted or evidence ambiguous",
  };
}

export function validatePassedClaim(
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean }
): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    framework && !framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";
  const runCommands = toolCallLog.filter((entry) => entry.tool === "run_command");

  if (runCommands.length === 0) {
    return {
      accept: false,
      demoteTo: framework && !framework.hasTests
        ? "tests_skipped_no_infra"
        : "no_verification_attempted",
      reason: "agent claimed tests passed without ever running tests",
    };
  }

  const hasSuccessPattern = runCommands.some((entry) => {
    const output = String(entry.result || "");
    return (
      /\b\d+\s+pass(?:ed|ing)\b/i.test(output) ||
      /\bTests:\s+.*passed/i.test(output) ||
      /\bOK\s*\(\d+\s+tests?\)/i.test(output) ||
      /(?:✓|✔)\s+\d+\s+tests?\s+passed/i.test(output) ||
      /===\s+\d+\s+passed/i.test(output) ||
      /All tests passed/i.test(output)
    );
  });

  if (!hasSuccessPattern) {
    const anyFailed = runCommands.some((entry) => entry.success === false);
    if (anyFailed) {
      return {
        accept: false,
        demoteTo: noInfraDemote,
        reason:
          "agent claimed passed but at least one run_command failed and no success pattern matched",
      };
    }

    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "agent claimed passed but no test-success pattern detected in any run_command output",
    };
  }

  return {
    accept: true,
    reason: "test success pattern detected in run_command output",
  };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const runStartTs = Date.now();
  const scopedContext: Parameters<typeof withRequestContext>[0] = {};
  if (typeof input.userId === "string" && input.userId.trim()) {
    scopedContext.userId = input.userId.trim();
  }
  if (typeof input.runId === "string" && input.runId.trim()) {
    scopedContext.runId = input.runId.trim();
  }
  if (input.subagent) {
    scopedContext.subagentId = input.subagent.id;
    scopedContext.subagentType = input.subagent.type;
    scopedContext.parentRunId = input.subagent.parentRunId;
  }
  try {
    const result = await withRequestContext(scopedContext, () => runAgentLoopScoped(input));
    // K.3.C3: emit terminal run-summary record for top-level runs only.
    // Best-effort — failure must not affect the caller's result.
    if (!input.subagent && input.runId) {
      const userId =
        typeof input.userId === "string" && input.userId.trim()
          ? input.userId.trim()
          : "local-dev";
      const terminationReason = result.terminationReason ?? "unknown";
      recordRunSummary({
        userId,
        runId: input.runId.trim(),
        latencyMs: Date.now() - runStartTs,
        terminationReason,
      }).catch((e) => {
        log("[zone-run-summary-write-failed]", JSON.stringify({
          runId: input.runId,
          error: e instanceof Error ? e.message : String(e),
          ts: new Date().toISOString(),
        }));
      });
      // Pre-check warning fires before any LLM cost is incurred and the run continues.
      // Suppressing here avoids implying graceful_degrade in telemetry/UI when no degradation is happening.
      const costUsd = result.costUsd ?? 0;
      if (!(costUsd === 0 && terminationReason === "daily_usd_cap_exceeded")) {
        log("[zone-graceful-degrade]", JSON.stringify({
          runId: input.runId.trim(),
          terminationReason,
          gracefulDegrade: terminationReason !== "natural_completion",
          canResume: canResumeFromTerminationReason(terminationReason),
          costUsd,
          tier: input.taskClassification?.tier ?? null,
          ts: Date.now(),
        }));
      }
    }
    return result;
  } finally {
    if (!input.subagent && input.runId) {
      resetSubagentCallCount(input.runId);
    }
  }
}

async function runAgentLoopScoped(input: AgentLoopInput): Promise<AgentLoopResult> {
  const mode = normalizeAgentLoopMode(input.mode);
  const hasExplicitMode =
    input.mode === "chat" || input.mode === "investigate" || input.mode === "patch";
  const isChatMode = mode === "chat";
  const isInvestigationMode = mode === "investigate";
  const isReadOnlyMode = isChatMode || isInvestigationMode;
  const baseMaxIterations =
    typeof input.maxIterationsOverride === "number"
      ? input.maxIterationsOverride
      : typeof input.maxIterations === "number"
        ? input.maxIterations
        : BASE_MAX_ITERATIONS;
  // S.2.1: escalation disabled for main (tier-constrained) loops — the tier
  // iterCap is already the authoritative budget. Escalation remains active only
  // for subagent loops that bypass tier gating (isSubagentLoop resolved below).
  let escalationEnabled = typeof input.maxIterationsOverride !== "number";
  // Phase H.6: surface the effective budget at loop entry for tracing how
  // plan-aware overrides propagate through investigation/patch entry points.
  debugLog("[zone-iter-budget-effective]", JSON.stringify({
    mode,
    runId: input.runId ?? null,
    maxIterations: baseMaxIterations,
    escalationEnabled,
    source:
      typeof input.maxIterationsOverride === "number"
        ? "override"
        : typeof input.maxIterations === "number"
          ? "computed"
          : "default",
  }));
  let iterationBudget: IterationBudgetState = {
    maxIterationsForRun: baseMaxIterations,
    escalationBonusGranted: false,
  };
  const effectiveAllowedTools =
    input.allowedTools ?? (hasExplicitMode ? modeDefaultAllowedTools(mode) : undefined);
  // Phase X.0: suggest_scope_change is now in ZONE_TOOLS; no separate
  // AUDIT_ONLY_TOOLS spread needed. The allowedTools filter still restricts
  // which tools are presented in audit mode (AUDIT_ALLOWED_TOOLS ⊂ ZONE_TOOLS).
  const toolsForLLM = sortToolsForPromptCache(
    effectiveAllowedTools
      ? ZONE_TOOLS.filter((t) => effectiveAllowedTools.has(getZoneToolName(t)))
      : ZONE_TOOLS
  );
  if (effectiveAllowedTools && toolsForLLM.length === 0) {
    throw new Error("AgentLoopInput.allowedTools resolved to zero tools — aborting.");
  }

  // L.2: tier-based tool exposure. Subagent loops skip tier gating — they
  // inherit the parent's constraints via allowedTools / tokenBudgetBaseTokens.
  const isSubagentLoop = input.subagent !== undefined;
  const tierLimits = isSubagentLoop
    ? null
    : resolveTierLimits(input.taskClassification, { forceTierOverride: input.forceTier });

  let softIterWarnThreshold: number | undefined;
  let softWarnInjected = false;
  let midWarnInjected = false;
  if (tierLimits) {
    const effectiveSoftIterWarn = tierLimits.softIterWarn;
    softIterWarnThreshold = effectiveSoftIterWarn;
    // Soft warn replaces hard-cap: loop runs up to 3× the warn threshold;
    // tokenBudgetCap is the real terminator. Escalation disabled since tier is authoritative.
    iterationBudget = { ...iterationBudget, maxIterationsForRun: effectiveSoftIterWarn * 3 };
    escalationEnabled = false;
    log("[zone-tier-constraints-applied]", JSON.stringify({
      runId: input.runId ?? null,
      tier: input.taskClassification?.tier ?? "medium",
      maxSubagentCalls: tierLimits.maxSubagentCalls,
      tokenBudgetCap: tierLimits.tokenBudgetCap,
      softIterWarn: effectiveSoftIterWarn,
      classificationConfidence: input.taskClassification?.confidence ?? 0,
      fallbackUsed: input.taskClassification?.fallbackUsed ?? true,
    }));
    if (typeof input.runId === "string" && input.runId.trim()) {
      input.onStructuredEvent?.({
        type: "tier_constraints_applied",
        title: "Tier constraints applied",
        status: "active",
        tier: input.taskClassification?.tier ?? "medium",
        tokenBudgetCap: tierLimits.tokenBudgetCap,
        softIterWarn: effectiveSoftIterWarn,
      });
    }
  }

  const effectiveTokenBudgetCap = tierLimits?.tokenBudgetCap ?? TOKEN_BUDGET_CAP;
  const effectiveMaxSubagentCalls = tierLimits?.maxSubagentCalls;

  // Phase K.1/K.5: daily USD cap gate — only enforced on top-level (non-subagent) runs.
  if (!isSubagentLoop) {
    const userId = typeof input.userId === "string" && input.userId.trim()
      ? input.userId.trim()
      : "local-dev";

    // K.5: load org policy (policy layer is top of resolution chain)
    const policyResult = loadOrgPolicy(process.env.ZONE_ORG_POLICY_PATH);
    log("[zone-policy-loaded]", JSON.stringify({
      runId: input.runId ?? null,
      ok: policyResult.ok,
      source: policyResult.ok ? policyResult.source : null,
      reason: !policyResult.ok ? policyResult.reason : null,
    }));
    const policy = policyResult.ok ? policyResult.policy : null;

    const capResolution = resolveDailyUsdCap({
      userId,
      policyValue: policy?.dailyUsdCap,
      userOverride: readDailyUsdCapOverride(),
      envValue: process.env.ZONE_DAILY_USD_CAP,
    });
    const todayUsage = await getUsage(userId, "day");
    log("[zone-daily-usd-status]", JSON.stringify({
      runId: input.runId ?? null,
      userId,
      capUsd: capResolution.capUsd,
      capSource: capResolution.source,
      spentUsd: todayUsage.totalCostUsd,
    }));

    // Log which policy fields were applied vs. deferred to Phase M
    if (policy) {
      const appliedFields: string[] = [];
      const unsupportedFields: string[] = [];
      if (policy.dailyUsdCap !== undefined) appliedFields.push("dailyUsdCap");
      for (const f of ["monthlyUsdCap", "allowedTiers", "maxSubagentCallsCap", "autoAuditRequired"] as const) {
        if (policy[f] !== undefined) unsupportedFields.push(f);
      }
      log("[zone-policy-applied]", JSON.stringify({
        runId: input.runId ?? null,
        appliedFields,
        unsupportedFields,
      }));
      for (const f of unsupportedFields) {
        log("[zone-policy-unsupported-field]", JSON.stringify({
          runId: input.runId ?? null,
          field: f,
          note: "schema accepted, enforcement deferred to Phase M",
        }));
      }
    }

    if (capResolution.capUsd > 0 && todayUsage.totalCostUsd >= capResolution.capUsd) {
      const msg =
        `Daily USD cap of $${capResolution.capUsd.toFixed(2)} reached ` +
        `(spent $${todayUsage.totalCostUsd.toFixed(4)} today). ` +
        `Dispatch rejected to stay within budget.`;
      return {
        success: false,
        summary: msg,
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        terminationReason: "daily_usd_cap_exceeded",
      };
    }
  }

  const toolCallLog: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }> = [];
  const filesModified = new Set<string>();
  // Phase F: default "warn" — patches stay on disk when regression detected; "rollback" restores legacy behavior.
  const verifyMode: "warn" | "rollback" = process.env["ZONE_VERIFY_MODE"] === "rollback" ? "rollback" : "warn";
  let todosEmittedThisRun = false;
  let selfCorrectionAttempts = 0;
  const failureHistory = new Map<string, FailureRecord[]>();
  const escalatedFiles = new Set<string>();
  // Tur 1: in-memory staging. Writes go here instead of disk during the loop;
  // reads fall back to staging first, disk second. Top-level loops own flushing;
  // subagents share the parent map and must not flush independently.
  // run_command stays disk-bound — it sees the OLD disk state until flush. (Tur 2)
  const ownsStagingFiles = input.parentStagingFiles === undefined;
  const stagingFiles = input.parentStagingFiles ?? new Map<string, string>();

  // Diagnostic: confirm agent loop entry and tool inventory
  debugLog("[zone-agent-loop-entry]", JSON.stringify({
    task: input.task.slice(0, 200),
    repoPath: input.repoPath,
    maxIterations: iterationBudget.maxIterationsForRun,
    toolsAvailable: toolsForLLM.map(
      (t) => getZoneToolName(t) || "unknown"
    ),
    hasRunId: !!(input.runId && input.runId.trim()),
  }));

  const fw = input.framework;
  const fwLines: string[] = fw
    ? [
        `## Project framework`,
        `- Framework: ${fw.framework} (${fw.language})`,
        `- Package manager: ${fw.packageManager}`,
        `- Build command: ${fw.buildCommand || "none"}`,
        `- Dev command: ${fw.devCommand || "none"}`,
        `- Test command: ${fw.testCommand || "none"}`,
        `- Test framework: ${fw.testFramework}`,
        `- Has runnable tests: ${fw.hasTests}`,
        `- Test files detected: ${fw.testFilesDetected}`,
      ]
    : [];
  if (fw) {
    if (fw.hasTests && fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Use exactly: \`${fw.testCommand}\``,
        `- Do not substitute alternative test commands. If this command fails, investigate the failure - do not try other runners.`
      );
    } else if (fw.hasTests && !fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Runner is installed (${fw.testFramework}) but no test files were detected.`,
        `- Use exactly: \`${fw.testCommand}\` if you need to verify.`,
        `- Do not invent test commands.`
      );
    } else if (!fw.hasTests && fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Test files exist but no runner is installed. Report this as a finding in the verdict.`,
        `- Do NOT attempt to run tests. Do NOT install a runner.`,
        `- Verification: disk-write inspection + ${fw.buildCommand ? `\`${fw.buildCommand}\`` : "build skipped (no build command)"}.`
      );
    } else {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- This repository has no test infrastructure (no runner, no test files).`,
        `- Do NOT attempt \`npm test\`, \`npm run test\`, \`eslint\`, or any test/lint command as a verification proxy. Lint is not test.`,
        `- Verification: disk-write inspection + ${fw.buildCommand ? `\`${fw.buildCommand}\`` : "build skipped (no build command)"}.`
      );
    }

    if (fw.subProjects?.length) {
      fwLines.push(``, `- Sub-projects: ${fw.subProjects.map((s) => s.framework).join(", ")}`);
    }
  }
  // Project memory: <repo>/.zone/memory.md, populated via the update_memory tool.
  // Best-effort read — a missing/corrupt file just returns no entries.
  let projectMemoryBlock = "";
  try {
    const memoryEntries = await readMemory(input.repoPath);
    projectMemoryBlock = formatMemoryForPrompt(memoryEntries);
    if (memoryEntries.length > 0) {
      debugLog(
        `[zone-memory] injected ${memoryEntries.length} entries into agent system prompt`
      );
    }
  } catch (err) {
    debugLog("[zone-memory] read failed", err);
  }

  const subagentKind = input.subagent?.type;
  const agentIntro =
    isChatMode
      ? `You are Zone in chat mode.`
      : isInvestigationMode
      ? `You are Zone in read-only investigation mode.`
      : subagentKind === "explore"
      ? buildExploreAgentIntro()
      : subagentKind === "worker"
        ? buildWorkerAgentIntro()
        : `You are Zone, an AI code agent${fw?.framework ? ` working on a ${fw.framework} project` : ""}.`;
  const canRunCommand = toolsForLLM.some((t) => getZoneToolName(t) === "run_command");
  const backgroundCommandBlock = canRunCommand
    ? `\nBACKGROUND COMMANDS: for long-lived processes (npm run dev, vite, watchers, tail -f), use \`run_command_background\` — returns a handle so you can keep working. Poll output with \`read_background_output\` (pass since_offset from the prior read to get only new bytes). \`kill_background\` when done; processes are also auto-killed at run end. Poll sparingly (every 2-3 iters, not every iter). One-shot commands (build, test, lint, tsc, pytest) → \`run_command\`.\n\n`
    : "";
  const planProgressBlock = `PLAN VISIBILITY (TodoWrite):
Call TodoWrite once near the start of any task with 2+ tool calls, with 2-6 short steps. Shown to the user as a live sidebar.
Rules:
- Send the COMPLETE list every call — it replaces the prior list.
- Exactly ONE step in_progress at any moment.
- Before starting a step, flip it to in_progress. After it succeeds, flip it to completed AND the next to in_progress in the SAME call.
- If the plan changes, call TodoWrite again with the revised list.
A patch task with verification (build/tests/screenshot) is always multi-step — call TodoWrite. Skip only for genuine one-shot answers.
Example:
  TodoWrite({ todos: [
    { id: "1", content: "Locate the failing test", status: "in_progress" },
    { id: "2", content: "Patch the bug", status: "pending" },
    { id: "3", content: "Re-run the suite", status: "pending" },
  ]})`;

  const baseSystemContent = isChatMode
    ? assembleChatSystemPrompt({
        repoPath: input.repoPath,
        projectMemoryBlock,
        baseMaxIterations,
      })
    : isInvestigationMode
      ? assembleInvestigationSystemPrompt({
        repoPath: input.repoPath,
        projectMemoryBlock,
        baseMaxIterations,
        agentIntro,
      })
      : assembleAgentSystemPrompt({
        agentIntro,
        frameworkLines: fwLines,
        hasFramework: !!fw,
        projectMemoryBlock,
        importContextSummary: input.importContextSummary,
        baseMaxIterations,
        canRunCommand,
        backgroundCommandBlock,
        repoPath: input.repoPath,
        planProgressBlock,
        planAnnotationsBlock: buildPlanAnnotationsBlock(input.executionPlan),
        auditFindings: input.auditFindings,
      });
  // X.0.1: mode prefix relocated out of system head to keep the system prompt
  // byte-stable across explicit/implicit mode calls. Mode signal is appended
  // to the user message tail instead; system prompt is always baseSystemContent.
  const systemContent = baseSystemContent;

  // J.5: when a prior run's summary is threaded in, prepend it to the user
  // message as a labeled framing block. The agent's system prompt
  // documents the PRIOR RUN CONTEXT convention, so the agent reads
  // APPLY_ROLLED_BACK markers from previous attempts before investigating.
  const priorRun = String(input.priorRunSummary ?? "").trim();
  // X.0.1: when audit findings are present, inject them after PRIOR RUN CONTEXT
  // and before the task so the execute agent trusts the audit and does not
  // re-investigate ground it already covered.
  const af = input.auditFindings;
  let auditContextBlock = "";
  if (af) {
    const lines: string[] = [
      "--- AUDIT CONTEXT ---",
      "An audit phase has already investigated this task. The structured findings below are authoritative.",
      "",
      `Metadata: cost=$${af.costUsd.toFixed(4)}, tool_calls=${af.toolCallCount}, citations=${af.citationCount}`,
    ];
    if (af.scopeVerdict) {
      lines.push(`Verdict: ${af.scopeVerdict} | Severity: ${af.severity ?? "none"}`);
    }
    if (af.filesAlreadyRead && af.filesAlreadyRead.length > 0) {
      lines.push("");
      lines.push("Files already investigated (do not re-read unless directly contradicted by other evidence):");
      for (const f of af.filesAlreadyRead) lines.push(`- ${f}`);
    }
    if (af.citations && af.citations.length > 0) {
      lines.push("");
      lines.push("Cited evidence:");
      for (const c of af.citations) lines.push(`- ${c.file}${c.line !== undefined ? `:${c.line}` : ""}`);
    }
    if (af.rootCause) {
      lines.push("");
      lines.push(`Root cause: ${af.rootCause}`);
    }
    if (af.fixInstruction) {
      lines.push("");
      lines.push(`Fix instruction: ${af.fixInstruction}`);
    }
    if (af.filesToEdit && af.filesToEdit.length > 0) {
      lines.push("");
      lines.push("Files to edit:");
      for (const f of af.filesToEdit) lines.push(`- ${f}`);
    }
    if (af.evidence) {
      lines.push("");
      lines.push(`Evidence: ${af.evidence}`);
    }
    lines.push("");
    lines.push("Findings:");
    lines.push(af.summary);
    lines.push("--- END AUDIT CONTEXT ---");
    auditContextBlock = lines.join("\n") + "\n\n";
  }
  const modeTag = hasExplicitMode ? `\n\n--- mode: ${mode} ---` : "";
  const userContent = (priorRun
    ? (
        "PRIOR RUN CONTEXT — your last attempt in this thread produced this result:\n" +
        priorRun +
        "\nEND PRIOR RUN CONTEXT.\n\n" +
        auditContextBlock +
        input.task
      )
    : auditContextBlock + input.task) + modeTag;

  // Chat Completions messages (system + user kickoff).
  const responseInput: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: userContent,
    },
  ];

  const client = createLLMClient({ apiKey: input.userApiKey });
  const requestCtx = getRequestContext();
  let iterCostAccumulator: IterCostAccumulator = emptyIterCostAccumulator();
  let lastIterCostPayload: IterCostUpdatePayload | null = null;
  let lastCallModel: string | null = null;
  let loopTokenUsage: SubagentTokenUsage = emptySubagentTokenUsage();
  let subagentTokenTotal = 0;
  let subagentCostTotal = 0;
  const detectorState = createDetectorState();
  // R.1: accumulate per-call breakdown events for the end-of-run summary.
  const breakdownEvents: BreakdownEvent[] = [];
  // Phase V: mutable counters for self-validation hooks; passed by reference to executeTool.
  const selfValidationCounts = {
    readBeforePatchRejects: 0,
    smartQuoteFixes: 0,
    inlineTsRejects: 0,
    inlineTsApproves: 0,
    inlineTsSkips: 0,
    totalLatencyMs: 0,
  };
  // Phase V.1: Set of filePaths successfully read_file'd this run.
  // Populated after each successful read_file; passed to executeTool for C1 gate.
  const filesReadThisRun = new Set<string>();
  const tokenBudgetBaseTokens = cleanTokenNumber(input.tokenBudgetBaseTokens);
  // P.1: compaction trigger — fires at the safe iteration boundary after tool results
  // are processed. No-op in P.1; P.2 replaces the stub with real summarization.
  const compactor = new ContextCompactor();
  // U.1 Commit 3: cache-aware R.2 pruning. When R.2 would newly prune messages
  // (blocksReplaced increases), reusing the prior pruning state preserves the
  // Anthropic prefix cache — avoiding a cache miss that costs more than the token
  // savings from pruning. prevR2PrunedMessages is the pruned array from the last
  // call; new messages beyond its length are always taken fresh from responseInput.
  let prevR2BlocksReplaced = 0;
  let prevR2PrunedMessages: ChatCompletionMessageParam[] | null = null;
  // Y.1.6.3/Y.1.6.4: retry event callback threaded into LLM call options so
  // withExponentialBackoff can emit SSE narration and record retry telemetry
  // without coupling the adapter layer to the run context.
  const onRetryEvent = (event: string, payload: Record<string, unknown>): void => {
    if (event === "llm_retry_in_progress") {
      input.onProgress?.(JSON.stringify({
        type: "llm_retry_in_progress",
        runId: input.runId ?? null,
        title: "Upstream API slow, retrying…",
        status: "active",
        ...payload,
      }));
    } else if (event === "zone_llm_retry_attempt") {
      // UI.3.c: forward per-attempt retry info as llm_retry_in_progress with isPerAttempt flag.
      input.onProgress?.(JSON.stringify({
        type: "llm_retry_in_progress",
        runId: input.runId ?? null,
        title: "LLM retry",
        status: "warning",
        isPerAttempt: true,
        ...payload,
      }));
    } else if (event === "zone_llm_retry_started" && !input.subagent && input.runId) {
      const userId =
        typeof input.userId === "string" && input.userId.trim()
          ? input.userId.trim()
          : "local-dev";
      recordRunRetry({ userId, runId: input.runId.trim() }).catch(() => {});
    }
  };

  // Usage recording is centralized in RecordingLLMClient (src/llm/recordingClient.ts):
  // every chat completion across the codebase appends one JSONL record. agentLoop
  // used to accumulate-then-record-on-exit, but that double-counted with the wrapper
  // and missed every other LLM call site (planner, intent, final report, etc.).

  const mainAgentTokens = (): number =>
    iterCostAccumulator.input_uncached +
    iterCostAccumulator.cache_read +
    iterCostAccumulator.cache_write +
    iterCostAccumulator.output;

  const cumulativeTokens = (): number =>
    tokenBudgetBaseTokens + mainAgentTokens() + subagentTokenTotal;

  const currentTokenUsage = (): SubagentTokenUsage => ({
    input: loopTokenUsage.input,
    output: loopTokenUsage.output,
    cached: loopTokenUsage.cached,
    total: loopTokenUsage.total,
    perIter: [...(loopTokenUsage.perIter ?? [])],
  });

  const emitTokenBudgetStatus = (iterNumber: number): number => {
    const mainTokens = mainAgentTokens();
    const totalTokens = tokenBudgetBaseTokens + mainTokens + subagentTokenTotal;
    const breakdown = input.subagent
      ? {
          mainAgent: tokenBudgetBaseTokens,
          subagents: mainTokens + subagentTokenTotal,
        }
      : {
          mainAgent: tokenBudgetBaseTokens + mainTokens,
          subagents: subagentTokenTotal,
        };
    const tokenBudgetRatio =
      effectiveTokenBudgetCap > 0 ? totalTokens / effectiveTokenBudgetCap : 0;
    debugLog("[zone-token-budget]", JSON.stringify({
      iter: iterNumber,
      cumulativeTokens: totalTokens,
      cap: effectiveTokenBudgetCap,
      ratio: Number(tokenBudgetRatio.toFixed(3)),
      breakdown,
    }));
    if (typeof input.runId === "string" && input.runId.trim()) {
      input.onStructuredEvent?.({
        type: "token_budget_status",
        title: "Token budget",
        cumulativeTokens: totalTokens,
        tokenBudgetCap: effectiveTokenBudgetCap,
        tokenBudgetRatio,
        iter: iterNumber,
        breakdown,
        status:
          tokenBudgetRatio >= TOKEN_BUDGET_HARD
            ? "error"
            : tokenBudgetRatio >= TOKEN_BUDGET_WARN
              ? "warning"
              : "active",
      });
    }
    return tokenBudgetRatio;
  };

  const synthesizeTokenBudgetExit = async (
    iterNumber: number,
    messages: ChatCompletionMessageParam[]
  ): Promise<AgentLoopResult> => {
    const tokensAtExit = cumulativeTokens();
    input.onProgress?.(
      `[agent_loop] Token budget reached (${tokensAtExit}/${effectiveTokenBudgetCap}) — synthesizing final answer`
    );
    let finalSummary =
      "Token budget reached before a final answer was produced.";
    try {
      const { pruned: wrapupPruned } = pruneStaleReads(messages);
      const wrapupResponse = await client.createChatCompletion(
        {
          model: isInvestigationMode
            ? getModelForRole("investigator", client.provider as "anthropic" | "openai")
            : getModelName("high", client.provider, requestCtx?.modelOverride),
          messages: [
            ...wrapupPruned,
            {
              role: "user",
              content:
                "You have reached the token budget for this run. " +
                "Stop calling tools and synthesize your findings into a final answer " +
                "using only the information already gathered. " +
                "If insufficient information was gathered, say so explicitly. " +
                (isReadOnlyMode
                  ? "Do not mention patches or verification."
                  : "Mention which steps remain incomplete."),
            },
          ],
        },
        { signal: input.abortSignal }
      );
      const ae = extractResponsesApiOutputText(wrapupResponse);
      if (ae.ok && ae.text.trim()) finalSummary = ae.text.trim();
    } catch {
      // Use fallback summary.
    }
    debugLog("[zone-token-budget-exit]", JSON.stringify({
      iter: iterNumber,
      cumulativeTokens: tokensAtExit,
      finalTextLength: finalSummary.length,
    }));
    emitRunBreakdownSummary();
    emitCacheSummary();
    emitSelfValidationSummary();
    return {
      success: false,
      summary: finalSummary,
      toolCallLog,
      filesModified: Array.from(filesModified),
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "token_budget_exceeded",
      tokenUsage: currentTokenUsage(),
      costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
    };
  };

  const synthesizeCompactionExhaustedExit = (
    iterNumber: number,
    _messages: ChatCompletionMessageParam[]
  ): AgentLoopResult => {
    const msg =
      "Task aborted: context exhausted via compaction. " +
      "The conversation has been compacted to its safety limit. " +
      "To continue, please break this task into smaller subtasks.";
    debugLog("[zone-compaction-exhausted]", JSON.stringify({
      iter: iterNumber,
      runId: input.runId,
      compactionCount: compactor.getCompactionCount(),
    }));
    emitRunBreakdownSummary();
    emitCacheSummary();
    emitSelfValidationSummary();
    return {
      success: false,
      summary: msg,
      toolCallLog,
      filesModified: Array.from(filesModified),
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "compaction_exhausted",
      tokenUsage: currentTokenUsage(),
      costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
    };
  };

  const synthesizeLoopDetectedExit = (
    iterNumber: number,
    toolName: string,
    count: number
  ): AgentLoopResult => {
    const msg = `Task aborted: loop detected. The agent called \`${toolName}\` with the same arguments ${count} times in a short window. Consider rephrasing the task or restricting scope.`;
    debugLog("[zone-loop-detected]", JSON.stringify({ iter: iterNumber, runId: input.runId, toolName, count }));
    emitRunBreakdownSummary();
    emitCacheSummary();
    emitSelfValidationSummary();
    return {
      success: false,
      summary: msg,
      toolCallLog,
      filesModified: Array.from(filesModified),
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "loop_detected",
      loopDetected: { toolName, count },
      tokenUsage: currentTokenUsage(),
      costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
    };
  };

  // R.1: emit the run-level summary at every exit path.
  const emitRunBreakdownSummary = (): void => {
    if (breakdownEvents.length > 0) {
      emitBreakdownSummary({ runId: input.runId ?? "", events: breakdownEvents });
    }
  };

  // U.1: emit per-run cache summary at every exit path.
  const emitCacheSummary = (): void => {
    if (iterCostAccumulator.cache_read === 0 && iterCostAccumulator.cache_write === 0) return;
    log("[zone-cache-summary]", JSON.stringify({
      event: "cache_run_summary",
      runId: input.runId ?? null,
      agentModel: lastCallModel,
      totalIters: iterCostAccumulator.iter_count,
      totalWrite: iterCostAccumulator.cache_write,
      totalRead: iterCostAccumulator.cache_read,
      totalInputUncached: iterCostAccumulator.input_uncached,
      totalOutput: iterCostAccumulator.output,
      cacheHitRatio: Number(cacheHitRatio(iterCostAccumulator).toFixed(3)),
      totalCostUsd: iterCostAccumulator.total_cost,
    }));
  };

  // Phase V Commit 4: emit per-run self-validation summary at every exit path.
  const emitSelfValidationSummary = (): void => {
    const { readBeforePatchRejects, smartQuoteFixes, inlineTsRejects, inlineTsApproves, totalLatencyMs } = selfValidationCounts;
    if (readBeforePatchRejects + smartQuoteFixes + inlineTsRejects + inlineTsApproves === 0) return;
    log("[zone-self-validation-summary]", JSON.stringify({
      runId: input.runId ?? null,
      readBeforePatchRejects,
      smartQuoteFixes,
      inlineTsRejects,
      inlineTsApproves,
      inlineTsSkips: selfValidationCounts.inlineTsSkips,
      totalLatencyMs,
      ts: new Date().toISOString(),
    }));
  };

  const throwIfAborted = (stage: string): void => {
    if (input.abortSignal?.aborted) {
      debugLog("[zone-agent-aborted]", {
        runId: input.runId,
        stage,
        timestamp: new Date().toISOString(),
      });
      throw new DOMException("Run aborted", "AbortError");
    }
  };

  let lastNarrationEmitted = "";

  for (let iter = 0; iter < iterationBudget.maxIterationsForRun; iter += 1) {
    debugLog("[zone-agent-iter-start]", {
      runId: input.runId,
      iter,
      abortSignal: !!input.abortSignal,
      abortAlready: input.abortSignal?.aborted ?? false,
      timestamp: new Date().toISOString(),
    });
    throwIfAborted("iter_start");
    input.onProgress?.(
      `[agent_loop] Iteration ${iter + 1}/${iterationBudget.maxIterationsForRun}`
    );

    if (softIterWarnThreshold !== undefined && iter >= softIterWarnThreshold && !softWarnInjected) {
      softWarnInjected = true;
      responseInput.push({
        role: "user",
        content: `[ZONE_ITER_SOFT_WARN] You have used ${iter} iterations. The cost ceiling will terminate this run — wrap up your work and write a final summary now.`,
      });
      log("[zone-iter-soft-warn-injected]", JSON.stringify({ iter, softIterWarnThreshold, runId: input.runId ?? null }));
    }

    // Phase I Lane 2.1: one-shot mid-run budget pressure injection at 70%.
    // Fires before the LLM call so the agent has agency to converge (write
    // pending deliverables) rather than continue expanding. Independent of the
    // 80% UI warn and 95% hard exit — those remain unchanged.
    if (!midWarnInjected && effectiveTokenBudgetCap > 0 &&
        cumulativeTokens() / effectiveTokenBudgetCap >= TOKEN_BUDGET_MID_WARN) {
      midWarnInjected = true;
      const midWarnRatio = cumulativeTokens() / effectiveTokenBudgetCap;
      responseInput.push({
        role: "user",
        content:
          "You are at 70% of token budget. Pause expansive reads. " +
          "If a primary deliverable (e.g., test file requested in the original task) is not yet " +
          "written, write it now even if implementation is incomplete. Remaining iterations should " +
          "converge, not explore.",
      });
      log("[zone-token-budget-mid-warn]", JSON.stringify({
        runId: input.runId ?? null,
        iter,
        tokenRatio: Number(midWarnRatio.toFixed(3)),
        ts: new Date().toISOString(),
      }));
    }

    debugLog("[zone-agent-llm-pre]", {
      runId: input.runId,
      iter,
      abortAlready: input.abortSignal?.aborted ?? false,
    });
    const promptCacheKey =
      client.provider === "openai"
        ? buildOpenAIPromptCacheKey(input.runId, input.conversationId)
        : undefined;
    const modelName = isInvestigationMode
      ? getModelForRole("investigator", client.provider as "anthropic" | "openai")
      : getModelName("high", client.provider, requestCtx?.modelOverride);

    // R.2: prune stale read results from the messages copy sent to the API.
    // responseInput itself is not mutated — future iterations keep appending.
    const { pruned: freshlyPruned, stats: pruneStats } = pruneStaleReads(responseInput);
    emitContextPruned({ runId: input.runId ?? "", iter, stats: pruneStats });

    // U.1 Commit 3: if new pruning would change the prefix, preserve the last stable
    // pruned state and only append genuinely new messages. This keeps the Anthropic
    // prefix cache intact (hitting the last cached state) at the cost of sending a
    // few extra tokens for the not-yet-pruned messages.
    let prunedMessages: ChatCompletionMessageParam[];
    if (pruneStats.blocksReplaced > prevR2BlocksReplaced && prevR2PrunedMessages !== null) {
      const newCount = responseInput.length - prevR2PrunedMessages.length;
      prunedMessages = newCount > 0
        ? [...prevR2PrunedMessages, ...responseInput.slice(-newCount)]
        : prevR2PrunedMessages;
      log("[zone-cache-r2-skip]", JSON.stringify({
        event: "cache_r2_skip",
        runId: input.runId ?? null,
        iter: iter + 1,
        prevBlocks: prevR2BlocksReplaced,
        newBlocks: pruneStats.blocksReplaced,
        newMessages: newCount,
      }));
    } else {
      prunedMessages = freshlyPruned;
      prevR2BlocksReplaced = pruneStats.blocksReplaced;
      prevR2PrunedMessages = freshlyPruned;
    }

    // E.3: per-iter file-read manifest injection. Appended to prunedMessages (not
    // responseInput) so it does not accumulate across iterations. Only emitted when
    // the run has actually read at least one file. Follows the same user-message
    // injection pattern as softIterWarn / midWarn for prefix-cache stability.
    {
      const classified = classifyTurns(responseInput, toolCallLog);
      const { manifest, entryCount } = buildFileReadManifest(responseInput, classified);
      if (entryCount > 0) {
        log("[zone-file-manifest-injected]", JSON.stringify({
          iter: iter + 1,
          entryCount,
          runId: input.runId ?? null,
        }));
        prunedMessages = [
          ...prunedMessages,
          {
            role: "user" as const,
            content:
              `## Files already read this run\n${manifest}\n\n` +
              `Re-read ONLY if the file was modified since your last read.\n` +
              `Reference prior content by line number instead of re-reading.`,
          },
        ];
      }
    }

    // R.1: emit per-call token breakdown (on the pruned view, which is what the LLM sees).
    const bdEvent = emitTokenBreakdown({
      runId: input.runId ?? "",
      parentRunId: input.subagent?.parentRunId,
      subagentId: input.subagent?.id,
      iter,
      messages: prunedMessages,
      tools: toolsForLLM,
      model: modelName,
    });
    breakdownEvents.push(bdEvent);

    // Phase F1: streaming tool-input callbacks for write-class tools.
    // F1.4: subagent loops tag their stream events with subagentId so the
    // UI can prefix the slot label as "↳ worker N is writing...".
    const streamStartedBlocks = new Set<string>();
    const _streamSubagentId = input.subagent?.id ?? null;
    const onToolArgumentsDelta = input.onToolInputStream
      ? (toolCallId: string, toolName: string, argDelta: string) => {
          if (toolName !== "apply_patch" && toolName !== "write_file") return;
          const isFirstDelta = !streamStartedBlocks.has(toolCallId);
          if (isFirstDelta) streamStartedBlocks.add(toolCallId);
          input.onToolInputStream!({
            blockId: toolCallId,
            toolName,
            delta: argDelta,
            isFirstDelta,
            iter: iter + 1,
            subagentId: _streamSubagentId,
          });
        }
      : undefined;

    let response: Awaited<ReturnType<typeof client.createChatCompletion>>;
    try {
      response = await client.createChatCompletion(
        {
          model: modelName,
          messages: prunedMessages,
          tools: toolsForLLM,
          tool_choice: "auto",
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        },
        { signal: input.abortSignal, onToolArgumentsDelta, onRetryEvent }
      );
    } catch (llmErr: unknown) {
      if (llmErr instanceof UpstreamUnavailableError) {
        emitRunBreakdownSummary();
        emitCacheSummary();
        emitSelfValidationSummary();
        return {
          success: false,
          summary: "LLM API unavailable after retries.",
          toolCallLog,
          filesModified: Array.from(filesModified),
          patchValidatedByAgent: false,
          verificationReason: "no_verification_attempted",
          terminationReason: "upstream_unavailable",
          tokenUsage: currentTokenUsage(),
          costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
        };
      }
      throw llmErr;
    }
    debugLog("[zone-agent-llm-post]", {
      runId: input.runId,
      iter,
      abortAlready: input.abortSignal?.aborted ?? false,
    });
    const rawUsage = (response as { usage?: unknown }).usage;
    const tokenUsageThisIter = extractTokenUsageForBudget(rawUsage);
    if (tokenUsageThisIter.total > 0) {
      loopTokenUsage = {
        input: loopTokenUsage.input + tokenUsageThisIter.input,
        output: loopTokenUsage.output + tokenUsageThisIter.output,
        cached: loopTokenUsage.cached + tokenUsageThisIter.cached,
        total: loopTokenUsage.total + tokenUsageThisIter.total,
        perIter: [...(loopTokenUsage.perIter ?? []), tokenUsageThisIter.total],
      };
      if (input.subagent) {
        log("[zone-worker-token]", JSON.stringify({
          subagentId: input.subagent.id,
          parentRunId: input.subagent.parentRunId,
          iter,
          iterTotal: tokenUsageThisIter.total,
          cumulativeTotal: loopTokenUsage.total,
        }));
      }
    }
    try {
      const usage = extractUsage(rawUsage);
      const runId = typeof input.runId === "string" ? input.runId.trim() : "";
      if (usage && runId) {
        const update = buildIterCostUpdate({
          runId,
          iter: iter + 1,
          totalIter: iterationBudget.maxIterationsForRun,
          provider: client.provider,
          model: response.model || modelName,
          current: usage,
          previous: iterCostAccumulator,
        });
        iterCostAccumulator = update.accumulator;
        lastIterCostPayload = update.payload;
        lastCallModel = response.model || modelName;
        input.onStructuredEvent?.(update.payload);
      }
    } catch (err) {
      debugLog("[zone-iter-cost-update-failed]", err);
    }
    // U.1: per-call cache JSONL — always-on when there is cache activity.
    if (
      lastIterCostPayload !== null &&
      (lastIterCostPayload.cache_write > 0 || lastIterCostPayload.cache_read > 0)
    ) {
      log("[zone-cache-usage]", JSON.stringify({
        event: "cache_call_usage",
        runId: input.runId ?? null,
        iter: iter + 1,
        model: lastCallModel,
        write: lastIterCostPayload.cache_write,
        read: lastIterCostPayload.cache_read,
        input_uncached: lastIterCostPayload.input_uncached,
        output: lastIterCostPayload.output,
        cacheHitRatio: Number(lastIterCostPayload.cacheHitThisIter.toFixed(3)),
      }));
    }

    // Phase H.7: per-run token budget. Sums all token categories tracked by
    // the iter-cost meter (input_uncached + cache_read + cache_write +
    // output) and compares against TOKEN_BUDGET_CAP. Once usage crosses
    // TOKEN_BUDGET_HARD (95%), the loop terminates gracefully via a final
    // no-tools synthesis call.
    const tokenBudgetRatio = emitTokenBudgetStatus(iter + 1);

    if (tokenBudgetRatio >= TOKEN_BUDGET_HARD) {
      return await synthesizeTokenBudgetExit(iter + 1, responseInput);
    }

    throwIfAborted("after_llm");

    const assistantContentForProgress = response.choices[0]?.message?.content ?? "";
    for (const marker of parseTodoProgressMarkers(assistantContentForProgress)) {
      input.onStructuredEvent?.({
        type: "todo_status_changed",
        todoId: marker.todoId,
        todoStatus: marker.status,
      });
    }

    // Extract tool calls first so narration can be skipped on the final iter.
    // On the final iter (no tool calls) the assistant text IS the answer —
    // emitting it as narration would duplicate it against the formal
    // chatResponse / run_completed_with_result bubble rendered by the UI.
    const toolCalls = extractFunctionCallItems(response);

    // Forward the LLM's plain-language text (between tool_calls) as a
    // `narration` event so the UI can interleave intent statements with tool
    // rows. Strip internal bracketed markers (TODO/step/verification/agent_loop)
    // so they don't bleed into user-facing prose. Guard toolCalls.length > 0
    // so the final answer (no tool calls) is never emitted as narration.
    const narrationText = String(assistantContentForProgress)
      .replace(/\[(?:TODO|step|ZONE_VERIFICATION|AGENT_LOOP)[^\]]*\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      narrationText &&
      narrationText.length >= 8 &&
      narrationText !== lastNarrationEmitted &&
      typeof input.runId === "string" &&
      input.runId.trim() &&
      toolCalls.length > 0
    ) {
      lastNarrationEmitted = narrationText;
      input.onStructuredEvent?.({
        type: "narration",
        title: narrationText.slice(0, 200),
        text: narrationText.slice(0, 2000),
        iter: iter + 1,
        status: "active",
      });
    }

    if (toolCalls.length > 0) {
      // Push the assistant message with all tool_calls ONCE before processing them.
      // Chat-completions protocol requires the assistant message with tool_calls to
      // precede every role:"tool" message that references those call ids.
      const assistantContent = response.choices[0]?.message?.content ?? null;
      responseInput.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
      });
      let failureDetected = false;
      let failedToolName = "";
      let failedToolOutput = "";
      let failedToolError = "";
      let failedToolFilePath: string | null = null;
      const failedFilesThisIter = new Set<string>();

      for (const call of toolCalls) {
        const name = call.function.name;
        const callId = call.id;
        const argsString = call.function.arguments ?? "";
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = argsString
            ? (JSON.parse(argsString) as Record<string, unknown>)
            : {};
        } catch {
          parsedArgs = {};
        }

        if (effectiveAllowedTools && !effectiveAllowedTools.has(name)) {
          const allowed = [...effectiveAllowedTools];
          const rejectionMsg =
            `Tool "${name}" is not allowed in this mode. ` +
            `Available tools: ${allowed.join(", ")}.`;
          responseInput.push({
            role: "tool",
            tool_call_id: callId,
            content: rejectionMsg,
          });
          toolCallLog.push({
            id: callId,
            tool: name,
            args: parsedArgs,
            result: rejectionMsg,
            success: false,
          });
          debugLog("[zone-allowed-tools-reject]", {
            tool: name,
            allowed,
          });
          continue;
        }

        if (name === "TodoWrite" && input.disableTodoWrite) {
          const rejectionMsg = "TodoWrite rejected: TodoWrite is disabled for this read-only investigation run.";
          responseInput.push({
            role: "tool",
            tool_call_id: callId,
            content: rejectionMsg,
          });
          toolCallLog.push({
            id: callId,
            tool: name,
            args: parsedArgs,
            result: rejectionMsg,
            success: false,
          });
          continue;
        }

        if (name === "TodoWrite") {
          const validation = validateTodoWriteArgs(parsedArgs);
          if (!validation.ok) {
            const rejectionMsg = `TodoWrite rejected: ${validation.error}`;
            responseInput.push({
              role: "tool",
              tool_call_id: callId,
              content: rejectionMsg,
            });
            toolCallLog.push({
              id: callId,
              tool: name,
              args: parsedArgs,
              result: validation.error,
              success: false,
            });
            continue;
          }
          const isFirstEmission = !todosEmittedThisRun;
          todosEmittedThisRun = true;
          input.onStructuredEvent?.({
            type: isFirstEmission ? "todos_initialized" : "todo_revised",
            title: isFirstEmission ? "Plan initialized" : "Plan revised",
            status: "success",
            todos: validation.normalized,
          });
          const okMsg = `Plan ${isFirstEmission ? "initialized" : "revised"} with ${validation.normalized.length} step(s).`;
          responseInput.push({
            role: "tool",
            tool_call_id: callId,
            content: okMsg,
          });
          toolCallLog.push({
            id: callId,
            tool: name,
            args: parsedArgs,
            result: "ok",
            success: true,
          });
          continue;
        }

        // Phase AS: suggest_scope_change records a scope mismatch proposal.
        // Outside investigation mode it is a no-op — the revision workflow only
        // runs during the audit phase; discarding the call here is safe.
        if (name === "suggest_scope_change" && !isInvestigationMode) {
          debugLog("[zone-tool-misuse]", JSON.stringify({ tool: "suggest_scope_change", mode }));
          const noopMsg = "suggest_scope_change is only active in investigation mode — call ignored.";
          responseInput.push({ role: "tool", tool_call_id: callId, content: noopMsg });
          toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: noopMsg, success: false });
          continue;
        }
        if (name === "suggest_scope_change") {
          const scopeType = parsedArgs["type"];
          const scopeReason = parsedArgs["reason"];
          const revisedPlanSummary = parsedArgs["revised_plan_summary"];
          const missingFiles = Array.isArray(parsedArgs["missing_files"]) ? parsedArgs["missing_files"] as string[] : [];
          const unnecessaryFiles = Array.isArray(parsedArgs["unnecessary_files"]) ? parsedArgs["unnecessary_files"] as string[] : [];

          const validTypes = ["under_scope", "over_scope", "mixed"];
          if (!validTypes.includes(String(scopeType)) || !scopeReason || !revisedPlanSummary) {
            const errMsg = "suggest_scope_change rejected: missing required fields (type, reason, revised_plan_summary).";
            responseInput.push({ role: "tool", tool_call_id: callId, content: errMsg });
            toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: errMsg, success: false });
            continue;
          }

          if (scopeType === "under_scope" && missingFiles.length === 0) {
            const errMsg = "suggest_scope_change rejected: missing_files required for under_scope.";
            responseInput.push({ role: "tool", tool_call_id: callId, content: errMsg });
            toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: errMsg, success: false });
            continue;
          }
          if (scopeType === "over_scope" && unnecessaryFiles.length === 0) {
            const errMsg = "suggest_scope_change rejected: unnecessary_files required for over_scope.";
            responseInput.push({ role: "tool", tool_call_id: callId, content: errMsg });
            toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: errMsg, success: false });
            continue;
          }

          debugLog("[zone-scope-revision-proposed]", JSON.stringify({
            runId: input.runId || null,
            type: scopeType,
            missingCount: missingFiles.length,
            unnecessaryCount: unnecessaryFiles.length,
            ts: new Date().toISOString(),
          }));

          input.onStructuredEvent?.({
            type: "suggest_scope_change",
            scopeChangeType: scopeType,
            reason: String(scopeReason),
            missingFiles,
            unnecessaryFiles,
            revisedPlanSummary: String(revisedPlanSummary),
          });

          const ackMsg = "Scope change proposal recorded. Investigation can continue.";
          responseInput.push({ role: "tool", tool_call_id: callId, content: ackMsg });
          toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: ackMsg, success: true });
          continue;
        }

        // Phase F: revert_patch — agent-initiated file revert. Removes the file
        // from stagingFiles so finalizeStaging won't flush new content to disk;
        // original disk content (pre-run state) is preserved automatically.
        if (name === "revert_patch") {
          const rawPath = typeof parsedArgs["path"] === "string" ? parsedArgs["path"] : null;
          if (!rawPath) {
            const errMsg = "revert_patch rejected: missing required field 'path'.";
            responseInput.push({ role: "tool", tool_call_id: callId, content: errMsg });
            toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: errMsg, success: false });
            continue;
          }
          const relPath = rawPath.replace(/^[\\/]+/, "");
          const abs = path.resolve(path.join(input.repoPath, relPath));
          if (!stagingFiles.has(abs)) {
            const errMsg = `revert_patch rejected: '${relPath}' was not modified in this run.`;
            responseInput.push({ role: "tool", tool_call_id: callId, content: errMsg });
            toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: errMsg, success: false });
            continue;
          }
          stagingFiles.delete(abs);
          filesModified.delete(relPath);
          log("[zone-revert-patch-invoked]", JSON.stringify({ runId: input.runId ?? null, path: relPath, success: true }));
          const revertOkMsg = `Reverted: '${relPath}' restored to its pre-run state.`;
          responseInput.push({ role: "tool", tool_call_id: callId, content: revertOkMsg });
          toolCallLog.push({ id: callId, tool: name, args: parsedArgs, result: revertOkMsg, success: true });
          continue;
        }

        input.onToolCall?.(name, parsedArgs);

        // Diagnostic: log every tool call before execution
        debugLog("[zone-agent-tool-call]", JSON.stringify({
          iter: iter + 1,
          tool: name,
          filePath: parsedArgs.filePath ?? null,
          patchPreview:
            typeof parsedArgs.patch === "string"
              ? parsedArgs.patch.slice(0, 400)
              : null,
          contentLength:
            typeof parsedArgs.content === "string"
              ? parsedArgs.content.length
              : null,
          command: parsedArgs.command ?? null,
        }));

        // Phase Q.3: log Task dispatch reason for traceability. Extracted
        // from the first line of the description per agent coaching.
        if (name === "Task") {
          const dispatchReason = extractDispatchReason(parsedArgs.description);
          const dispatchSubagentType =
            typeof parsedArgs.subagent_type === "string" ? parsedArgs.subagent_type : null;
          const dispatchProvider = getRequestContext()?.provider ?? "openai";
          const dispatchWorkerModel =
            dispatchSubagentType === "worker"
              ? getModelForRole("worker", dispatchProvider)
              : null;
          log("[zone-subagent-dispatched]", JSON.stringify({
            event: "subagent_dispatched",
            parentRunId: input.runId ?? null,
            subagentType: dispatchSubagentType,
            workerModel: dispatchWorkerModel,
            dispatchReason,
            iter: iter + 1,
          }));
        }

        if (name === "apply_patch") {
          const targetFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
          if (targetFilePath && !wasFileReadOrWritten(toolCallLog, targetFilePath)) {
            debugLog("[zone-apply-patch-no-read-first]", JSON.stringify({
              filePath: targetFilePath,
              iter: iter + 1,
              blocked: true,
            }));
            const syntheticOutput =
              `Block 1: You haven't read this file yet in this run. ` +
              `Call read_file on ${targetFilePath} first to see the exact current content, ` +
              `then issue apply_patch with FIND lines that match the file verbatim.`;
            toolCallLog.push({
              id: callId,
              tool: name,
              args: parsedArgs,
              result: syntheticOutput,
              success: false,
            });
            // Chat Completions protocol: assistant tool_call already pushed above.
            // Each tool_call needs exactly one matching role:"tool" reply.
            responseInput.push({
              role: "tool",
              tool_call_id: callId,
              content: syntheticOutput,
            });
            failureDetected = true;
            failedToolName = name;
            failedToolOutput = syntheticOutput;
            failedToolError = "apply_patch_no_read_first";
            failedToolFilePath = targetFilePath;
            // Mirror the same failure tracking that real apply_patch failures get.
            // Without this, backup sweep / repeat detection never sees the blocked file
            // and the agent can drift to other files without returning.
            failedFilesThisIter.add(targetFilePath);
            const noReadTrigger = classifyFailure(
              name,
              syntheticOutput,
              "apply_patch_no_read_first"
            );
            const noReadPatchHash = hashPatchBlocks(parsedArgs);
            const noReadList = failureHistory.get(targetFilePath) ?? [];
            noReadList.push({
              trigger: noReadTrigger,
              errorLine: null,
              patchHash: noReadPatchHash,
              iter: iter + 1,
            });
            failureHistory.set(targetFilePath, noReadList);
            continue;
          }
        }

        const rid = String(input.runId || "").trim();
        debugLog("[zone-agent-tool-pre]", {
          runId: input.runId,
          iter,
          tool: name,
          abortAlready: input.abortSignal?.aborted ?? false,
        });
        throwIfAborted("before_tool");
        const result = await executeTool(name, parsedArgs, input.repoPath, input.onProgress, {
          runId: rid || undefined,
          onApprovalRequired: async (command, runId) => {
            const { requestCommandApproval } = await import("../api/commandApprovals.js");
            const approval = await requestCommandApproval({
              runId,
              command,
              emit: (evt) => input.onStructuredEvent?.(evt),
              abortSignal: input.abortSignal,
            });
            return !!approval.approved;
          },
          escalatedFiles,
          allowWriteFileOverwritePaths: escalatedFiles,
          stagingFiles,
          abortSignal: input.abortSignal,
          executionPlan: input.executionPlan ?? null,
          allowedTools: effectiveAllowedTools,
          userId: input.userId,
          framework: input.framework,
          subagent: input.subagent,
          onToolCall: input.onToolCall,
          onToolResult: input.onToolResult,
          onStructuredEvent: input.onStructuredEvent,
          // F1.4: forward the streaming callback so the Task tool dispatch
          // can pass it on to the worker subagent's runAgentLoop. Worker
          // tool-input deltas then flow back through the parent's SSE
          // channel, tagged with the worker's subagentId.
          onToolInputStream: input.onToolInputStream,
          tokenBudgetBaseTokens: name === "Task" ? cumulativeTokens() : undefined,
          maxSubagentCallsOverride: effectiveMaxSubagentCalls ?? undefined,
          selfValidationCounts,
          filesReadThisRun,
        });
        debugLog("[zone-agent-tool-post]", {
          runId: input.runId,
          iter,
          tool: name,
          abortAlready: input.abortSignal?.aborted ?? false,
        });
        throwIfAborted("after_tool");
        input.onToolResult?.(name, result);

        // Diagnostic: log every tool result after execution
        debugLog("[zone-agent-tool-result]", JSON.stringify({
          iter: iter + 1,
          tool: name,
          success: result.success,
          outputPreview: result.output.slice(0, 300),
          error: result.error ?? null,
        }));

        // Detect failures from any tool â€” feeds coaching-prompt router.
        // All tools: failure iff result.success === false (exit code for run_command,
        // explicit success bool for others). Output-content heuristics removed â€”
        // they produced false positives on passing Next.js builds whose stderr
        // contains tokens like "_global-error" or "FAIL".
        const toolFailed = !result.success;
        if (toolFailed) {
          failureDetected = true;
          failedToolName = name;
          failedToolOutput = result.output;
          failedToolError = result.error ?? "";
          failedToolFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
        }

        toolCallLog.push({
          id: callId,
          tool: name,
          args: parsedArgs,
          result: result.output.slice(0, 4000),
          success: result.success,
        });

        // Phase V.1: track successfully-read file paths for C1 gate in executeTool.
        if (name === "read_file" && result.success && typeof parsedArgs.filePath === "string" && parsedArgs.filePath) {
          filesReadThisRun.add(parsedArgs.filePath);
        }

        if (name === "apply_patch" && !result.success) {
          const parsedFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
          if (parsedFilePath) failedFilesThisIter.add(parsedFilePath);
          const filePath = parsedFilePath ?? "unknown";
          const classifiedTrigger = classifyFailure(name, result.output, result.error);
          const trigger =
            classifiedTrigger === "apply_patch_semantic_smell"
              ? extractSemanticSmellName(result.output)
              : classifiedTrigger;
          const errorLine = extractErrorLine(result.output);
          const patchHash = hashPatchBlocks(parsedArgs);
          const list = failureHistory.get(filePath) ?? [];
          list.push({ trigger, errorLine, patchHash, iter: iter + 1 });
          failureHistory.set(filePath, list);
        }

        if (
          (name === "write_file" || name === "apply_patch") &&
          parsedArgs.filePath != null
        ) {
          filesModified.add(String(parsedArgs.filePath));
        }
        if (name === "Task" && result.success) {
          try {
            const parsed = JSON.parse(result.output) as Partial<SubagentResult>;
            if (Array.isArray(parsed.filesModified)) {
              for (const filePath of parsed.filesModified) {
                if (typeof filePath === "string" && filePath.trim()) {
                  filesModified.add(filePath.trim());
                }
              }
            }
            const tokenUsage = parsed.tokenUsage;
            const subagentTotal = cleanTokenNumber(tokenUsage?.total);
            if (subagentTotal > 0) {
              subagentTokenTotal += subagentTotal;
              const mainTokensAfter = mainAgentTokens();
              const cumulativeAfter = mainTokensAfter + subagentTokenTotal;
              log("[zone-subagent-token-propagated]", JSON.stringify({
                mainRunId: input.runId,
                subagentId: parsed.subagentId,
                subagentTotal,
                subagentInput: cleanTokenNumber(tokenUsage?.input),
                subagentOutput: cleanTokenNumber(tokenUsage?.output),
                mainCumulativeAfter: cumulativeAfter,
                cap: effectiveTokenBudgetCap,
                ratio: effectiveTokenBudgetCap > 0 ? cumulativeAfter / effectiveTokenBudgetCap : 0,
              }));
              const ratioAfterTask = emitTokenBudgetStatus(iter + 1);
              if (ratioAfterTask >= TOKEN_BUDGET_HARD) {
                responseInput.push({
                  role: "tool",
                  tool_call_id: callId,
                  content: result.output,
                });
                return await synthesizeTokenBudgetExit(iter + 1, responseInput);
              }
            }
            // K.6: subagent cost propagation (parallel to K.3 token propagation above)
            const subagentCostUsd =
              typeof parsed.costUsd === "number" && parsed.costUsd > 0 ? parsed.costUsd : 0;
            if (subagentCostUsd > 0) {
              subagentCostTotal += subagentCostUsd;
              log("[zone-subagent-cost-propagated]", JSON.stringify({
                mainRunId: input.runId,
                subagentId: parsed.subagentId,
                subagentCostUsd,
                mainCumulativeCostAfter: iterCostAccumulator.total_cost + subagentCostTotal,
              }));
              if (lastIterCostPayload && typeof input.runId === "string" && input.runId.trim()) {
                input.onStructuredEvent?.({
                  ...lastIterCostPayload,
                  iterCost: 0,
                  cumulativeCost: iterCostAccumulator.total_cost + subagentCostTotal,
                });
              }
            }
          } catch {
            // Best-effort only. Task summaries are user-visible tool content,
            // but modified-file aggregation should not make the loop fail.
          }
        }

        // Chat Completions: each tool_call gets one matching role:"tool" reply.
        // The assistant message with tool_calls was pushed before the loop.
        responseInput.push({
          role: "tool",
          tool_call_id: callId,
          content: result.output,
        });

        // Phase Q.2: runtime loop detection
        const loopHash = hashToolCall(name, parsedArgs);
        const loopResult = recordAndDetect(detectorState, loopHash);
        if (loopResult.status === "warn") {
          input.onStructuredEvent?.({
            type: "loop_warning_emitted",
            toolName: name,
            count: loopResult.count,
            title: `Loop warning: \`${name}\` repeated ${loopResult.count}×`,
            status: "warning",
          } as Parameters<NonNullable<typeof input.onStructuredEvent>>[0]);
          responseInput.push({
            role: "user" as const,
            content: `Notice: you have called \`${name}\` with the same arguments ${loopResult.count} times in the last few iterations. This suggests a loop. Try a different approach — use a different tool, different scope, ask the user for clarification, or finish with a partial explanation.`,
          });
        } else if (loopResult.status === "terminate") {
          input.onStructuredEvent?.({
            type: "loop_detected_terminal",
            toolName: name,
            count: loopResult.count,
            title: `Loop detected: \`${name}\` repeated ${loopResult.count}×`,
            status: "error",
          } as Parameters<NonNullable<typeof input.onStructuredEvent>>[0]);
          return synthesizeLoopDetectedExit(iter + 1, name, loopResult.count);
        }
      }

      // â"€â"€ Self-correction: failure detected â†’ route to coaching prompt â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // Each self-correction attempt consumes one iteration toward maxIterations.
      // The selfCorrectionAttempts counter is a SUBSET of total iterations â€”
      // it limits how many times we inject coaching, not how many total iterations run.
      // This way a long but successful run won't hit the coaching budget.
      let repeatPattern: { filePath: string; reason: string } | null = null;
      if (failureDetected && failedToolName === "apply_patch") {
        repeatPattern = detectRepeatedFailure(failureHistory, failedToolFilePath);
        if (!repeatPattern) {
          for (const filePath of failedFilesThisIter) {
            if (filePath === failedToolFilePath) continue;
            const candidate = detectRepeatedFailure(failureHistory, filePath);
            if (candidate) {
              repeatPattern = candidate;
              break;
            }
          }
        }
      }
      const failedFilePath = failedToolName === "apply_patch" ? failedToolFilePath : null;
      const pickedFromBackupSweep =
        repeatPattern !== null && repeatPattern.filePath !== failedToolFilePath;
      if (failureDetected && selfCorrectionAttempts < MAX_SELF_CORRECTION_ATTEMPTS) {
        selfCorrectionAttempts += 1;
        let routedTrigger: SelfCorrectTrigger;
        if (repeatPattern) {
          routedTrigger = "apply_patch_repeated_failure_same_file";
          escalatedFiles.add(repeatPattern.filePath);
          input.onProgress?.(JSON.stringify({
            event: "zone-agent-repeat-detected",
            filePath: repeatPattern.filePath,
            reason: repeatPattern.reason,
            attempts: failureHistory.get(repeatPattern.filePath)?.length ?? 0,
          }));
          if (escalationEnabled) {
            iterationBudget = maybeGrantEscalationBonus(
              iterationBudget,
              escalatedFiles.size,
              iter,
              input.onProgress,
              baseMaxIterations
            );
          }
        } else {
          routedTrigger = classifyFailure(failedToolName, failedToolOutput, failedToolError);
        }
        const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
        const perFileAttempt = routedFilePath
          ? failureHistory.get(routedFilePath)?.length ?? 0
          : 0;
        // agent-persistence Tur: build a structured diagnostic prelude
        // (parsed failingFile/line/errorType + generated-path indicator +
        // candidate culprits) and inject it ABOVE the coaching directives.
        // Generated-path detection also flips the test_failed coaching into
        // its mandatory-investigation variant inside buildCoachingPrompt.
        const diagnostic = buildVerifyDiagnostic({
          failedToolOutput,
          filesModified: Array.from(filesModified),
          filesInRepo: Array.isArray(input.repoFilePaths) ? input.repoFilePaths : [],
          framework: input.framework
            ? { framework: input.framework.framework, language: input.framework.language }
            : null,
          attemptCount: selfCorrectionAttempts,
        });
        // scope-expansion Tur: when the diagnostic parser pinned a concrete
        // user-source failing file, expand the plan's covered set so the
        // agent's next apply_patch can land. Mutates plan in-place; persists
        // for the rest of this run (and across orchestrator step boundaries
        // because the plan reference is shared).
        const scopeExpansion = maybeExpandScopeForVerifyDiagnostic(
          input.executionPlan ?? null,
          diagnostic,
          input.repoPath
        );
        let diagnosticText = diagnostic.text;
        if (scopeExpansion.expanded && scopeExpansion.addedFile) {
          diagnosticText +=
            `\n\n**Scope expanded**: \`${scopeExpansion.addedFile}\` has been added to the writable scope ` +
            `for this run because the verification parser pinned it as the failing file. Apply your patch directly.`;
          debugLog("[zone-scope-expanded]", JSON.stringify({
            runId: input.runId ?? null,
            addedFile: scopeExpansion.addedFile,
            reason: scopeExpansion.reason,
            parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
            parsedErrorType: diagnostic.parsed?.errorType ?? null,
            attempt: selfCorrectionAttempts,
          }));
        }
        const coachingText = buildCoachingPrompt(
          routedTrigger,
          failedToolOutput,
          toolCallLog,
          {
            attemptCount: perFileAttempt || selfCorrectionAttempts,
            filePath: routedFilePath ?? undefined,
            generatedPathDetected: diagnostic.generatedPathDetected,
            parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
          }
        );
        const remaining = MAX_SELF_CORRECTION_ATTEMPTS - selfCorrectionAttempts;
        debugLog("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
          filePath: routedFilePath,
          perFileAttempt,
          detectedRepeatedFailure: repeatPattern !== null,
          repeatReason: repeatPattern?.reason ?? null,
          iterationCap: iterationBudget.maxIterationsForRun,
          failedFilesThisIterCount: failedFilesThisIter.size,
          pickedFromBackupSweep,
          errorPreview: failedToolOutput.slice(0, 200),
          willRetry: true,
          reason: "routed_coaching_prompt_injected",
        }));
        // S.2.1: structured JSONL diagnostic for apply_patch retries.
        if (failedToolName === "apply_patch") {
          log("[zone-apply-patch-retry]", JSON.stringify({
            event: "apply_patch_retry",
            runId: input.runId ?? null,
            iter: iter + 1,
            reason: applyPatchRetryReason(routedTrigger),
            filePath: routedFilePath ?? null,
            attemptCount: perFileAttempt || selfCorrectionAttempts,
          }));
        }
        // U.2.C: emit coaching rule trigger for test failures so we can observe
        // scope-check decisions (in_scope / out_of_scope) in production logs.
        if (routedTrigger === "test_failed" || routedTrigger === "tool_command_spawn_failure") {
          const parsedFailingFile = diagnostic.parsed?.failingFile ?? null;
          const modifiedFiles = Array.from(filesModified);
          const inScope = parsedFailingFile
            ? modifiedFiles.some(
                (f) =>
                  f === parsedFailingFile ||
                  f.endsWith("/" + parsedFailingFile) ||
                  parsedFailingFile.endsWith("/" + f)
              )
            : null;
          log("[zone-coaching-rule]", JSON.stringify({
            event: "coaching_rule_trigger",
            runId: input.runId ?? null,
            iter: iter + 1,
            rule: "test_failure_scope_check",
            decision: inScope === null ? "unclear" : inScope ? "in_scope" : "out_of_scope",
            parsedFailingFile,
            modifiedFiles,
          }));
        }
        debugLog("[zone-agent-diagnostic]", JSON.stringify({
          attempt: selfCorrectionAttempts,
          failingFile: diagnostic.parsed?.failingFile ?? null,
          failingLine: diagnostic.parsed?.failingLine ?? null,
          errorType: diagnostic.parsed?.errorType ?? null,
          generatedPathDetected: diagnostic.generatedPathDetected,
          candidateCount: diagnostic.candidates.length,
          candidatesPreview: diagnostic.candidates.slice(0, 5),
        }));
        input.onProgress?.(
          `[agent_loop] Failure detected (${routedTrigger}) â€” self-correction attempt ${selfCorrectionAttempts}/${MAX_SELF_CORRECTION_ATTEMPTS}`
        );
        responseInput.push({
          role: "user",
          content:
            `[Zone coaching â€” attempt ${selfCorrectionAttempts} of ${MAX_SELF_CORRECTION_ATTEMPTS}]\n` +
            diagnosticText + `\n\n` +
            coachingText +
            `\n\nRecent failure context:\n` +
            `- Tool: ${failedToolName}\n` +
            `- Error preview (first 300 chars): ${failedToolOutput.slice(0, 300)}\n` +
            `You have ${remaining} retry attempt${remaining === 1 ? "" : "s"} remaining. ` +
            `After that the run will halt with the current state.`,
        });
      } else if (failureDetected) {
        // Budget exhausted â€” log and let the model produce its final summary naturally.
        const routedTrigger = repeatPattern
          ? "apply_patch_repeated_failure_same_file"
          : classifyFailure(failedToolName, failedToolOutput, failedToolError);
        const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
        const perFileAttempt = routedFilePath
          ? failureHistory.get(routedFilePath)?.length ?? 0
          : 0;
        debugLog("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
          filePath: routedFilePath,
          perFileAttempt,
          detectedRepeatedFailure: repeatPattern !== null,
          repeatReason: repeatPattern?.reason ?? null,
          iterationCap: iterationBudget.maxIterationsForRun,
          failedFilesThisIterCount: failedFilesThisIter.size,
          pickedFromBackupSweep,
          errorPreview: failedToolOutput.slice(0, 200),
          willRetry: false,
          reason: "self-correction budget exhausted â€” allowing model to summarise",
        }));
      }

      // P.2/P.3: compaction check with graceful exhausted exit.
      let compactionResult: CompactionResult;
      try {
        compactionResult = await compactor.checkAndMaybeCompact({
          responseInput,
          toolCallLog,
          currentUsage: cumulativeTokens(),
          effectiveCap: effectiveTokenBudgetCap,
          client,
          runId: input.runId,
        });
      } catch (err) {
        if (err instanceof CompactionExhaustedError) {
          input.onStructuredEvent?.({
            type: "compaction_exhausted",
            message: "Task aborted: context exhausted via compaction. Break this task into smaller subtasks.",
          });
          return synthesizeCompactionExhaustedExit(iter + 1, responseInput);
        }
        throw err;
      }
      if (compactionResult.compacted && compactionResult.newResponseInput) {
        // In-place mutation preserves the array reference held by the outer scope.
        responseInput.splice(0, responseInput.length, ...compactionResult.newResponseInput);
        input.onProgress?.(
          `Context compacted (compaction #${compactor.getCompactionCount()})`
        );
        log("[zone-compaction-status]", JSON.stringify({
          event: "compaction_status",
          count: compactor.getCompactionCount(),
          reason: compactionResult.reason ?? "success",
        }));
        input.onStructuredEvent?.({
          type: "compaction_status",
          count: compactor.getCompactionCount(),
        });
      }
      if (compactionResult.warning) {
        input.onProgress?.(compactionResult.warning);
      }

      continue;
    }

    const extracted = extractResponsesApiOutputText(response);
      if (extracted.ok && extracted.text.trim()) {
      const finalText = extracted.text.trim();
      if (isReadOnlyMode) {
        emitRunBreakdownSummary();
        emitCacheSummary();
        emitSelfValidationSummary();
        return {
          success: true,
          summary: finalText,
          toolCallLog,
          filesModified: [],
          patchValidatedByAgent: false,
          verificationReason: "no_verification_attempted",
          terminationReason: "natural_completion",
          tokenUsage: currentTokenUsage(),
          costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
        };
      }
      const vrMatch = finalText.match(/\[ZONE_VERIFICATION:\s*([\w_]+)\]/i);
      const vrRaw = vrMatch ? vrMatch[1].toLowerCase() : 'no_verification_attempted';
      const validReasons: VerificationReason[] = [
        'tests_passed', 'tests_skipped_no_infra', 'tests_inconclusive',
        'tests_failed_unrelated', 'tests_failed_by_patch', 'no_verification_attempted',
        'verification_failed_staged',
        'no_changes_made',
      ];
      let verificationReason: VerificationReason =
        (validReasons as string[]).includes(vrRaw)
          ? (vrRaw as VerificationReason)
          : 'no_verification_attempted';
      if (verificationReason === "tests_passed") {
        const passedValidation = validatePassedClaim(
          toolCallLog,
          input.framework ? { hasTests: input.framework.hasTests } : undefined
        );
        if (!passedValidation.accept) {
          verificationReason = passedValidation.demoteTo ?? "tests_inconclusive";
          input.onProgress?.(JSON.stringify({
            event: "zone-agent-verdict-override",
            triggeredBy: "natural_completion",
            originalVerdict: "tests_passed",
            overriddenTo: verificationReason,
            reason: passedValidation.reason,
          }));
          debugLog("[zone-agent-verdict-override]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_passed",
            overriddenTo: verificationReason,
            reason: passedValidation.reason,
          }));
        }
      }
      if (verificationReason === "tests_failed_unrelated") {
        const verdictValidation = validateUnrelatedClaim({
          log: toolCallLog,
          patchedFilePaths: Array.from(filesModified),
          framework: input.framework
            ? { hasTests: input.framework.hasTests }
            : undefined,
        });
        if (!verdictValidation.accept) {
          verificationReason = verdictValidation.demoteTo ?? "tests_inconclusive";
          debugLog("[zone-agent-verdict-override]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_failed_unrelated",
            overriddenTo: verdictValidation.demoteTo,
            reason: verdictValidation.reason,
          }));
        } else if (
          verdictValidation.reason &&
          /resolved by a later successful run_command/i.test(verdictValidation.reason)
        ) {
          // Bug 44b: failure was demonstrably resolved by a later successful
          // run_command. Promote the verdict from `tests_failed_unrelated` to
          // `tests_passed` so the UI doesn't render a "tests failed" chip
          // alongside a "safe to apply" badge.
          verificationReason = "tests_passed";
          debugLog("[zone-agent-verdict-promote]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_failed_unrelated",
            promotedTo: "tests_passed",
            reason: verdictValidation.reason,
          }));
        }
      }
      verificationReason = applyNoInfraVerificationOverride({
        verificationReason,
        framework: input.framework
          ? {
              hasTests: input.framework.hasTests,
              testFilesDetected: input.framework.testFilesDetected,
            }
          : undefined,
        patchApplied: didApplyPatch(toolCallLog),
        triggeredBy: "natural_completion",
      });
      let patchValidatedByAgent =
        verificationReason === 'tests_passed' ||
        verificationReason === 'tests_skipped_no_infra' ||
        verificationReason === 'tests_failed_unrelated';
      debugLog("[zone-staging-state]", JSON.stringify({
        stagedFileCount: stagingFiles.size,
        stagedFiles: Array.from(stagingFiles.keys()).map((abs) => path.basename(abs)),
        // staging-flush-bug diag: full absolute paths surface symlink/realpath drift
        stagedAbsPaths: Array.from(stagingFiles.keys()),
      }));
      emitRunBreakdownSummary();
      emitCacheSummary();
      emitSelfValidationSummary();
      log("[zone-agent-final-assessment]", JSON.stringify({
        triggeredBy: "natural_completion",
        verificationReason,
        patchValidatedByAgent,
        inferredFrom: vrMatch ? "tag" : "heuristic",
        summaryPreview: finalText.slice(0, 200),
      }));
      const finalizeResult = ownsStagingFiles
        ? await finalizeStaging({
            stagingFiles,
            repoPath: input.repoPath,
            framework: input.framework,
            withStagingTempFlush,
            verifyMode,
          })
        : {
            flushed: false,
            verification: {
              status: "skipped" as const,
              reason: "subagent_deferred_to_parent",
            },
            filesFlushed: 0,
            flushFailures: 0,
          };
      let summaryAppendix = "";
      if (finalizeResult.verification.status === "fail") {
        // Phase J.3: distinguish regression (patch introduced new errors,
        // staging discarded, "rolled back" UI) from pre-existing failure
        // (patch flushed anyway, errors weren't its fault).
        if (finalizeResult.verification.regressed === false) {
          verificationReason = "tests_inconclusive";
          patchValidatedByAgent = false;
          summaryAppendix =
            "\n\n**Verification has pre-existing errors** (" +
            finalizeResult.verification.label +
            ", " + finalizeResult.verification.durationMs + "ms).\n" +
            "Patch was applied because it didn't add any new errors " +
            `(${finalizeResult.verification.postErrorCount ?? "?"} errors before, ` +
            `${finalizeResult.verification.postErrorCount ?? "?"} errors after).`;
        } else if (verifyMode === "rollback") {
          verificationReason = "verification_regressed";
          patchValidatedByAgent = false;
          const errors = parseTscErrorPreview(finalizeResult.verification.errorPreview);
          const restoredFiles = finalizeResult.discardedStaging
            ? Array.from(finalizeResult.discardedStaging.keys()).map((abs) =>
                path.relative(input.repoPath, abs) || abs
              )
            : [];
          const rolledBackBody = buildApplyRolledBackMessage({
            filePath: restoredFiles.length === 1 ? (restoredFiles[0] ?? "<staged file>") : "<multiple>",
            errors,
            restoredFiles,
          });
          summaryAppendix = "\n\n" + rolledBackBody;
          log("[zone-apply-rolled-back-feedback]", JSON.stringify({
            site: "natural_completion",
            label: finalizeResult.verification.label,
            durationMs: finalizeResult.verification.durationMs,
            baselineErrorCount: finalizeResult.verification.baselineErrorCount,
            postErrorCount: finalizeResult.verification.postErrorCount,
            errorCount: errors.length,
            filePathsRestored: restoredFiles,
            runId: input.runId ?? null,
          }));
          log("[zone-apply-rolled-back-marker]", JSON.stringify(
            buildApplyRolledBackMarkerLog({
              site: "natural_completion",
              markerMessage: rolledBackBody,
              errors,
              filePathsRestored: restoredFiles,
              runId: input.runId ?? null,
            })
          ));
        } else {
          // Phase F warn mode: patches on disk, surface errors as warnings.
          verificationReason = "verification_warnings"; // Phase F.2 warn-mode: patches on disk; reason distinguishes from true rollback so downstream UI doesn't claim disk-restore.
          patchValidatedByAgent = false;
          const errors = parseTscErrorPreview(finalizeResult.verification.errorPreview);
          summaryAppendix = "\n\n" + buildVerificationWarningsMessage({
            errors,
            filesFlushed: finalizeResult.filesFlushed,
            baselineErrorCount: finalizeResult.verification.baselineErrorCount,
            postErrorCount: finalizeResult.verification.postErrorCount,
          });
          log("[zone-verify-warn-surfaced]", JSON.stringify({
            site: "natural_completion",
            label: finalizeResult.verification.label,
            durationMs: finalizeResult.verification.durationMs,
            baselineErrorCount: finalizeResult.verification.baselineErrorCount,
            postErrorCount: finalizeResult.verification.postErrorCount,
            errorCount: errors.length,
            runId: input.runId ?? null,
          }));
        }
      } else if (
        finalizeResult.verification.status === "skipped" &&
        "reason" in finalizeResult.verification &&
        finalizeResult.verification.reason === "no_changes_made"
      ) {
        verificationReason = "no_changes_made";
        patchValidatedByAgent = false;
      }
      return {
        success: true,
        summary: finalText + summaryAppendix,
        toolCallLog,
        filesModified: Array.from(filesModified),
        patchValidatedByAgent,
        verificationReason,
        terminationReason: "natural_completion",
        tokenUsage: currentTokenUsage(),
        costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
        // Phase J.3.1: forward the staging snapshot so runLlmPatchFlow can
        // render the rolled-back diff. Only meaningful when
        // verificationReason === "verification_regressed".
        ...(finalizeResult.discardedStaging
          ? { discardedStaging: finalizeResult.discardedStaging }
          : {}),
      };
    }

    // If we got neither tool calls nor text, keep looping (rare).
  }

  if (isReadOnlyMode) {
    input.onProgress?.(
      isChatMode
        ? "[agent_loop] Max iterations reached - requesting final chat answer"
        : "[agent_loop] Max iterations reached - requesting final investigation answer"
    );
    let finalSummary = "Max iterations reached before a final answer was produced.";
    try {
      const assessmentResponse = await client.createChatCompletion({
        model: isInvestigationMode
          ? getModelForRole("investigator", client.provider as "anthropic" | "openai")
          : getModelName("high", client.provider, requestCtx?.modelOverride),
        messages: [
          ...responseInput,
          {
            role: "user",
            content:
              (isChatMode
                ? "You have reached the maximum number of chat iterations. "
                : "You have reached the maximum number of investigation iterations. ") +
              "Provide the best clear markdown answer you can from the files and search results already explored. " +
              "Do not call tools. Do not mention patches or verification.",
          },
        ],
      }, { signal: input.abortSignal });
      const ae = extractResponsesApiOutputText(assessmentResponse);
      if (ae.ok && ae.text.trim()) {
        finalSummary = ae.text.trim();
      }
    } catch {
      // Keep the fallback summary.
    }
    emitRunBreakdownSummary();
    emitCacheSummary();
    emitSelfValidationSummary();
    return {
      success: false,
      summary: finalSummary,
      toolCallLog,
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "max_iterations",
      tokenUsage: currentTokenUsage(),
      costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
    };
  }

  // Max iterations hit â€” request one final no-tool assessment call
  input.onProgress?.("[agent_loop] Max iterations reached â€” requesting final assessment");
  let finalVerificationReason: VerificationReason = inferVerificationFromLog(
    toolCallLog,
    input.framework
      ? {
          hasTests: input.framework.hasTests,
          testFilesDetected: input.framework.testFilesDetected,
        }
      : undefined
  );
  let inferredFrom: "tag" | "heuristic" = "heuristic";
  let finalSummary = "Max iterations reached";
  const grantedBonus = iterationBudget.escalationBonusGranted
    ? ` (including ${ESCALATION_BONUS_ITERATIONS} bonus iterations granted after escalation)`
    : "";
  const fwHint = (() => {
    const fw = input.framework;
    if (!fw) return "";
    if (!fw.hasTests) {
      return (
        `\n\nThis project has NO runnable test infrastructure ` +
        `(testCommand: "${fw.testCommand || "none"}", testFramework: "${fw.testFramework}"). ` +
        `If your patch was applied successfully, the correct verdict is ` +
        `[ZONE_VERIFICATION: tests_skipped_no_infra]. ` +
        `Do NOT use tests_inconclusive - there was no test attempt to be inconclusive about. ` +
        `Do NOT use no_verification_attempted - skipping is the correct behavior here.`
      );
    }
    return "";
  })();
  try {
    const assessmentResponse = await client.createChatCompletion({
      model: getModelName("high", client.provider, requestCtx?.modelOverride),
      messages: [
        ...responseInput,
        {
          role: "user",
          content:
            `You have reached the maximum number of iterations${grantedBonus}. ` +
            // P3: output reduction - cap the fallback assessment summary too.
            "Provide a 60-80 word final summary and include exactly one " +
            "[ZONE_VERIFICATION: <reason>] tag. " +
            "Do not use tables or recap details already visible in the diff. " +
            "Choose: tests_passed, tests_skipped_no_infra, tests_inconclusive, " +
            "tests_failed_unrelated, tests_failed_by_patch, or no_verification_attempted. " +
            "Use tests_inconclusive if tests failed due to environment issues " +
            "(spawn errors, ENOENT, missing script, missing deps). " +
            "Use tests_failed_by_patch ONLY if your patch caused the failure." +
            fwHint,
        },
      ],
    }, { signal: input.abortSignal });
    const ae = extractResponsesApiOutputText(assessmentResponse);
      if (ae.ok && ae.text.trim()) {
        finalSummary = ae.text.trim();
        const tagged = parseVerificationTag(finalSummary);
        if (tagged) {
          // Strip the tag from the text so downstream consumers (CLI, web UI) don't display it.
          finalSummary = stripVerificationTag(finalSummary);
          finalVerificationReason = tagged;
          inferredFrom = "tag";
          if (finalVerificationReason === "tests_passed") {
            const passedValidation = validatePassedClaim(
              toolCallLog,
              input.framework ? { hasTests: input.framework.hasTests } : undefined
            );
            if (!passedValidation.accept) {
              finalVerificationReason =
                passedValidation.demoteTo ?? "tests_inconclusive";
              input.onProgress?.(JSON.stringify({
                event: "zone-agent-verdict-override",
                triggeredBy: "max_iterations",
                originalVerdict: "tests_passed",
                overriddenTo: finalVerificationReason,
                reason: passedValidation.reason,
              }));
              debugLog("[zone-agent-verdict-override]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_passed",
                overriddenTo: finalVerificationReason,
                reason: passedValidation.reason,
              }));
            }
          }
          if (finalVerificationReason === "tests_failed_unrelated") {
            const verdictValidation = validateUnrelatedClaim({
              log: toolCallLog,
              patchedFilePaths: Array.from(filesModified),
              framework: input.framework
                ? { hasTests: input.framework.hasTests }
                : undefined,
            });
            if (!verdictValidation.accept) {
              finalVerificationReason =
                verdictValidation.demoteTo ?? "tests_inconclusive";
              debugLog("[zone-agent-verdict-override]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_failed_unrelated",
                overriddenTo: verdictValidation.demoteTo,
                reason: verdictValidation.reason,
              }));
            } else if (
              verdictValidation.reason &&
              /resolved by a later successful run_command/i.test(verdictValidation.reason)
            ) {
              // Bug 44b: see natural_completion site for rationale.
              finalVerificationReason = "tests_passed";
              debugLog("[zone-agent-verdict-promote]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_failed_unrelated",
                promotedTo: "tests_passed",
                reason: verdictValidation.reason,
              }));
            }
          }
        }
        finalVerificationReason = applyNoInfraVerificationOverride({
          verificationReason: finalVerificationReason,
          framework: input.framework
            ? {
                hasTests: input.framework.hasTests,
                testFilesDetected: input.framework.testFilesDetected,
              }
            : undefined,
          patchApplied: didApplyPatch(toolCallLog),
          triggeredBy: "max_iterations",
        });
      }
  } catch {
    // Best-effort â€” fall through with heuristic
  }

  let patchValidatedByAgent =
    finalVerificationReason === "tests_passed" ||
    finalVerificationReason === "tests_skipped_no_infra" ||
    finalVerificationReason === "tests_failed_unrelated";

  debugLog("[zone-staging-state]", JSON.stringify({
    stagedFileCount: stagingFiles.size,
    stagedFiles: Array.from(stagingFiles.keys()).map((abs) => path.basename(abs)),
  }));
  emitRunBreakdownSummary();
  emitCacheSummary();
  emitSelfValidationSummary();
  log("[zone-agent-final-assessment]", JSON.stringify({
    triggeredBy: "max_iterations",
    finalVerificationReason,
    inferredFrom,
    patchValidatedByAgent,
  }));

  const finalizeResult = ownsStagingFiles
    ? await finalizeStaging({
        stagingFiles,
        repoPath: input.repoPath,
        framework: input.framework,
        withStagingTempFlush,
        verifyMode,
      })
    : {
        flushed: false,
        verification: {
          status: "skipped" as const,
          reason: "subagent_deferred_to_parent",
        },
        filesFlushed: 0,
        flushFailures: 0,
      };
  if (finalizeResult.verification.status === "fail") {
    if (finalizeResult.verification.regressed === false) {
      finalVerificationReason = "tests_inconclusive";
      patchValidatedByAgent = false;
      finalSummary =
        finalSummary +
        "\n\n**Verification has pre-existing errors** (" +
        finalizeResult.verification.label +
        ", " + finalizeResult.verification.durationMs + "ms). " +
        "Patch was applied because it didn't add any new errors.";
    } else if (verifyMode === "rollback") {
      finalVerificationReason = "verification_regressed";
      patchValidatedByAgent = false;
      const errors = parseTscErrorPreview(finalizeResult.verification.errorPreview);
      const restoredFiles = finalizeResult.discardedStaging
        ? Array.from(finalizeResult.discardedStaging.keys()).map((abs) =>
            path.relative(input.repoPath, abs) || abs
          )
        : [];
      const rolledBackBody = buildApplyRolledBackMessage({
        filePath: restoredFiles.length === 1 ? (restoredFiles[0] ?? "<staged file>") : "<multiple>",
        errors,
        restoredFiles,
      });
      finalSummary = finalSummary + "\n\n" + rolledBackBody;
      log("[zone-apply-rolled-back-feedback]", JSON.stringify({
        site: "max_iterations",
        label: finalizeResult.verification.label,
        durationMs: finalizeResult.verification.durationMs,
        baselineErrorCount: finalizeResult.verification.baselineErrorCount,
        postErrorCount: finalizeResult.verification.postErrorCount,
        errorCount: errors.length,
        filePathsRestored: restoredFiles,
        runId: input.runId ?? null,
      }));
      log("[zone-apply-rolled-back-marker]", JSON.stringify(
        buildApplyRolledBackMarkerLog({
          site: "max_iter",
          markerMessage: rolledBackBody,
          errors,
          filePathsRestored: restoredFiles,
          runId: input.runId ?? null,
        })
      ));
    } else {
      // Phase F warn mode: patches on disk, surface errors as warnings.
      finalVerificationReason = "verification_warnings"; // Phase F.2 warn-mode: patches on disk; reason distinguishes from true rollback so downstream UI doesn't claim disk-restore.
      patchValidatedByAgent = false;
      const errors = parseTscErrorPreview(finalizeResult.verification.errorPreview);
      finalSummary = finalSummary + "\n\n" + buildVerificationWarningsMessage({
        errors,
        filesFlushed: finalizeResult.filesFlushed,
        baselineErrorCount: finalizeResult.verification.baselineErrorCount,
        postErrorCount: finalizeResult.verification.postErrorCount,
      });
      log("[zone-verify-warn-surfaced]", JSON.stringify({
        site: "token_budget_exceeded",
        label: finalizeResult.verification.label,
        durationMs: finalizeResult.verification.durationMs,
        baselineErrorCount: finalizeResult.verification.baselineErrorCount,
        postErrorCount: finalizeResult.verification.postErrorCount,
        errorCount: errors.length,
        runId: input.runId ?? null,
      }));
    }
  } else if (
    finalizeResult.verification.status === "skipped" &&
    "reason" in finalizeResult.verification &&
    finalizeResult.verification.reason === "no_changes_made"
  ) {
    finalVerificationReason = "no_changes_made";
    patchValidatedByAgent = false;
  }

  return {
    success: false,
    summary: finalSummary,
    toolCallLog,
    filesModified: [...filesModified],
    patchValidatedByAgent,
    verificationReason: finalVerificationReason,
    terminationReason: "token_budget_exceeded",
    tokenUsage: currentTokenUsage(),
    costUsd: iterCostAccumulator.total_cost + subagentCostTotal,
    // Phase J.3.1: forward the staging snapshot for the rolled-back diff
    // when safety-ceiling exit ended with a regressed-verification rollback.
    ...(finalizeResult.discardedStaging
      ? { discardedStaging: finalizeResult.discardedStaging }
      : {}),
  };
}
