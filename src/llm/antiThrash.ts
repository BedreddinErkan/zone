import type { FailureRecord } from "./agentLoop.js";

export type AntiThrashSignalKind = "failure_stall"; // P5="wandering", P6="cost_burn" added in inc-2/3

export interface AntiThrashSignal {
  pattern: AntiThrashSignalKind;
  summaryTitle: string;
  detail: Record<string, unknown>;
}

export interface AntiThrashContext {
  iter: number;
  failureHistory: Map<string, FailureRecord[]>;
  coachingAttempts: number;
  filesReadCountThisRun: Map<string, number>;
  filesModifiedSize: number;
  isReadOnly: boolean;
  archetype: string | null | undefined;
  costUsd: number;
}

export interface AntiThrashThresholds {
  failureCoachMin?: number;
  breakIters?: number;
  enabled?: boolean;
}

function readEnvInt(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
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

// Priority-ordered dispatch. P5 and P6 are additive return lines — zero wiring change.
export function computeAntiThrashSignal(
  ctx: AntiThrashContext,
  thresholds?: AntiThrashThresholds,
): AntiThrashSignal | null {
  if (!(thresholds?.enabled ?? ANTI_THRASH_ENABLED)) return null;
  return detectFailureStall(ctx, thresholds);
  // inc-2: return detectFailureStall(ctx, thresholds) ?? detectWanderingSignal(ctx, thresholds);
  // inc-3: ?? detectCostBurnSignal(ctx, thresholds)
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
  return `\n\n[ZONE_ANTI_THRASH] Non-progress detected: ${signal.summaryTitle}`;
}
