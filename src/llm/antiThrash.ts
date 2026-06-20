import type { FailureRecord } from "./agentLoop.js";

export type AntiThrashSignalKind = "failure_stall" | "wandering" | "cost_burn" | "no_progress";

export interface AntiThrashSignal {
  pattern: AntiThrashSignalKind;
  summaryTitle: string;
  detail: Record<string, unknown>;
}

export type ErrorKeySnapshot = {
  iter: number;
  introducedKeys: string[];           // post-run error keys MINUS baseline keys, SORTED + stable.
  successfulAppliesAtCapture: number; // count of successful apply_patch/multi_edit at capture time.
  truncated?: boolean;                // feeder sets true when the run_command output was truncated.
};

export interface AntiThrashContext {
  iter: number;
  failureHistory: Map<string, FailureRecord[]>;
  coachingAttempts: number;
  filesReadCountThisRun: Map<string, number>;
  filesModifiedSize: number;
  isReadOnly: boolean;
  archetype: string | null | undefined;
  costUsd: number;
  recentVerifyKeySets?: ErrorKeySnapshot[];  // ring buffer, most-recent last. Optional: absent = no feeder data yet.
  stagedWriteCount?: number;                 // stagingFiles.size at ctx build time. Optional: absent = 0.
                                             // In P5/P6 contexts (filesModifiedSize===0) this equals the count
                                             // of files staged by multi_edit that have not been reverted.
                                             // Revert-aware: revert_patch removes from stagingFiles.
                                             // No-op multi_edits excluded: stagedWrite not called for 0 replacements.
}

export interface AntiThrashThresholds {
  failureCoachMin?: number;
  breakIters?: number;
  enabled?: boolean;
  wanderIterMin?: number;
  wanderReadMin?: number;
  costBurnIterMin?: number;
  costBurnUsd?: number;
  noProgressIterMin?: number;
  noProgressWindow?: number;
}

function readEnvInt(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function readEnvFloat(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === "0") return false;
  if (v === "1") return true;
  return fallback;
}

export const ANTI_THRASH_FAILURE_COACH_MIN = readEnvInt("ZONE_ANTI_THRASH_FAILURE_COACH_MIN", 2);
export const ANTI_THRASH_BREAK_ITERS        = readEnvInt("ZONE_ANTI_THRASH_BREAK_ITERS", 3);
export const ANTI_THRASH_ENABLED            = readEnvBool("ZONE_ANTI_THRASH", true);
export const ANTI_THRASH_NO_PROGRESS_ARMED  = readEnvBool("ZONE_ANTI_THRASH_NO_PROGRESS_ARMED", false);
export const ANTI_THRASH_WANDER_ITER_MIN    = readEnvInt("ZONE_ANTI_THRASH_WANDER_ITER_MIN", 8);
export const ANTI_THRASH_WANDER_READ_MIN    = readEnvInt("ZONE_ANTI_THRASH_WANDER_READ_MIN", 5);
export const ANTI_THRASH_COST_BURN_ITER_MIN    = readEnvInt("ZONE_ANTI_THRASH_COST_BURN_ITER_MIN", 10);
export const ANTI_THRASH_COST_BURN_USD         = readEnvFloat("ZONE_ANTI_THRASH_COST_BURN_USD", 1.00);
export const ANTI_THRASH_NO_PROGRESS_ITER_MIN  = readEnvInt("ZONE_ANTI_THRASH_NO_PROGRESS_ITER_MIN", 8);
export const ANTI_THRASH_NO_PROGRESS_WINDOW    = readEnvInt("ZONE_ANTI_THRASH_NO_PROGRESS_WINDOW", 2);

// Strong-verdict detection inlined to avoid a circular import with agentLoop.ts.
// Mirrors the identical_patch_retried and trigger_repeated_3x branches of
// detectRepeatedFailure() — the only two verdicts that signal thrash (not persistence).
// same_trigger_repeated_2x / same_root_cause_different_patch are deliberately excluded:
// those indicate the model is trying different approaches (persistence), not thrashing.
export function detectFailureStall(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  const coachMin = thresholds?.failureCoachMin ?? ANTI_THRASH_FAILURE_COACH_MIN;
  if (ctx.coachingAttempts < coachMin) return null;

  for (const [filePath, records] of ctx.failureHistory) {
    if (records.length < 2) continue;
    const last = records[records.length - 1]!;
    const prev = records[records.length - 2]!;

    // Verdict 1: identical patch retried — same trigger AND same normalized patch hash.
    // Self-clears the moment the model tries a different patch → free persistence guard.
    if (last.trigger === prev.trigger && last.patchHash === prev.patchHash) {
      return {
        pattern: "failure_stall",
        summaryTitle: `Repeated identical failures on ${filePath}`,
        detail: { filePath, verdict: "identical_patch_retried", coachingAttempts: ctx.coachingAttempts },
      };
    }

    // Verdict 2: trigger appears ≥3× total when last two have different triggers.
    // Only reached when last two triggers differ (earlier check would have fired otherwise).
    if (last.trigger !== prev.trigger) {
      const sameTriggerCount = records.filter((r) => r.trigger === last.trigger).length;
      if (sameTriggerCount >= 3) {
        return {
          pattern: "failure_stall",
          summaryTitle: `Repeated identical failures on ${filePath}`,
          detail: { filePath, verdict: "trigger_repeated_3x", coachingAttempts: ctx.coachingAttempts },
        };
      }
    }
  }
  return null;
}

export function detectWanderingSignal(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  if (ctx.isReadOnly) return null;
  if (ctx.archetype === "question" || ctx.archetype === "investigation") return null;
  // apply_patch/write_file progress is covered by filesModifiedSize (incl. revert subtraction at
  // agentLoop.ts:3717). stagedWriteCount adds the multi_edit signal that filesModified omits.
  // Both are revert-aware: revert_patch removes from filesModified AND stagingFiles respectively.
  if (ctx.filesModifiedSize !== 0 || (ctx.stagedWriteCount ?? 0) > 0) return null;

  const wanderIterMin = thresholds?.wanderIterMin ?? ANTI_THRASH_WANDER_ITER_MIN;
  const wanderReadMin = thresholds?.wanderReadMin ?? ANTI_THRASH_WANDER_READ_MIN;

  if (ctx.iter < wanderIterMin) return null;

  let totalReads = 0;
  for (const count of ctx.filesReadCountThisRun.values()) {
    totalReads += count;
  }
  if (totalReads < wanderReadMin) return null;

  const uniqueFiles = ctx.filesReadCountThisRun.size;
  let multiReadCount = 0;
  for (const count of ctx.filesReadCountThisRun.values()) {
    if (count > 1) multiReadCount++;
  }

  return {
    pattern: "wandering",
    summaryTitle: `Wandering: ${totalReads} reads across ${uniqueFiles} files, no writes`,
    detail: { uniqueFiles, totalReads, multiReadCount, iter: ctx.iter },
  };
}

export function detectCostBurnSignal(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  if (ctx.isReadOnly) return null;
  if (ctx.archetype === "question" || ctx.archetype === "investigation") return null;
  // Same guard as detectWanderingSignal: stagedWriteCount exempts runs writing via multi_edit.
  if (ctx.filesModifiedSize !== 0 || (ctx.stagedWriteCount ?? 0) > 0) return null;

  const costBurnIterMin = thresholds?.costBurnIterMin ?? ANTI_THRASH_COST_BURN_ITER_MIN;
  const costBurnUsd = thresholds?.costBurnUsd ?? ANTI_THRASH_COST_BURN_USD;

  if (ctx.iter < costBurnIterMin) return null;
  if (ctx.costUsd < costBurnUsd) return null;

  return {
    pattern: "cost_burn",
    summaryTitle: `Cost burn: $${ctx.costUsd.toFixed(3)} across ${ctx.iter} iters, no writes`,
    detail: { costUsd: ctx.costUsd, iter: ctx.iter },
  };
}

// P3: frozen-introduced-error-set detector.
// Discriminator vs P5/P6: P3 requires successful applies GROWING (active churn);
// P5/P6 require filesModifiedSize === 0. Do not break this mutual exclusion.
// Note: !isSubagentLoop is NOT checked here — that gate lives at the call sites
// (antiThrashHook.shouldRun + Stage-2 inline), matching P4/P5/P6 exactly.
export function detectNoProgressSignal(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  if (ctx.isReadOnly) return null;
  if (ctx.archetype === "question" || ctx.archetype === "investigation") return null;

  const iterMin = thresholds?.noProgressIterMin ?? ANTI_THRASH_NO_PROGRESS_ITER_MIN;
  const win     = thresholds?.noProgressWindow  ?? ANTI_THRASH_NO_PROGRESS_WINDOW;

  if (ctx.iter < iterMin) return null;

  // recentVerifyKeySets is optional — absent/undefined means no feeder data yet → null.
  const buffer = ctx.recentVerifyKeySets ?? [];
  if (buffer.length < win) return null;

  const recent = buffer.slice(-win);

  // Every snapshot must have a non-empty introduced-key-set.
  if (recent.some((s) => s.introducedKeys.length === 0)) return null;

  // All snapshots' key-sets must be byte-identical (frozen across the window).
  // introducedKeys is pre-sorted by the feeder → JSON.stringify comparison is stable.
  const firstKeys = JSON.stringify(recent[0]!.introducedKeys);
  if (recent.some((s) => JSON.stringify(s.introducedKeys) !== firstKeys)) return null;

  // Successful applies must have strictly grown (active churn, not stagnation).
  // P3 discriminator vs P5/P6: P3 requires applies GROWING; P5/P6 require filesModifiedSize===0.
  const first = recent[0]!;
  const last  = recent[recent.length - 1]!;
  if (last.successfulAppliesAtCapture <= first.successfulAppliesAtCapture) return null;

  const frozenKeys = recent[0]!.introducedKeys;
  const keyPreview = frozenKeys.slice(0, 3).join(", ") + (frozenKeys.length > 3 ? ", …" : "");
  return {
    pattern: "no_progress",
    summaryTitle: `No error-set progress: ${frozenKeys.length} introduced error(s) unchanged across ${win} iterations`,
    detail: {
      frozenKeyCount: frozenKeys.length,
      windowSize: win,
      successfulAppliesGrowth: last.successfulAppliesAtCapture - first.successfulAppliesAtCapture,
      keyPreview,
    },
  };
}

// Priority-ordered dispatch: P4 > P3 > P5 > P6.
export function computeAntiThrashSignal(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  if (!(thresholds?.enabled ?? ANTI_THRASH_ENABLED)) return null;
  return (
    detectFailureStall(ctx, thresholds) ??
    detectNoProgressSignal(ctx, thresholds) ??
    detectWanderingSignal(ctx, thresholds) ??
    detectCostBurnSignal(ctx, thresholds)
  );
}

export function buildStallReflectionText(signal: AntiThrashSignal): string {
  if (signal.pattern === "failure_stall") {
    const { filePath, verdict } = signal.detail as { filePath: string; verdict: string };
    return (
      `\n\n[ZONE_ANTI_THRASH] You have repeatedly failed to patch \`${filePath}\` ` +
      `with the same approach (${verdict}). You should now:\n` +
      `(a) Abandon this approach and try a fundamentally different implementation strategy.\n` +
      `(b) Use \`suggest_scope_change\` if this file is out of scope or requires a different path.\n` +
      `(c) Write the FINAL SUMMARY and exit if this file change is not essential to the task.\n` +
      `Do NOT retry the same patch.`
    );
  }
  if (signal.pattern === "wandering") {
    const { uniqueFiles, totalReads, multiReadCount, iter } = signal.detail as {
      uniqueFiles: number;
      totalReads: number;
      multiReadCount: number;
      iter: number;
    };
    return (
      `\n\n[ZONE_ANTI_THRASH] You have read ${totalReads} times across ${uniqueFiles} files ` +
      `(${multiReadCount} re-read) over ${iter} iterations without writing anything. ` +
      `You must now commit to an action:\n` +
      `(a) Apply a patch with your best current hypothesis — an imperfect change is better than more reading.\n` +
      `(b) Write the FINAL SUMMARY if this task requires no code change.\n` +
      `Do NOT keep reading without committing to an action.`
    );
  }
  if (signal.pattern === "cost_burn") {
    const { costUsd, iter } = signal.detail as { costUsd: number; iter: number };
    return (
      `\n\n[ZONE_ANTI_THRASH] You have spent $${costUsd.toFixed(3)} across ${iter} iterations ` +
      `without writing anything. You must now commit to an action:\n` +
      `(a) Apply a patch or write a file implementing your current hypothesis — stop exploring and act.\n` +
      `(b) Write the FINAL SUMMARY and exit if no code change is needed.\n` +
      `Do NOT continue without committing to an action.`
    );
  }
  if (signal.pattern === "no_progress") {
    const { frozenKeyCount, windowSize, successfulAppliesGrowth, keyPreview } = signal.detail as {
      frozenKeyCount: number;
      windowSize: number;
      successfulAppliesGrowth: number;
      keyPreview: string;
    };
    return (
      `\n\n[ZONE_ANTI_THRASH] You have applied ${successfulAppliesGrowth} patch(es) but the same ` +
      `${frozenKeyCount} error(s) you introduced this run have persisted unchanged across the last ` +
      `${windowSize} iterations: ${keyPreview}. The current strategy is not clearing them — ` +
      `change approach:\n` +
      `(a) Try a fundamentally different fix (revert this approach and re-plan from the original error).\n` +
      `(b) Write the FINAL SUMMARY if the remaining errors are acceptable or pre-existing.\n` +
      `Do NOT keep patching with the same strategy.`
    );
  }
  return `\n\n[ZONE_ANTI_THRASH] Non-progress detected: ${signal.summaryTitle}`;
}
