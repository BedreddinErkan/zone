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
  dispatcherEnabled: boolean;    // ZONE_ARCHETYPE_DISPATCHER === '1'
  simpleAddEnabled: boolean;     // ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD === '1'
  questionEnabled: boolean;      // ZONE_ARCHETYPE_ENABLE_QUESTION === '1'
  investigationEnabled: boolean; // ZONE_ARCHETYPE_ENABLE_INVESTIGATION === '1'
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

export function readArchetypeFlagsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArchetypeFlags {
  return {
    dispatcherEnabled: env["ZONE_ARCHETYPE_DISPATCHER"] === "1",
    simpleAddEnabled: env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"] === "1",
    questionEnabled: env["ZONE_ARCHETYPE_ENABLE_QUESTION"] === "1",
    investigationEnabled: env["ZONE_ARCHETYPE_ENABLE_INVESTIGATION"] === "1",
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
  return null;
}
