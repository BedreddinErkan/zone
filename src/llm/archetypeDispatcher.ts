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
}

export interface ArchetypeFlags {
  dispatcherEnabled: boolean;   // ZONE_ARCHETYPE_DISPATCHER === '1'
  simpleAddEnabled: boolean;    // ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD === '1'
  targetedFixEnabled: boolean;  // ZONE_ARCHETYPE_ENABLE_TARGETED_FIX === '1'
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

export const TARGETED_FIX_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPhase1: true,
  skipPlan: true,
  skipPlanSSE: true,
  skipAudit: true,
  iterCap: 15,                 // SIMPLE_ADD = 5; high cap to avoid premature promotion on targeted_fix
  coachingBudget: 2,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: true,
});

export function readArchetypeFlagsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArchetypeFlags {
  return {
    dispatcherEnabled: env["ZONE_ARCHETYPE_DISPATCHER"] === "1",
    simpleAddEnabled: env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"] === "1",
    targetedFixEnabled: env["ZONE_ARCHETYPE_ENABLE_TARGETED_FIX"] === "1",
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
  if (archetype === "targeted_fix" && flags.targetedFixEnabled) {
    return { ...TARGETED_FIX_PIPELINE };
  }
  return null;
}
