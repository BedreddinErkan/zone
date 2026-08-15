import { describe, expect, it } from "vitest";
import {
  INVESTIGATION_PIPELINE,
  QUESTION_PIPELINE,
  REFACTOR_PIPELINE,
  SIMPLE_ADD_PIPELINE,
  TARGETED_FIX_PIPELINE,
  applyRequestedToolsGrant,
  buildDispatcherCapabilityFilter,
  buildPipelineConfig,
  deriveTaskRequestFromPlanMarks,
  readArchetypeFlagsFromEnv,
} from "./archetypeDispatcher.js";
import type { ExecutionPlan } from "./executionPlan.js";
import { resolveToolList } from "../tools/toolRegistry.js";
import { READ_ONLY_CAPABILITIES, type CapabilityFilter } from "../tools/capabilities.js";

const names = (filter: CapabilityFilter | undefined) =>
  new Set(resolveToolList(filter).map((t) => t.name));

describe("readArchetypeFlagsFromEnv", () => {
  it("returns defaults when env is empty (dispatcher/question/investigation/targetedFix/refactor ON, simpleAdd OFF)", () => {
    expect(readArchetypeFlagsFromEnv({})).toEqual({
      dispatcherEnabled: true,
      simpleAddEnabled: false,
      questionEnabled: true,
      investigationEnabled: true,
      targetedFixEnabled: true,
      refactorEnabled: true,
    });
  });

  it("returns dispatcherEnabled true when ZONE_ARCHETYPE_DISPATCHER=1", () => {
    expect(
      readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "1" }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: false, questionEnabled: true, investigationEnabled: true, targetedFixEnabled: true, refactorEnabled: true });
  });

  it("returns all-true when dispatcher and simpleAdd flags are '1'", () => {
    expect(
      readArchetypeFlagsFromEnv({
        ZONE_ARCHETYPE_DISPATCHER: "1",
        ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD: "1",
      }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: true, questionEnabled: true, investigationEnabled: true, targetedFixEnabled: true, refactorEnabled: true });
  });

  it("accepts any non-'0' value — only '0' disables the flag", () => {
    const flags = readArchetypeFlagsFromEnv({
      ZONE_ARCHETYPE_DISPATCHER: "true",
    });
    expect(flags.dispatcherEnabled).toBe(true);
  });

  it("returns dispatcherEnabled false when ZONE_ARCHETYPE_DISPATCHER=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "0" }).dispatcherEnabled).toBe(false);
  });

  it("returns questionEnabled false when ZONE_ARCHETYPE_ENABLE_QUESTION=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_ENABLE_QUESTION: "0" }).questionEnabled).toBe(false);
  });

  it("returns investigationEnabled false when ZONE_ARCHETYPE_ENABLE_INVESTIGATION=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_ENABLE_INVESTIGATION: "0" }).investigationEnabled).toBe(false);
  });
});

describe("buildPipelineConfig", () => {
  it("returns null when both flags false (master gate)", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: false,
        simpleAddEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null when master true but simple_add flag false", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: true,
        simpleAddEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns SIMPLE_ADD_PIPELINE shape when both flags true", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
    });
    expect(result).toEqual(SIMPLE_ADD_PIPELINE);
  });

  it("returns a fresh object reference, not the shared constant", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
    });
    expect(result).not.toBe(SIMPLE_ADD_PIPELINE);
  });

  it("returns null for targeted_fix when targetedFixEnabled is false", () => {
    expect(
      buildPipelineConfig("targeted_fix", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
        refactorEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null for complex_multi_file when both flags true", () => {
    expect(
      buildPipelineConfig("complex_multi_file", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
      }),
    ).toBeNull();
  });

  it("returns null for investigation when both flags true", () => {
    expect(
      buildPipelineConfig("investigation", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
      }),
    ).toBeNull();
  });
});

describe("CE.4.1.a: per-archetype iter caps", () => {
  const ALL_ON = {
    dispatcherEnabled: true,
    simpleAddEnabled: true,
    questionEnabled: true,
    investigationEnabled: true,
    targetedFixEnabled: true,
    refactorEnabled: true,
  };

  it("targeted_fix returns TARGETED_FIX_PIPELINE with iterCap:10", () => {
    const result = buildPipelineConfig("targeted_fix", ALL_ON);
    expect(result).toEqual(TARGETED_FIX_PIPELINE);
    expect(result?.iterCap).toBe(10);
  });

  it("refactor returns REFACTOR_PIPELINE with iterCap:12", () => {
    const result = buildPipelineConfig("refactor", ALL_ON);
    expect(result).toEqual(REFACTOR_PIPELINE);
    expect(result?.iterCap).toBe(12);
  });

  it("complex_multi_file returns null (implicit BASE_MAX_ITERATIONS=15)", () => {
    expect(buildPipelineConfig("complex_multi_file", ALL_ON)).toBeNull();
  });

  it("debug returns null (implicit BASE_MAX_ITERATIONS=15)", () => {
    expect(buildPipelineConfig("debug", ALL_ON)).toBeNull();
  });

  it("simple_add returns iterCap:5 (regression guard)", () => {
    expect(buildPipelineConfig("simple_add", ALL_ON)?.iterCap).toBe(5);
    expect(buildPipelineConfig("simple_add", ALL_ON)).toEqual(SIMPLE_ADD_PIPELINE);
  });

  it("question returns iterCap:3 (regression guard)", () => {
    expect(buildPipelineConfig("question", ALL_ON)?.iterCap).toBe(3);
    expect(buildPipelineConfig("question", ALL_ON)).toEqual(QUESTION_PIPELINE);
  });

  it("unknown archetype returns null (BASE_MAX_ITERATIONS fallback unchanged)", () => {
    // Cast to bypass TS narrowing — tests an unrecognised future archetype value
    expect(buildPipelineConfig("unknown_archetype" as "targeted_fix", ALL_ON)).toBeNull();
  });

  it("targeted_fix returns null when targetedFixEnabled:false (flag gate)", () => {
    expect(
      buildPipelineConfig("targeted_fix", { ...ALL_ON, targetedFixEnabled: false }),
    ).toBeNull();
  });
});

describe("CE.4.1.f: per-archetype coachingBudget tuning", () => {
  const ALL_ON = {
    dispatcherEnabled: true,
    simpleAddEnabled: true,
    questionEnabled: true,
    investigationEnabled: true,
    targetedFixEnabled: true,
    refactorEnabled: true,
  };

  it("TARGETED_FIX_PIPELINE.coachingBudget === 3", () => {
    expect(TARGETED_FIX_PIPELINE.coachingBudget).toBe(3);
  });

  it("REFACTOR_PIPELINE.coachingBudget === 4", () => {
    expect(REFACTOR_PIPELINE.coachingBudget).toBe(4);
  });

  it("SIMPLE_ADD_PIPELINE.coachingBudget === 2 (regression guard — unchanged)", () => {
    expect(SIMPLE_ADD_PIPELINE.coachingBudget).toBe(2);
  });

  it("QUESTION_PIPELINE.coachingBudget === 0 (regression guard — unchanged)", () => {
    expect(QUESTION_PIPELINE.coachingBudget).toBe(0);
  });

  it("buildPipelineConfig targeted_fix returns coachingBudget:3", () => {
    const result = buildPipelineConfig("targeted_fix", ALL_ON);
    expect(result?.coachingBudget).toBe(3);
  });

  it("buildPipelineConfig refactor returns coachingBudget:4", () => {
    const result = buildPipelineConfig("refactor", ALL_ON);
    expect(result?.coachingBudget).toBe(4);
  });
});

/**
 * `investigation` shared QUESTION_PIPELINE until a dogfood run showed the fit
 * was wrong where it counts: iterCap 3 is "one command, one summary", and
 * investigation is multi-step exploration. The run hit the cap at iteration 3
 * and only finished because the iter_cap promotion rescued it.
 */
describe("investigation has its own pipeline", () => {
  const ALL_ON = {
    dispatcherEnabled: true,
    simpleAddEnabled: true,
    questionEnabled: true,
    investigationEnabled: true,
    targetedFixEnabled: true,
    refactorEnabled: true,
  };

  it("no longer resolves to QUESTION_PIPELINE", () => {
    expect(buildPipelineConfig("investigation", ALL_ON)).toEqual(INVESTIGATION_PIPELINE);
    expect(buildPipelineConfig("investigation", ALL_ON)).not.toEqual(QUESTION_PIPELINE);
  });

  it("question is unchanged", () => {
    expect(buildPipelineConfig("question", ALL_ON)).toEqual(QUESTION_PIPELINE);
    expect(QUESTION_PIPELINE.iterCap).toBe(3);
    expect(QUESTION_PIPELINE.allowExploration).toBe(false);
  });

  it("its cap clears the only observed completion of an investigation task", () => {
    // The same trace task finished at iteration 10 when it was misclassified as
    // `refactor` and therefore had search tools. A cap at or below that would
    // bind and re-trigger the promotion this split exists to remove.
    const OBSERVED_EQUIPPED_ITERATIONS = 10;
    expect(INVESTIGATION_PIPELINE.iterCap).toBeGreaterThan(OBSERVED_EQUIPPED_ITERATIONS);
  });

  it("can explore, which is the difference from question", () => {
    expect(INVESTIGATION_PIPELINE.allowExploration).toBe(true);
    expect(INVESTIGATION_PIPELINE.readOnlyPipeline).toBe(true);
  });

  it("has a coaching budget, so one failed read does not exhaust it", () => {
    // QUESTION's 0 was observed promoting a question run at iteration 1 on
    // trigger `coaching_exhausted` — the first tool failure.
    expect(INVESTIGATION_PIPELINE.coachingBudget).toBeGreaterThan(0);
  });

  it("still writes nothing and dispatches nothing", () => {
    expect(INVESTIGATION_PIPELINE.allowSubagentDispatch).toBe(false);
    expect(INVESTIGATION_PIPELINE.allowScopeRevision).toBe(false);
  });

  it("respects ZONE_ARCHETYPE_ENABLE_INVESTIGATION=0", () => {
    expect(
      buildPipelineConfig("investigation", { ...ALL_ON, investigationEnabled: false }),
    ).toBeNull();
  });
});

// Item 166 stage one. The headline finding from this feature's own design pass:
// TARGETED_FIX/REFACTOR both set allowSubagentDispatch/allowScopeRevision true,
// so buildDispatcherCapabilityFilter returns undefined for them — nothing to
// grant. SIMPLE_ADD is the one archetype with a real, non-trivial, always
// non-empty excludeToolNames ({Task, suggest_scope_change}) to test a grant
// against — established by running buildDispatcherCapabilityFilter against all
// five PipelineConfig literals before this test was written, not assumed.
describe("applyRequestedToolsGrant — superset invariant (required, not optional)", () => {
  // Shape 1: hadAllowFilter=false — SIMPLE_ADD's own filter shape (excludeToolNames
  // only, no allow, no allowToolNames). The grant must NEVER introduce
  // allowToolNames here: doing so flips resolveToolList's hasAllowFilter from
  // false to true, and with no `allow` set, only tools named in allowToolNames
  // would resolve — collapsing the offered set instead of widening it. Proven by
  // a live experiment before this function was written (18 tools -> 1 when
  // allowToolNames was introduced unconditionally; 18 -> 19, +1, when the
  // introduction was gated on hadAllowFilter).
  it("shape 1 (no pre-existing allow/allowToolNames — SIMPLE_ADD): resolved list is a strict superset, +Task only", () => {
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE);
    expect(before?.allow).toBeUndefined();
    expect(before?.allowToolNames).toBeUndefined();
    const beforeNames = names(before);

    const result = applyRequestedToolsGrant(before, ["Task"], false);
    const afterNames = names(result.filter);

    for (const n of beforeNames) expect(afterNames.has(n)).toBe(true); // superset
    const added = [...afterNames].filter((n) => !beforeNames.has(n));
    expect(added).toEqual(["Task"]);
    expect(result.filter?.allowToolNames).toBeUndefined(); // never introduced here
    expect(result.grantedNames).toEqual(["Task"]);
  });

  // Shape 2: hadAllowFilter=true — QUESTION/INVESTIGATION_PIPELINE's shape
  // (allow: READ_ONLY_CAPABILITIES + excludeToolNames). Task declares only
  // "agent.spawn" (builtinCapabilities.ts), never satisfying READ_ONLY_CAPABILITIES
  // on its own — the allowToolNames escape hatch is genuinely required here, and
  // is safe because hasAllowFilter was already true before the grant touched
  // anything.
  it("shape 2 (pre-existing allow=READ_ONLY_CAPABILITIES — INVESTIGATION_PIPELINE via answer-only override): resolved list is a strict superset, +Task only", () => {
    const before = buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE);
    expect(before?.allow).toBe(READ_ONLY_CAPABILITIES);
    const beforeNames = names(before);
    expect(beforeNames.has("Task")).toBe(false);

    const result = applyRequestedToolsGrant(before, ["Task"], false);
    const afterNames = names(result.filter);

    for (const n of beforeNames) expect(afterNames.has(n)).toBe(true); // superset
    const added = [...afterNames].filter((n) => !beforeNames.has(n));
    expect(added).toEqual(["Task"]);
    expect(result.filter?.allowToolNames?.has("Task")).toBe(true);
    expect(result.grantedNames).toEqual(["Task"]);
  });

  // Matching mutation (#7): drop the hadAllowFilter conditional — always-write and
  // never-write both break one of the two shapes above. Verified here directly by
  // constructing both mutated variants inline, rather than asserted as a claim.
  it("mutation check: unconditionally writing allowToolNames breaks shape 1's superset property", () => {
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE);
    const beforeNames = names(before);
    // Simulates the "always write allowToolNames" mutation directly, bypassing
    // applyRequestedToolsGrant's hadAllowFilter guard.
    const mutatedFilter: CapabilityFilter = {
      excludeToolNames: new Set([...(before?.excludeToolNames ?? [])].filter((n) => n !== "Task")),
      allowToolNames: new Set(["Task"]),
    };
    const mutatedNames = names(mutatedFilter);
    const isSuperset = [...beforeNames].every((n) => mutatedNames.has(n));
    expect(isSuperset).toBe(false); // the bug this test exists to catch
  });

  it("mutation check: never writing allowToolNames breaks shape 2's grant (Task stays absent)", () => {
    const before = buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE);
    // Simulates the "never write allowToolNames" mutation: un-exclude only.
    const mutatedFilter: CapabilityFilter = {
      ...before,
      excludeToolNames: new Set([...(before?.excludeToolNames ?? [])].filter((n) => n !== "Task")),
    };
    const mutatedNames = names(mutatedFilter);
    expect(mutatedNames.has("Task")).toBe(false); // capability check still fails
  });
});

describe("applyRequestedToolsGrant — eligibility, cap, and the one-shot guard", () => {
  it("out-of-universe name is dropped with reason unknown_tool_name", () => {
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE);
    const result = applyRequestedToolsGrant(before, ["not_a_real_tool"], false);
    expect(result.grantedNames).toEqual([]);
    expect(result.dropped).toEqual([{ name: "not_a_real_tool", reason: "unknown_tool_name" }]);
  });

  it("a real tool name not excluded by the dispatcher is dropped as not_dispatcher_excluded", () => {
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE); // {Task, suggest_scope_change}
    const result = applyRequestedToolsGrant(before, ["run_command"], false);
    expect(result.grantedNames).toEqual([]);
    expect(result.dropped).toEqual([{ name: "run_command", reason: "not_dispatcher_excluded" }]);
  });

  it("undefined currentFilter (no dispatcher restriction — TARGETED_FIX/REFACTOR) makes every request a no-op", () => {
    const before = buildDispatcherCapabilityFilter(TARGETED_FIX_PIPELINE);
    expect(before).toBeUndefined();
    const result = applyRequestedToolsGrant(before, ["Task", "suggest_scope_change"], false);
    expect(result.filter).toBeUndefined();
    expect(result.grantedNames).toEqual([]);
    expect(result.dropped).toEqual([
      { name: "Task", reason: "not_dispatcher_excluded" },
      { name: "suggest_scope_change", reason: "not_dispatcher_excluded" },
    ]);
  });

  it("over-cap request: first 3 evaluated, the rest dropped as over_cap_truncated, plan-adjacent data intact", () => {
    const before: CapabilityFilter = { excludeToolNames: new Set(["Task", "suggest_scope_change", "list_files", "search_in_files"]) };
    const result = applyRequestedToolsGrant(before, ["Task", "suggest_scope_change", "list_files", "search_in_files"], false);
    expect(result.dropped).toContainEqual({ name: "search_in_files", reason: "over_cap_truncated" });
    expect(result.dropped.filter((d) => d.reason === "over_cap_truncated")).toHaveLength(1);
    expect(result.grantedNames).toEqual(["Task", "suggest_scope_change", "list_files"]);
  });

  it("second grant in one run is refused — direct unit test on the pure function", () => {
    // Defensive-only: applyRequestedToolsGrant runs once, straight-line, inside
    // runLlmPatchFlow.ts, which is never re-entered mid-flight — there is no live
    // path today that reaches a second grant through one real run. This proves
    // the function's own correctness under a hypothetical double-call, not that
    // the scenario is reachable in production.
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE);
    const result = applyRequestedToolsGrant(before, ["Task"], true);
    expect(result.filter).toBe(before); // same reference, untouched
    expect(result.grantedNames).toEqual([]);
    expect(result.dropped).toEqual([{ name: "Task", reason: "already_granted_this_run" }]);
  });

  it("absent/empty requestedTools upstream never reaches this function — byte-identity is the caller's job (runLlmPatchFlow.ts), covered there", () => {
    // Documented here so the split of responsibility is explicit: this function
    // assumes requestedTools is non-empty by the time it's called; the guard
    // that skips calling it entirely lives in runLlmPatchFlow.ts.
    const before = buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE);
    const result = applyRequestedToolsGrant(before, [], false);
    expect(result.filter).toBe(before);
    expect(result.grantedNames).toEqual([]);
  });
});

function step(
  filesLikely: string[],
  mark?: { subagentEligible: boolean; subagentType?: "worker" | "explore" }
): ExecutionPlan["steps"][number] {
  return {
    title: "step",
    description: "d",
    filesLikely,
    ...(mark
      ? { subagentEligible: mark.subagentEligible, ...(mark.subagentType ? { subagentType: mark.subagentType } : {}) }
      : {}),
  };
}

describe("deriveTaskRequestFromPlanMarks — criterion conformance, not mark density (item 166 stage two)", () => {
  it("no steps marked at all -> refused, reason no_steps_marked", () => {
    const steps = [step(["a.ts"]), step(["b.ts"])];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: false, reason: "no_steps_marked" });
  });

  it("undefined steps -> refused, reason no_steps_marked (defensive — the call site passes executionPlan?.steps)", () => {
    expect(deriveTaskRequestFromPlanMarks(undefined)).toEqual({ taskRequested: false, reason: "no_steps_marked" });
  });

  it("marked worker step under 3 files does not qualify -> refused, reason no_qualifying_marks", () => {
    const steps = [
      step(["a.ts"], { subagentEligible: true, subagentType: "worker" }),
      step(["b.ts"], { subagentEligible: true, subagentType: "worker" }),
      step(["c.ts"]),
    ];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: false, reason: "no_qualifying_marks" });
  });

  it("E3-mirroring shape: 2 single-file worker marks + 1 four-file worker mark -> qualifies via the 4-file step", () => {
    const steps = [
      step(["a.ts"], { subagentEligible: true, subagentType: "worker" }),
      step(["b.ts"], { subagentEligible: true, subagentType: "worker" }),
      step(["c.ts", "d.ts", "e.ts", "f.ts"], { subagentEligible: true, subagentType: "worker" }),
    ];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: true });
  });

  it("marked explore step qualifies regardless of file count — the ported criteria set no file-count condition for explore", () => {
    const steps = [
      step(["src/**/*.ts"], { subagentEligible: true, subagentType: "explore" }),
      step(["b.ts"]),
    ];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: true });
  });

  it("every step marked but only one qualifies -> granted (the rejected proportion rule would have refused this as all_steps_marked)", () => {
    const steps = [
      step(["a.ts"], { subagentEligible: true, subagentType: "worker" }),
      step(["b.ts", "c.ts", "d.ts"], { subagentEligible: true, subagentType: "worker" }),
    ];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: true });
  });

  it("single-step plan with a qualifying mark grants — the proportion rule's blind spot (marked===total never < total) is gone by construction", () => {
    const steps = [step(["a.ts", "b.ts", "c.ts", "d.ts"], { subagentEligible: true, subagentType: "worker" })];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: true });
  });

  it("subagentEligible:true with no subagentType is excluded from consideration entirely — matches normalizeExecutionPlanSteps' own drop rule", () => {
    const malformed = { title: "t", description: "d", filesLikely: ["a.ts", "b.ts", "c.ts"], subagentEligible: true } as ExecutionPlan["steps"][number];
    const steps = [malformed, step(["b.ts"])];
    expect(deriveTaskRequestFromPlanMarks(steps)).toEqual({ taskRequested: false, reason: "no_steps_marked" });
  });
});
