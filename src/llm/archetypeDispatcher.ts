import type { TaskArchetype } from "./taskClassifier.js";

export interface PipelineConfig {
  skipPhase1: boolean;
  skipPlan: boolean;
  skipPlanSSE: boolean;
  skipAudit: boolean;
  iterCap: number;
  coachingBudget: number;
  allowSubagentDispatch: boolean;
  allowScopeRevision: boolean;
  preserveSyntaxChecker: boolean;
  preserveReadBeforePatch: boolean;
  skipCrossFileHeuristic: boolean;
  readOnlyPipeline?: boolean;
}

export interface ArchetypeFlags {
  dispatcherEnabled: boolean;    // ZONE_ARCHETYPE_DISPATCHER !== '0' (default ON — TUI.5.7)
  simpleAddEnabled: boolean;     // ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD === '1' (opt-in)
  questionEnabled: boolean;      // ZONE_ARCHETYPE_ENABLE_QUESTION !== '0' (default ON — TUI.5.7)
  investigationEnabled: boolean; // ZONE_ARCHETYPE_ENABLE_INVESTIGATION !== '0' (default ON — TUI.5.7)
  targetedFixEnabled: boolean;   // ZONE_ARCHETYPE_ENABLE_TARGETED_FIX !== '0' (default ON — CE.4.1.a)
  refactorEnabled: boolean;      // ZONE_ARCHETYPE_ENABLE_REFACTOR !== '0' (default ON — CE.4.1.a)
}

export const SIMPLE_ADD_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPhase1: true,
  skipPlan: true,
  skipPlanSSE: true,
  skipAudit: true,
  iterCap: 5,
  coachingBudget: 2,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: true,
});

export const QUESTION_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPhase1: true,
  skipPlan: true,
  skipPlanSSE: true,
  skipAudit: true,
  iterCap: 3,
  coachingBudget: 0,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: false,
  preserveReadBeforePatch: false,
  skipCrossFileHeuristic: true,
  readOnlyPipeline: true,
});

// CE.4.1.a: per-archetype iter caps — targeted_fix (10) and refactor (12)
// coachingBudget:5 = MAX_SELF_CORRECTION_ATTEMPTS; per-archetype coaching deferred to CE.4.1.f
// Soft promotion (L5.1b-2) provides escalation via coaching_exhausted/iter_cap/rollback_x2 triggers
export const TARGETED_FIX_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPhase1: false,
  skipPlan: false,
  skipPlanSSE: false,
  skipAudit: false,
  iterCap: 10,
  coachingBudget: 5,
  allowSubagentDispatch: true,
  allowScopeRevision: true,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: false,
});

export const REFACTOR_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPhase1: false,
  skipPlan: false,
  skipPlanSSE: false,
  skipAudit: false,
  iterCap: 12,
  coachingBudget: 5,
  allowSubagentDispatch: true,
  allowScopeRevision: true,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: false,
});

export function readArchetypeFlagsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArchetypeFlags {
  return {
    dispatcherEnabled: env["ZONE_ARCHETYPE_DISPATCHER"] !== "0",
    simpleAddEnabled: env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"] === "1",
    questionEnabled: env["ZONE_ARCHETYPE_ENABLE_QUESTION"] !== "0",
    investigationEnabled: env["ZONE_ARCHETYPE_ENABLE_INVESTIGATION"] !== "0",
    targetedFixEnabled: env["ZONE_ARCHETYPE_ENABLE_TARGETED_FIX"] !== "0",
    refactorEnabled: env["ZONE_ARCHETYPE_ENABLE_REFACTOR"] !== "0",
  };
}

export function buildPipelineConfig(
  archetype: TaskArchetype,
  flags: ArchetypeFlags,
): PipelineConfig | null {
  if (!flags.dispatcherEnabled) return null;
  if (archetype === "simple_add" && flags.simpleAddEnabled) {
    return { ...SIMPLE_ADD_PIPELINE };
  }
  if (
    (archetype === "question" && flags.questionEnabled) ||
    (archetype === "investigation" && flags.investigationEnabled)
  ) {
    return { ...QUESTION_PIPELINE };
  }
  if (archetype === "targeted_fix" && flags.targetedFixEnabled) {
    return { ...TARGETED_FIX_PIPELINE };
  }
  if (archetype === "refactor" && flags.refactorEnabled) {
    return { ...REFACTOR_PIPELINE };
  }
  return null;
}
