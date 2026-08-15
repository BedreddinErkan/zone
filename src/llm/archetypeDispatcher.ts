import type { TaskArchetype } from "./taskClassifier.js";
import { READ_ONLY_CAPABILITIES, type CapabilityFilter } from "../tools/capabilities.js";
import { resolveToolList } from "../tools/toolRegistry.js";
import type { ExecutionPlan } from "./executionPlan.js";

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

/** Item 166 stage one. Cap on a single grant request — enforced HERE, never as a
 *  schema `.max()` on ExecutionPlan.requestedTools (D2): Zod validates an object
 *  atomically, so a schema-level cap would let one extra name throw away the
 *  entire plan, not just the field that overreached. */
const REQUESTED_TOOLS_CAP = 3;

export interface RequestedToolsGrantResult {
  filter: CapabilityFilter | undefined;
  grantedNames: string[];
  dropped: { name: string; reason: string }[];
}

/**
 * Widens `currentFilter` to include specific plan-requested tool names, bounded
 * to what the dispatcher pipeline itself excluded by name — never the broader
 * "not currently offered" (which would include tools excluded purely by
 * capability class, e.g. `write_file` under a read-only-capability filter, and
 * would require the `allowToolNames` escape hatch to reach names the pipeline
 * never named at all). Pure; runId/telemetry is the caller's job.
 *
 * The `allowToolNames` escape hatch is used, but ONLY when `currentFilter`
 * already had an active allow-filter (`allow` or non-empty `allowToolNames`)
 * before this function touched anything. Introducing `allowToolNames` where
 * NEITHER existed flips `resolveToolList`'s internal `hasAllowFilter` from
 * false to true, and with no `allow` capability set, only tools named in
 * `allowToolNames` would resolve — collapsing the offered set instead of
 * widening it. Reproduced directly against `resolveToolList` before this
 * function was written: an 18-tool exclude-only filter collapsed to 1 tool
 * when `allowToolNames` was introduced unconditionally, and stayed a clean
 * 18→19-tool superset when the introduction was gated on this same
 * `hadAllowFilter` check. See the superset-invariant tests in
 * archetypeDispatcher.test.ts, which assert on `resolveToolList` output, not
 * on this function's returned filter object.
 */
export function applyRequestedToolsGrant(
  currentFilter: CapabilityFilter | undefined,
  requestedTools: string[],
  alreadyGranted: boolean,
): RequestedToolsGrantResult {
  if (alreadyGranted) {
    return {
      filter: currentFilter,
      grantedNames: [],
      dropped: requestedTools.map((name) => ({ name, reason: "already_granted_this_run" })),
    };
  }

  const capped = requestedTools.slice(0, REQUESTED_TOOLS_CAP);
  const dropped: { name: string; reason: string }[] = requestedTools
    .slice(REQUESTED_TOOLS_CAP)
    .map((name) => ({ name, reason: "over_cap_truncated" }));

  const universe = new Set(resolveToolList(undefined).map((t) => t.name));
  const preGrantExclude = currentFilter?.excludeToolNames ?? new Set<string>();

  const eligible: string[] = [];
  for (const name of capped) {
    if (!universe.has(name)) {
      dropped.push({ name, reason: "unknown_tool_name" });
      continue;
    }
    if (!preGrantExclude.has(name)) {
      // Covers both "already offered" and "excluded by capability class, not by
      // name" — undefined currentFilter (nothing dispatcher-excluded at all)
      // falls here for every requested name, making the grant a no-op by
      // construction rather than a special-cased branch.
      dropped.push({ name, reason: "not_dispatcher_excluded" });
      continue;
    }
    eligible.push(name);
  }

  if (eligible.length === 0) {
    return { filter: currentFilter, grantedNames: [], dropped };
  }

  const newExcludeToolNames = new Set([...preGrantExclude].filter((n) => !eligible.includes(n)));
  const hadAllowFilter =
    currentFilter?.allow !== undefined || (currentFilter?.allowToolNames?.size ?? 0) > 0;
  const newFilter: CapabilityFilter = {
    ...currentFilter,
    excludeToolNames: newExcludeToolNames,
    ...(hadAllowFilter
      ? { allowToolNames: new Set([...(currentFilter?.allowToolNames ?? []), ...eligible]) }
      : {}),
  };

  return { filter: newFilter, grantedNames: eligible, dropped };
}

/**
 * Item 166 stage two. Derives an implicit Task request from a plan's own
 * per-step delegation marks, so a plan that follows the (now-ported)
 * subagent-eligibility criteria doesn't need a SEPARATE explicit
 * `requestedTools: ["Task"]` entry to have that intent honoured — it can
 * simply mark the step, the way `generateExecutionPlan`'s prompt already
 * asked for.
 *
 * The rule is criterion CONFORMANCE, not mark density. An earlier design
 * ("grant when 0 < marked < total") was rejected on review: it reads the
 * *proportion* of marked steps, not their *content*, so a plan that marks
 * every step correctly (a real all-fanout plan) is refused identically to
 * one that marks reflexively — and it can never grant on a single-step
 * plan, however well-founded that one mark is. This version re-checks each
 * marked step against the same criterion the ported prompt text now states
 * (worker needs >=3 files; explore has no file-count condition) and grants
 * when at least one mark holds up factually, regardless of how many other
 * steps exist or whether they're also marked.
 *
 * Scored against every on-disk plan recoverable at implementation time (8
 * distinct, `.zone/item166/subagent-marks-preport-baseline.json`): this
 * rule grants on 4/8, the rejected proportion rule on 1/8. The three plans
 * where they diverge are "reflexively" all-marked by the proportion
 * reading, but each contains at least one step whose mark is factually
 * correct (a multi-file verification step, or a genuine `explore` step)
 * alongside others that aren't — so on this data, conformance does NOT
 * cleanly separate reflexive from selective marking; it separates "at
 * least one mark holds up" from "none do." Four non-empty plans, one of
 * them partial, is a hypothesis-sized sample, not a settled finding — what
 * would settle it is the post-port distribution, measured after this
 * lands, joined against the same baseline file on plan/step identity.
 */
export interface PlanMarksSignal {
  taskRequested: boolean;
  reason?: "no_steps_marked" | "no_qualifying_marks";
}

export function deriveTaskRequestFromPlanMarks(
  steps: ExecutionPlan["steps"] | undefined
): PlanMarksSignal {
  const marked = (steps ?? []).filter((s) => s.subagentEligible === true && !!s.subagentType);
  if (marked.length === 0) {
    return { taskRequested: false, reason: "no_steps_marked" };
  }
  const qualifies = (s: (typeof marked)[number]): boolean =>
    (s.subagentType === "worker" && s.filesLikely.length >= 3) || s.subagentType === "explore";
  if (!marked.some(qualifies)) {
    return { taskRequested: false, reason: "no_qualifying_marks" };
  }
  return { taskRequested: true };
}
