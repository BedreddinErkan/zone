import type { TaskArchetype } from "./taskClassifier.js";
import { READ_ONLY_CAPABILITIES, type CapabilityFilter } from "../tools/capabilities.js";

export interface PipelineConfig {
  skipPlan: boolean;
  skipPlanSSE: boolean;
  iterCap: number;
  coachingBudget: number;
  allowSubagentDispatch: boolean;
  allowScopeRevision: boolean;
  preserveSyntaxChecker: boolean;
  preserveReadBeforePatch: boolean;
  skipCrossFileHeuristic: boolean;
  readOnlyPipeline?: boolean;
  /**
   * Whether a read-only pipeline may search and navigate the tree.
   *
   * Only consulted when `readOnlyPipeline` is set. This names a decision that
   * used to be implicit in three tool names on a denylist: QUESTION deliberately
   * denies `list_files`/`search_in_files`/`find_references`, because at iterCap 3
   * the shape is one command and one summary, not exploration. That was coherent
   * for QUESTION and became wrong the moment `investigation` — multi-step
   * exploration by definition — inherited the same pipeline.
   */
  allowExploration?: boolean;
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
  skipPlan: true,
  skipPlanSSE: true,
  iterCap: 5,
  coachingBudget: 2,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: true,
});

export const QUESTION_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPlan: true,
  skipPlanSSE: true,
  iterCap: 3,
  coachingBudget: 0,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: false,
  preserveReadBeforePatch: false,
  skipCrossFileHeuristic: true,
  readOnlyPipeline: true,
  // One command, one summary — see PipelineConfig.allowExploration.
  allowExploration: false,
});

/**
 * `investigation` used to share QUESTION_PIPELINE, and the fit was wrong in the
 * one dimension that matters: iterCap 3 with no coaching is "one command, one
 * summary", while investigation is multi-step exploration by definition. A
 * dogfood trace task hit the cap at iteration 3 and was rescued by the iter_cap
 * promotion — the promotion machinery compensating for a pipeline that was never
 * right for the archetype.
 *
 * iterCap 12, from two runs of the same trace task:
 *   - misclassified as `refactor` (REFACTOR cap 12, search tools present):
 *     finished at iteration 10 for $0.2498. With the tools investigation needs,
 *     10 is what this task costs.
 *   - correctly classified (QUESTION cap 3, search tools absent): 14 iterations
 *     for $0.5138, of which seven were blind lineRange reads standing in for one
 *     search call.
 * So the cap must not bind at ~10. 12 is REFACTOR's existing value — chosen to
 * avoid minting a new constant, not tuned. n=2, and neither run observed the
 * configuration this ships: run A had the tools with the wrong pipeline, run B
 * the pipeline without the tools.
 *
 * coachingBudget 2 is a judgement rather than a measurement (SIMPLE_ADD's
 * value). QUESTION's 0 means the first tool failure exhausts coaching
 * immediately — observed promoting a question run at iteration 1 — and
 * `read_file_nonexistent` is a read-only-relevant trigger.
 */
export const INVESTIGATION_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPlan: true,
  skipPlanSSE: true,
  iterCap: 12,
  coachingBudget: 2,
  allowSubagentDispatch: false,
  allowScopeRevision: false,
  preserveSyntaxChecker: false,
  preserveReadBeforePatch: false,
  skipCrossFileHeuristic: true,
  readOnlyPipeline: true,
  // The difference that motivated splitting from QUESTION.
  allowExploration: true,
});

// CE.4.1.a: per-archetype iter caps — targeted_fix (10) and refactor (12)
// CE.4.1.f: per-archetype coachingBudget — targeted_fix:3, refactor:4 (complex_multi_file/debug→5 via null fallback)
// Lower budget fires coaching_exhausted soft promotion earlier; L5.1b-2 absorbs via relaxation.
export const TARGETED_FIX_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPlan: false,
  skipPlanSSE: false,
  iterCap: 10,
  coachingBudget: 3,
  allowSubagentDispatch: true,
  allowScopeRevision: true,
  preserveSyntaxChecker: true,
  preserveReadBeforePatch: true,
  skipCrossFileHeuristic: false,
});

export const REFACTOR_PIPELINE: Readonly<PipelineConfig> = Object.freeze({
  skipPlan: false,
  skipPlanSSE: false,
  iterCap: 12,
  coachingBudget: 4,
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

/**
 * Which tools a pipeline exposes. Pure; the single implementation, called by
 * `runLlmPatchFlow` and asserted on directly by its tests — a test that mirrors
 * this logic instead of calling it would pass while production regressed.
 *
 * Read-only pipelines are expressed as a capability **allow**-set. The
 * predecessor was a name denylist and it granted whatever it forgot, which is
 * how `multi_edit`, `run_command` and `run_command_background` — three ways to
 * write — reached runs whose whole point was not writing. `excludeToolNames`
 * survives only to trim tools that are incoherent to offer; it is not what makes
 * the pipeline safe.
 */
export function buildDispatcherCapabilityFilter(
  cfg: PipelineConfig | null,
): CapabilityFilter | undefined {
  if (!cfg) return undefined;
  const excludeToolNames = new Set<string>();
  if (!cfg.allowSubagentDispatch) excludeToolNames.add("Task");
  if (!cfg.allowScopeRevision) excludeToolNames.add("suggest_scope_change");

  if (!cfg.readOnlyPipeline) {
    return excludeToolNames.size > 0 ? { excludeToolNames } : undefined;
  }

  // Reachable by capability (shell.exec) but inert: `run_command_background`
  // declares fs.write and is denied, so nothing can start a process for these to
  // manage. A model offered `list_background` may well try it.
  for (const t of ["kill_background", "list_background", "read_background_output"]) {
    excludeToolNames.add(t);
  }
  if (!cfg.allowExploration) {
    for (const t of ["list_files", "search_in_files", "find_references"]) excludeToolNames.add(t);
  }
  return { allow: READ_ONLY_CAPABILITIES, excludeToolNames };
}

export function buildPipelineConfig(
  archetype: TaskArchetype,
  flags: ArchetypeFlags,
): PipelineConfig | null {
  if (!flags.dispatcherEnabled) return null;
  if (archetype === "simple_add" && flags.simpleAddEnabled) {
    return { ...SIMPLE_ADD_PIPELINE };
  }
  if (archetype === "question" && flags.questionEnabled) {
    return { ...QUESTION_PIPELINE };
  }
  if (archetype === "investigation" && flags.investigationEnabled) {
    return { ...INVESTIGATION_PIPELINE };
  }
  if (archetype === "targeted_fix" && flags.targetedFixEnabled) {
    return { ...TARGETED_FIX_PIPELINE };
  }
  if (archetype === "refactor" && flags.refactorEnabled) {
    return { ...REFACTOR_PIPELINE };
  }
  return null;
}
